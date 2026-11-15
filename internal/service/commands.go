package service

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/rpc"
)

// Version is injected from VERSION by scripts/build.sh. Development binaries identify themselves.
var Version = "dev"

// Build assets are injected via a Go build overlay; source checkouts read their own files.
var installerText string
var skillFiles = map[string]string{}

type LoginFunc func(context.Context, config.Paths) (any, error)

// Register installs service-side handlers. Login is supplied by the owner of Chrome lifecycle.
func Register(s *daemon.Server, p config.Paths, login ...LoginFunc) {
	s.Register("setup", func(ctx context.Context, r rpc.Request) (any, error) {
		var args map[string]string
		if e := json.Unmarshal(r.Params, &args); e != nil {
			return nil, e
		}
		return Setup(ctx, p, args)
	})
	s.Register("login", func(ctx context.Context, r rpc.Request) (any, error) {
		if len(login) > 0 && login[0] != nil {
			return login[0](ctx, p)
		}
		return nil, rpc.NewError("BROWSER_UNAVAILABLE", "login requires the daemon Chrome lifecycle binding")
	})
	s.Register("skills install", func(ctx context.Context, r rpc.Request) (any, error) {
		var args map[string]string
		if e := json.Unmarshal(r.Params, &args); e != nil {
			return nil, e
		}
		return InstallSkill(args["target"])
	})
}

// Local handles commands which must work before the daemon exists or stop that daemon.
func Local(ctx context.Context, p config.Paths, command string, args map[string]string) (any, bool, error) {
	switch command {
	case "service install", "service uninstall", "service status":
		h, e := os.UserHomeDir()
		if e != nil {
			return nil, true, e
		}
		executable, e := os.Executable()
		if e != nil {
			return nil, true, e
		}
		// Preserve the stable installer link across upgrades, rather than pinning an old version.
		if layout, e := InstallLayout(executable); e == nil {
			executable = filepath.Join(layout.BinDir, "convorel")
		}
		m := Manager{UnitDir: filepath.Join(h, ".config/systemd/user"), Executable: executable, Paths: p}
		var v any
		switch command {
		case "service install":
			v, e = m.Install(ctx)
		case "service uninstall":
			v, e = m.Uninstall(ctx)
		default:
			v, e = m.Status(ctx)
		}
		return v, true, e
	case "upgrade":
		v, e := Upgrade(ctx, args["version"], p)
		return v, true, e
	}
	return nil, false, nil
}

var setupMu sync.Mutex

func Setup(ctx context.Context, p config.Paths, args map[string]string) (any, error) {
	setupMu.Lock()
	defer setupMu.Unlock()
	workspace := args["workspace"]
	if workspace == "" {
		return nil, errors.New("WORKSPACE_REQUIRED")
	}
	root, e := filepath.Abs(workspace)
	if e != nil {
		return nil, e
	}
	root, e = filepath.EvalSymlinks(root)
	if e != nil {
		return nil, e
	}
	st, e := os.Stat(root)
	if e != nil || !st.IsDir() {
		return nil, errors.New("WORKSPACE_NOT_DIRECTORY")
	}
	state, e := filepath.Abs(p.StateDir)
	if e != nil {
		return nil, e
	}
	if state == root || strings.HasPrefix(state, root+string(os.PathSeparator)) {
		return nil, errors.New("STATE_INSIDE_WORKSPACE")
	}
	c := config.Config{Version: 1, Workspace: root, CDP: args["cdp"]}
	if c.CDP != "" {
		u, e := url.Parse(c.CDP)
		if e != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
			return nil, errors.New("CDP_LOOPBACK_REQUIRED")
		}
	} else {
		chrome := args["chrome"]
		if chrome == "" {
			for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
				if found, e := exec.LookPath(name); e == nil {
					chrome = found
					break
				}
			}
		}
		if chrome == "" {
			return nil, errors.New("CHROME_NOT_FOUND: install Chrome or specify --chrome")
		}
		chrome, e = filepath.Abs(chrome)
		if e != nil {
			return nil, e
		}
		st, e := os.Stat(chrome)
		if e != nil || st.IsDir() || st.Mode()&0111 == 0 {
			return nil, errors.New("CHROME_NOT_EXECUTABLE")
		}
		profile := args["user-data-dir"]
		if profile == "" {
			profile = filepath.Join(p.StateDir, "chrome")
		}
		profile, e = config.FullPath(profile)
		if e != nil {
			return nil, e
		}
		listener, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			return nil, e
		}
		port := listener.Addr().String()
		listener.Close()
		c.CDP = "http://" + port
		c.Browser = &config.Browser{Mode: "managed", Executable: chrome, UserDataDir: profile}
	}
	if old, e := config.Load(p); e == nil {
		// Repeated setup reuses the chosen managed endpoint and saved profile.
		if args["cdp"] == "" && old.Browser != nil {
			c.CDP = old.CDP
			if args["user-data-dir"] == "" {
				c.Browser.UserDataDir = old.Browser.UserDataDir
			}
		}
		if old.Workspace != c.Workspace || old.CDP != c.CDP {
			return nil, errors.New("CONFIG_BINDING_IMMUTABLE")
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	if e = config.Save(p, c); e != nil {
		return nil, e
	}
	if args["user-data-dir"] != "" {
		if _, e = config.WritePreference(p, "browser.userDataDir", args["user-data-dir"]); e != nil {
			return nil, e
		}
	}
	if args["headless"] != "" {
		if _, e = config.WritePreference(p, "browser.headless", args["headless"]); e != nil {
			return nil, e
		}
	}
	return map[string]any{"configured": true, "config": c, "login": "run convorel login", "runtime": runtime.Version()}, nil
}
