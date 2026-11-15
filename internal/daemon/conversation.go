package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/conversation"
	"github.com/MarioJames/convorel/internal/rpc"
	"github.com/MarioJames/convorel/internal/store"
)

var ConversationCommands = []string{"ask", "followup", "wait", "status", "result", "history", "retry", "finish", "list", "search", "diagnostics"}

// RegisterConversationEngine also supports in-process fixture integrations.
func RegisterConversationEngine(s *Server, e *conversation.Engine) {
	for _, name := range ConversationCommands {
		s.Register(name, conversationHandler(e))
	}
}
func conversationHandler(e *conversation.Engine) Handler {
	return func(ctx context.Context, r rpc.Request) (any, error) {
		var p map[string]string
		if err := json.Unmarshal(r.Params, &p); err != nil {
			return nil, rpc.NewError("INVALID_ARGUMENT", err.Error())
		}
		if r.Command == "wait" {
			duration := 60 * time.Second
			if value := p["timeout-seconds"]; value != "" {
				seconds, err := strconv.Atoi(value)
				if err != nil || seconds < 1 || seconds > 86400 {
					return nil, rpc.NewError("INVALID_TIMEOUT", "timeout must be 1..86400 seconds")
				}
				duration = time.Duration(seconds) * time.Second
			}
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, duration)
			defer cancel()
		}
		v, err := e.Execute(ctx, r.Command, p)
		if err != nil {
			return nil, err
		}
		encoded, marshalErr := json.Marshal(v)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if len(encoded) > rpc.MaxFrameBytes-4096 {
			return nil, rpc.NewError("RESULT_TOO_LARGE", "use result --run for individual runs, or reduce search/list --limit")
		}
		code := 0
		if m, ok := v.(map[string]any); ok && r.Command != "status" && r.Command != "history" && r.Command != "finish" {
			if phase, ok := m["phase"].(store.Phase); ok {
				switch phase {
				case store.Complete:
				case store.Delivered:
					if r.Command != "ask" && r.Command != "followup" && r.Command != "retry" {
						code = 2
					}
				case store.Prepared, store.Rejected, store.DeliveryUnknown:
					code = 2
				default:
					code = 1
				}
			}
		}
		return Result{Value: v, ExitCode: code}, nil
	}
}

// RegisterConversations opens only the selected paths. Browser startup remains
// lazy; the returned cleanup waits for observers before closing SQLite.
func RegisterConversations(ctx context.Context, s *Server, p config.Paths, login ...func(context.Context, cdp.Browser) (any, error)) (func(), error) {
	st, err := store.Open(p.StateDir)
	if err != nil {
		return nil, err
	}
	ar, _ := archive.Open(p.StateDir) // projection availability never changes run outcomes
	var mu sync.Mutex
	var engine *conversation.Engine
	var browser *cdp.Manager
	init := func() (*conversation.Engine, error) {
		mu.Lock()
		defer mu.Unlock()
		if engine != nil {
			return engine, nil
		}
		c, err := config.Load(p)
		if err != nil {
			return nil, err
		}
		prefs, err := config.ReadPreferences(p)
		if err != nil {
			return nil, err
		}
		profile, _, err := config.ResolveBrowserProfile(p, c, prefs)
		if err != nil {
			return nil, err
		}
		opts := cdp.Options{Endpoint: c.CDP, Mode: "external", IdleStopTimeout: time.Duration(prefs.IdleStopMinutes()) * time.Minute}
		if c.Browser != nil {
			opts.Mode = c.Browser.Mode
			if opts.Mode == "" {
				opts.Mode = "managed"
			}
			opts.Executable = c.Browser.Executable
			if c.Browser.CDP != "" {
				opts.Endpoint = c.Browser.CDP
			}
		}
		// In 0.9 this preference selected the agent-browser controller.
		// Keep that stored preference, but use the saved Chrome executable.
		if prefs.Values["browser.executable"] != "" && filepath.Base(prefs.Values["browser.executable"]) != "agent-browser" {
			opts.Executable = prefs.Values["browser.executable"]
		}
		opts.UserDataDir = profile
		opts.Headless = prefs.Values["browser.headless"] == "true"
		for key, target := range map[string]*time.Duration{"browser.actionIntervalMs": &opts.ActionInterval, "browser.navigationWaitMs": &opts.NavigationWait} {
			if value := prefs.Values[key]; value != "" {
				n, _ := strconv.Atoi(value)
				*target = time.Duration(n) * time.Millisecond
				if n == 0 {
					*target = -1
				}
			}
		}
		browser, err = cdp.New(opts)
		if err != nil {
			return nil, err
		}
		st.SetDiagnosticsEnabled(prefs.Values["diagnostics.enabled"] != "false")
		engine, err = conversation.New(ctx, conversation.Options{Store: st, Archive: ar, Browser: browser, Config: func(context.Context) (config.Config, error) {
			c, err := config.Load(p)
			if err != nil {
				return c, err
			}
			prefs, err := config.ReadPreferences(p)
			if err != nil {
				return c, err
			}
			return config.Snapshot(c, prefs)
		}})
		return engine, err
	}
	if len(login) > 0 && login[0] != nil {
		s.Register("login", func(callCtx context.Context, _ rpc.Request) (any, error) {
			if _, err := init(); err != nil {
				return nil, err
			}
			release := browser.IdlePolicy().Begin()
			defer release()
			return login[0](callCtx, browser)
		})
	}
	s.Register("doctor", func(callCtx context.Context, r rpc.Request) (any, error) {
		var params map[string]string
		if err := json.Unmarshal(r.Params, &params); err != nil {
			return nil, rpc.NewError("INVALID_ARGUMENT", err.Error())
		}
		if _, err := init(); err != nil {
			return nil, err
		}
		release := browser.IdlePolicy().Begin()
		defer release()
		if err := browser.EnsureStarted(callCtx); err != nil {
			return nil, err
		}
		result := map[string]any{"ok": true, "checks": map[string]any{"browser": true}, "tools": []string{"capabilities", "exec", "artifact", "memory"}}
		if params["ui"] == "true" {
			targets, err := browser.Targets(callCtx)
			if err != nil {
				return nil, err
			}
			var candidates []cdp.Target
			for _, target := range targets {
				if target.Type == "page" && (target.URL == "https://chatgpt.com/" || strings.HasPrefix(target.URL, "https://chatgpt.com/")) {
					candidates = append(candidates, target)
				}
			}
			if len(candidates) != 1 {
				return nil, rpc.NewError("UI_TARGET_AMBIGUOUS", "open exactly one ChatGPT page for the UI check")
			}
			tab, err := browser.AttachTab(callCtx, candidates[0].ID)
			if err != nil {
				return nil, err
			}
			report, err := chatgpt.DoctorUI(callCtx, tab)
			if err != nil {
				return nil, err
			}
			result["ui"] = report
			result["ok"] = report.OK
			if !report.OK {
				return Result{Value: result, ExitCode: 1}, nil
			}
		}
		return result, nil
	})
	// Reattach delivered runs at daemon startup, not on the first wait client.
	if _, err = config.Load(p); err == nil {
		if _, err = init(); err != nil {
			st.Close()
			if ar != nil {
				ar.Close()
			}
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		st.Close()
		if ar != nil {
			ar.Close()
		}
		return nil, err
	}
	for _, name := range ConversationCommands {
		s.Register(name, func(ctx context.Context, r rpc.Request) (any, error) {
			e, err := init()
			if err != nil {
				return nil, err
			}
			return conversationHandler(e)(ctx, r)
		})
	}
	return func() {
		mu.Lock()
		defer mu.Unlock()
		if engine != nil {
			engine.Close()
		}
		if browser != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = browser.Stop(stopCtx)
			cancel()
		}
		if ar != nil {
			_ = ar.Close()
		}
		_ = st.Close()
	}, nil
}
