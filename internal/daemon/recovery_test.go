package daemon_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/rpc"
)

const (
	crashEnv      = "CONVOREL_TEST_DAEMON_CRASH"
	crashDirEnv   = "CONVOREL_TEST_DAEMON_CRASH_DIR"
	crashReadyEnv = "CONVOREL_TEST_DAEMON_CRASH_READY"
)

// TestHardKilledDaemonSocketRecovers runs the daemon in a child process, kills
// it with SIGKILL so the socket is left behind and the flock is released by the
// kernel, then starts a new daemon on the same state directory.
func TestHardKilledDaemonSocketRecovers(t *testing.T) {
	if os.Getenv(crashEnv) == "1" {
		crashDaemonChild()
		return
	}
	stateDir := t.TempDir()
	readyDir := t.TempDir()
	ready := filepath.Join(readyDir, "ready")
	sock := filepath.Join(stateDir, "convorel.sock")
	cmd := exec.Command(os.Args[0], "-test.run=^TestHardKilledDaemonSocketRecovers$")
	cmd.Env = append(os.Environ(), crashEnv+"=1", crashDirEnv+"="+stateDir, crashReadyEnv+"="+ready)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		if waited {
			return
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("crashing daemon did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("daemon did not bind before crash: %v", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	err := cmd.Wait()
	waited = true
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("child did not die from SIGKILL: %v", err)
	}
	if status, ok := exit.ProcessState.Sys().(syscall.WaitStatus); !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("child exit status: %v", exit.ProcessState)
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("SIGKILL should leave the socket behind: %v", err)
	}

	s := daemon.New()
	if err := s.Listen(stateDir); err != nil {
		t.Fatalf("restart after hard kill: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "convorel.sock" {
		t.Fatalf("election created artifacts besides the socket: %v", entries)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx) }()
	res, err := (rpc.Client{Socket: sock}).Call(ctx, rpc.Request{ID: "recovery", Command: "ping"})
	if err != nil || res.Error != nil || res.ID != "recovery" {
		t.Fatalf("recovered daemon ping: %+v %v", res, err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("recovered daemon did not stop")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func crashDaemonChild() {
	s := daemon.New()
	if err := s.Listen(os.Getenv(crashDirEnv)); err != nil {
		os.Exit(2)
	}
	if err := os.WriteFile(os.Getenv(crashReadyEnv), []byte("ready"), 0600); err != nil {
		os.Exit(3)
	}
	time.Sleep(time.Hour)
}

func TestConcurrentListenHasOneWinner(t *testing.T) {
	dir := t.TempDir()
	type result struct {
		server *daemon.Server
		err    error
	}
	servers := []*daemon.Server{daemon.New(), daemon.New()}
	started := make(chan struct{})
	results := make(chan result, len(servers))
	for _, s := range servers {
		go func(s *daemon.Server) {
			<-started
			results <- result{s, s.Listen(dir)}
		}(s)
	}
	close(started)
	var winner *daemon.Server
	for range servers {
		r := <-results
		if r.err == nil {
			if winner != nil {
				t.Fatal("more than one daemon won the state directory")
			}
			winner = r.server
			continue
		}
		var rpcErr *rpc.Error
		if !errors.As(r.err, &rpcErr) || rpcErr.Code != "DAEMON_ALREADY_RUNNING" {
			t.Fatalf("loser error = %v", r.err)
		}
	}
	if winner == nil {
		t.Fatal("no daemon won the state directory")
	}
	t.Cleanup(func() { _ = winner.Close() })
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "convorel.sock" {
		t.Fatalf("election created artifacts besides the socket: %v", entries)
	}
	if err := winner.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "convorel.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket not removed on close: %v", err)
	}
	next := daemon.New()
	if err := next.Listen(dir); err != nil {
		t.Fatalf("listen after release: %v", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOversizeFrameRejected(t *testing.T) {
	s := daemon.New()
	client, _ := start(t, s)
	conn, err := net.Dial("unix", client.Socket)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	chunk := bytes.Repeat([]byte("x"), 1<<20)
	for i := 0; i < rpc.MaxFrameBytes/(1<<20)+1; i++ {
		if _, err := conn.Write(chunk); err != nil {
			break
		}
	}
	_, _ = conn.Write([]byte("\n"))
	var res rpc.Response
	if err := json.NewDecoder(conn).Decode(&res); err != nil {
		t.Fatalf("oversize response: %v", err)
	}
	if res.Error == nil || res.Error.Code != "RPC_FRAME_TOO_LARGE" {
		t.Fatalf("oversize frame response: %+v", res)
	}
}
