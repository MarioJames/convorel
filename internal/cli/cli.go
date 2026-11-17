package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/mcp"
	"github.com/MarioJames/convorel/internal/rpc"
	"github.com/MarioJames/convorel/internal/service"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	ExitOK      = 0
	ExitError   = 1
	ExitPending = 2
)

// ExitForPhase never consults naming; successful replies always exit zero.
func ExitForPhase(phase string) int {
	switch phase {
	case "prepared", "rejected", "delivered", "delivery_unknown", "waiting":
		return ExitPending
	case "failed", "blocked", "superseded", "lost":
		return ExitError
	default:
		return ExitOK
	}
}
func Print(w io.Writer, value any) error { return json.NewEncoder(w).Encode(value) }
func errorResult(e error) (any, int) {
	r := rpc.ErrorResponse(e)
	if r.Error.Code == "INTERNAL_ERROR" {
		prefix, _, ok := strings.Cut(e.Error(), ":")
		if ok && prefix != "" && strings.ToUpper(prefix) == prefix {
			r.Error.Code = prefix
		}
	}
	return map[string]any{"error": r.Error, "code": r.Error.Code}, r.ExitCode
}

// Run can be embedded in tests; all JSON output is written exactly once.
func Run(ctx context.Context, args []string, in io.Reader, out io.Writer) int {
	v, e := Parse(args)
	if e != nil {
		r, c := errorResult(e)
		_ = Print(out, r)
		return c
	}
	if v.Help {
		_ = Print(out, Help(v.Command))
		return 0
	}
	if v.Command == "doctor" && v.Params["local"] == "true" {
		result, err := DoctorLocal(v.Paths)
		if err != nil {
			r, code := errorResult(err)
			_ = Print(out, r)
			return code
		}
		_ = Print(out, result)
		return 0
	}
	if result, handled, err := service.Local(ctx, v.Paths, v.Command, v.Params); handled {
		if err != nil {
			r, code := errorResult(err)
			_ = Print(out, r)
			return code
		}
		_ = Print(out, result)
		return 0
	}
	if v.Command == "daemon" {
		s := daemon.New()
		RegisterConfig(s, v.Paths)
		service.Register(s, v.Paths)
		e = s.Listen(v.Paths.StateDir)
		if e == nil {
			defer s.Close()
			var cleanup func()
			cleanup, e = daemon.RegisterConversations(ctx, s, v.Paths, func(loginCtx context.Context, browser cdp.Browser) (any, error) {
				return service.Login(loginCtx, v.Paths, browser)
			})
			if e == nil {
				defer cleanup()
			}
		}
		if e == nil {
			defer service.StartBackground(ctx, v.Paths)()
			e = s.Serve(ctx)
		}
		if e != nil {
			r, c := errorResult(e)
			_ = Print(out, r)
			return c
		}
		_ = Print(out, map[string]any{"stopped": true})
		return 0
	}
	if v.Command == "version" {
		_ = Print(out, map[string]any{"version": service.Version})
		return 0
	}
	// mcp serve is spawned by tunnel-client: stdout is reserved for the MCP
	// protocol, so it bypasses the daemon socket and JSON result contract.
	if v.Command == "mcp serve" {
		if e := mcp.Serve(ctx, v.Paths, v.Params["roots"]); e != nil {
			fmt.Fprintln(os.Stderr, e.Error())
			return ExitError
		}
		return ExitOK
	}
	if v.Params["prompt-stdin"] == "true" || v.Params["prompt-file"] != "" {
		var reader io.Reader = in
		var f *os.File
		if path := v.Params["prompt-file"]; path != "" {
			f, e = os.Open(path)
			if e == nil {
				defer f.Close()
				reader = f
			}
		}
		if e == nil {
			var b []byte
			b, e = io.ReadAll(io.LimitReader(reader, 100001))
			if len(b) > 100000 {
				e = errors.New("INVALID_REQUEST: prompt exceeds 100000 bytes")
			}
			v.Params["prompt"] = string(b)
		}
		delete(v.Params, "prompt-stdin")
		delete(v.Params, "prompt-file")
		if e != nil {
			r, c := errorResult(e)
			_ = Print(out, r)
			return c
		}
	}

	if v.Command == "ask" || v.Command == "followup" {
		if prompt := v.Params["prompt"]; strings.TrimSpace(prompt) == "" || len(prompt) > 100000 {
			r, c := errorResult(errors.New("INVALID_REQUEST: prompt must be nonempty and at most 100000 bytes"))
			_ = Print(out, r)
			return c
		}
	}
	b, e := json.Marshal(v.Params)
	if e != nil {
		r, c := errorResult(e)
		_ = Print(out, r)
		return c
	}
	deadline := time.Now().Add(rpc.DefaultTimeout)
	if v.Command == "ask" || v.Command == "followup" {
		// A follow-up may queue behind the previous reply's background naming.
		deadline = time.Now().Add(2 * time.Minute)
	}
	if v.Command == "login" {
		deadline = time.Now().Add(10*time.Minute + 2*time.Second)
	}
	if v.Command == "wait" {
		d := 60 * time.Second
		if n := v.Params["timeout-seconds"]; n != "" {
			d, _ = time.ParseDuration(n + "s")
		}
		deadline = time.Now().Add(d + 2*time.Second)
	}
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	req := rpc.Request{ID: v.Params["request-id"], Command: v.Command, Params: b, Deadline: deadline, Stream: v.Command == "wait"}
	res, e := (rpc.Client{Socket: v.Paths.Socket()}).Call(ctx, req)
	// Never retry a request after connecting: only an absent socket permits auto-start.
	if e != nil && errors.Is(e, os.ErrNotExist) {
		if startErr := AutoStart(ctx, v.Paths); startErr != nil {
			e = startErr
		} else {
			res, e = (rpc.Client{Socket: v.Paths.Socket()}).Call(ctx, req)
		}
	}
	if e != nil {
		r, c := errorResult(e)
		_ = Print(out, r)
		return c
	}
	if res.Error != nil {
		_ = Print(out, map[string]any{"error": res.Error, "code": res.Error.Code})
		return res.ExitCode
	}
	_ = Print(out, res.Result)
	return res.ExitCode
}
func RegisterConfig(s *daemon.Server, p config.Paths) {
	for _, name := range []string{"config get", "config set", "config list"} {
		s.Register(name, func(ctx context.Context, r rpc.Request) (any, error) {
			var args map[string]string
			if e := json.Unmarshal(r.Params, &args); e != nil {
				return nil, rpc.NewError("INVALID_ARGUMENT", e.Error())
			}
			if r.Command == "config set" {
				v, e := config.WritePreference(p, args["key"], args["value"])
				if e == nil {
					v["action"] = "set"
				}
				return v, e
			}
			v, e := config.ReadPreferences(p)
			if e != nil {
				return nil, e
			}
			if r.Command == "config get" {
				if !config.KnownKey(args["key"]) {
					return nil, rpc.NewError("UNKNOWN_SETTING", args["key"])
				}
				return config.Display(args["key"], v.Values[args["key"]]), nil
			}
			settings := make([]map[string]any, 0, len(config.SettingKeys))
			for _, k := range config.SettingKeys {
				settings = append(settings, config.Display(k, v.Values[k]))
			}
			return map[string]any{"file": p.PreferencesFile(), "settings": settings}, nil
		})
	}
}

// AutoStart is a development fallback. Installed units are never silently bypassed.
func AutoStart(ctx context.Context, p config.Paths) error {
	h, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	for _, base := range []string{filepath.Join(h, ".config/systemd/user"), "/etc/systemd/user", "/usr/lib/systemd/user", "/lib/systemd/user"} {
		if _, e := os.Stat(filepath.Join(base, "convorel.service")); e == nil {
			return rpc.NewError("DAEMON_UNAVAILABLE", "convorel.service is installed; start the user service")
		}
	}
	executable, e := os.Executable()
	if e != nil {
		return e
	}
	cmd := exec.Command(executable, "--config-dir", p.ConfigDir, "--state-dir", p.StateDir, "daemon")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if e = cmd.Start(); e != nil {
		return e
	}
	go func() { _ = cmd.Wait() }()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return fmt.Errorf("DAEMON_START_FAILED: socket not available")
		case <-tick.C:
			c, e := net.DialTimeout("unix", p.Socket(), 100*time.Millisecond)
			if e == nil {
				c.Close()
				return nil
			}
		}
	}
}
