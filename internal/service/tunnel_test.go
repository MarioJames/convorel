package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/config"
)

func TestTunnelRestartAndStop(t *testing.T) {
	p := testPaths(t)
	// "~/workspaces" must resolve inside a disposable home, not the developer's.
	home := t.TempDir()
	if e := os.Mkdir(filepath.Join(home, "workspaces"), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("HOME", home)
	if e := config.Save(p, config.Config{Version: 1, Workspace: t.TempDir()}); e != nil {
		t.Fatal(e)
	}
	for k, v := range map[string]string{"tunnel.id": "tunnel_0123456789abcdef0123456789abcdef", "tunnel.apiKey": "test-secret", "mcp.roots": `["~/workspaces"]`} {
		if _, e := config.WritePreference(p, k, v); e != nil {
			t.Fatal(e)
		}
	}
	root := t.TempDir()
	counter := filepath.Join(root, "attempts")
	fake := filepath.Join(root, "tunnel-client")
	put(t, fake, `#!/bin/sh
printf '%s\n' "$*" >> "$TUNNEL_ATTEMPTS"
[ "$CONTROL_PLANE_API_KEY" = test-secret ] || exit 42
if [ "$(wc -l < "$TUNNEL_ATTEMPTS")" -eq 1 ]; then exit 1; fi
printf 'ready\n'
trap 'exit 0' TERM
while :; do sleep 1; done
`, 0755)
	t.Setenv("PATH", root+":"+os.Getenv("PATH"))
	t.Setenv("TUNNEL_ATTEMPTS", counter)
	tunnel := &Tunnel{Paths: p, Executable: "/tmp/convorel's binary", MinBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond, StopGrace: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tunnel.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("tunnel cleanup timed out")
		}
	})
	var pid int
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for pid == 0 {
		select {
		case <-deadline:
			t.Fatal("tunnel failed to restart")
		case <-ticker.C:
			s := tunnel.Status()
			if s.Restarts >= 1 && s.Running {
				pid = s.PID
			}
		}
	}
	cancel()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
		done <- nil
	case <-time.After(3 * time.Second):
		t.Fatal("tunnel did not stop")
	}
	if e := syscall.Kill(pid, 0); e == nil {
		t.Fatal("child still alive")
	}
	log, e := os.ReadFile(filepath.Join(p.StateDir, "tunnel.log"))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(log), "test-secret") {
		t.Fatal("secret leaked")
	}
	st, e := os.Stat(filepath.Join(p.StateDir, "tunnel.log"))
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("unsafe log")
	}
	args, e := os.ReadFile(counter)
	if e != nil {
		t.Fatal(e)
	}
	for _, part := range []string{"run --control-plane.tunnel-id tunnel_", "--mcp.command", "--state-dir", "mcp' 'serve", "--health.url-file"} {
		if !strings.Contains(string(args), part) {
			t.Fatalf("missing %s in %s", part, args)
		}
	}
}
func TestTunnelArgsValidateID(t *testing.T) {
	if _, e := TunnelArgs(testPaths(t), "/tmp/binary", "bad", []string{"/tmp"}); e == nil {
		t.Fatal("invalid id accepted")
	}
}
