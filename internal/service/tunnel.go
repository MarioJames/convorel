package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MarioJames/convorel/internal/config"
)

type TunnelStatus struct {
	Running  bool   `json:"running"`
	PID      int    `json:"pid,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
	Log      string `json:"log"`
}

// Tunnel is owned by one daemon. Run blocks until cancellation and reaps every child.
type Tunnel struct {
	Paths                             config.Paths
	Executable                        string
	MinBackoff, MaxBackoff, StopGrace time.Duration
	mu                                sync.Mutex
	status                            TunnelStatus
}

func (t *Tunnel) Status() TunnelStatus { t.mu.Lock(); defer t.mu.Unlock(); return t.status }
func shellQuote(s string) string       { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
func TunnelArgs(p config.Paths, executable, id string, roots []string) ([]string, error) {
	if id == "" {
		return nil, errors.New("TUNNEL_ID_REQUIRED")
	}
	if e := config.Validate("tunnel.id", id); e != nil {
		return nil, e
	}
	if !filepath.IsAbs(executable) || len(roots) == 0 {
		return nil, errors.New("TUNNEL_CONFIGURATION_INVALID")
	}
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			return nil, errors.New("ABSOLUTE_PATH_REQUIRED")
		}
	}
	command := []string{executable, "--config-dir", p.ConfigDir, "--state-dir", p.StateDir, "mcp", "serve"}
	// MCP reads its allowed roots from the same private preferences/config files.
	for i, s := range command {
		command[i] = shellQuote(s)
	}
	return []string{"run", "--control-plane.tunnel-id", id, "--mcp.command", strings.Join(command, " "), "--health.listen-addr", "127.0.0.1:0", "--health.url-file", filepath.Join(p.StateDir, "tunnel.health-url")}, nil
}
func (t *Tunnel) command() (*exec.Cmd, error) {
	pref, e := config.ReadPreferences(t.Paths)
	if e != nil {
		return nil, e
	}
	if pref.Values["tunnel.id"] == "" {
		return nil, errors.New("TUNNEL_NOT_CONFIGURED")
	}
	if pref.Values["tunnel.apiKey"] == "" {
		return nil, errors.New("TUNNEL_CREDENTIAL_MISSING")
	}
	c, e := config.Load(t.Paths)
	if e != nil {
		return nil, e
	}
	roots := []string{c.Workspace}
	if raw := pref.Values["mcp.roots"]; raw != "" {
		if e = json.Unmarshal([]byte(raw), &roots); e != nil {
			return nil, e
		}
	}
	for i, root := range roots {
		roots[i], e = config.FullPath(root)
		if e != nil {
			return nil, e
		}
	}
	args, e := TunnelArgs(t.Paths, t.Executable, pref.Values["tunnel.id"], roots)
	if e != nil {
		return nil, e
	}
	path, e := exec.LookPath("tunnel-client")
	if e != nil {
		return nil, errors.New("TUNNEL_CLIENT_MISSING: install official tunnel-client on PATH")
	}
	cmd := exec.Command(path, args...)
	cmd.Dir = t.Paths.StateDir
	// Credentials are passed only in the environment, never in argv or logs.
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "CONTROL_PLANE_API_KEY=") {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, "CONTROL_PLANE_API_KEY="+pref.Values["tunnel.apiKey"])
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	return cmd, nil
}
func (t *Tunnel) Run(ctx context.Context) error {
	if e := os.MkdirAll(t.Paths.StateDir, 0700); e != nil {
		return e
	}
	min, max, grace := t.MinBackoff, t.MaxBackoff, t.StopGrace
	if min <= 0 {
		min = time.Second
	}
	if max < min {
		max = 30 * time.Second
	}
	if grace <= 0 {
		grace = 5 * time.Second
	}
	delay := min
	logPath := filepath.Join(t.Paths.StateDir, "tunnel.log")
	t.mu.Lock()
	t.status.Log = logPath
	t.mu.Unlock()
	for ctx.Err() == nil {
		cmd, err := t.command()
		var log *os.File
		started := time.Now()
		if err == nil {
			if st, e := os.Stat(logPath); e == nil && st.Size() > 8<<20 {
				_ = os.Rename(logPath, logPath+".previous")
			}
			log, err = os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err == nil {
				err = log.Chmod(0600)
			}
			if err == nil {
				cmd.Stdout = log
				cmd.Stderr = log
				err = cmd.Start()
			}
			if err == nil {
				t.mu.Lock()
				t.status.Running = true
				t.status.PID = cmd.Process.Pid
				t.status.Error = ""
				t.mu.Unlock()
				done := make(chan error, 1)
				go func() { done <- cmd.Wait() }()
				select {
				case err = <-done:
					// Kill descendants even when the tunnel parent exits first.
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				case <-ctx.Done():
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
					timer := time.NewTimer(grace)
					select {
					case <-done:
					case <-timer.C:
						_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
						<-done
					}
					timer.Stop()
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				}
			}
		}
		if log != nil {
			_ = log.Close()
		}
		t.mu.Lock()
		t.status.Running = false
		t.status.PID = 0
		if err != nil {
			t.status.Error = err.Error()
		}
		t.mu.Unlock()
		if ctx.Err() != nil {
			return nil
		}
		t.mu.Lock()
		t.status.Restarts++
		t.mu.Unlock()
		if time.Since(started) > time.Minute {
			delay = min
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if delay < max {
			delay *= 2
			if delay > max {
				delay = max
			}
		}
	}
	return nil
}

// StartBackground ties a supervisor to daemon lifetime; the returned function cancels and waits.
// Unconfigured tunnels stay dormant and are rechecked with bounded backoff.
func StartBackground(ctx context.Context, p config.Paths) func() {
	executable, e := os.Executable()
	if e != nil {
		return func() {}
	}
	childCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := &Tunnel{Paths: p, Executable: executable}
		if e := t.Run(childCtx); e != nil {
			fmt.Fprintln(os.Stderr, "convorel tunnel:", e)
		}
	}()
	return func() { cancel(); <-done }
}
