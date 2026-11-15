package daemon_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/rpc"
)

func start(t *testing.T, s *daemon.Server) (rpc.Client, context.Context) {
	t.Helper()
	dir := t.TempDir()
	if e := s.Listen(dir); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case e := <-done:
			if e != nil {
				t.Error(e)
			}
		case <-time.After(3 * time.Second):
			t.Error("daemon did not stop")
		}
		if e := s.Close(); e != nil {
			t.Error(e)
		}
		if _, e := os.Stat(filepath.Join(dir, "convorel.sock")); !errors.Is(e, os.ErrNotExist) {
			t.Errorf("socket not removed: %v", e)
		}
	})
	return rpc.Client{Socket: filepath.Join(dir, "convorel.sock")}, ctx
}
func TestRoundTripAndPrivateSingleInstance(t *testing.T) {
	s := daemon.New()
	client, ctx := start(t, s)
	for path, want := range map[string]os.FileMode{filepath.Dir(client.Socket): 0700, client.Socket: 0600} {
		st, e := os.Stat(path)
		if e != nil || st.Mode().Perm() != want {
			t.Fatalf("mode %s: %v %v", path, st, e)
		}
	}
	for _, name := range []string{"ping", "version"} {
		res, e := client.Call(ctx, rpc.Request{ID: "request", Command: name})
		if e != nil || res.Error != nil || res.ID != "request" || !res.Done {
			t.Fatalf("%s: %+v %v", name, res, e)
		}
		m := res.Result.(map[string]any)
		if m["version"] != rpc.Version {
			t.Fatalf("wrong version: %v", m)
		}
	}
	second := daemon.New()
	if e := second.Listen(filepath.Dir(client.Socket)); e == nil {
		second.Close()
		t.Fatal("second daemon accepted")
	}
	res, e := client.Call(ctx, rpc.Request{Command: "ask"})
	if e != nil || res.Error == nil || res.Error.Code != "UNKNOWN_COMMAND" || res.ExitCode != 1 {
		t.Fatalf("stub: %+v %v", res, e)
	}
}

// This verifies the transport part of A6: disconnecting a waiting client has no
// effect on daemon-owned work, and a fresh subscriber reads the same completion.
func TestWaitDisconnectReattaches(t *testing.T) {
	s := daemon.New()
	started := make(chan struct{}, 2)
	complete := make(chan struct{})
	s.RegisterStream("wait", func(ctx context.Context, r rpc.Request, emit func(any) error) (any, error) {
		started <- struct{}{}
		select {
		case <-complete:
			return map[string]any{"run": "same-run", "phase": "complete", "reply": map[string]string{"markdown": "OK"}}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	client, ctx := start(t, s)
	c, e := net.Dial("unix", client.Socket)
	if e != nil {
		t.Fatal(e)
	}
	if e = rpc.Write(c, rpc.Request{Command: "wait", Stream: true}); e != nil {
		t.Fatal(e)
	}
	<-started
	c.Close()
	close(complete)
	res, e := client.Call(ctx, rpc.Request{Command: "wait", Stream: true})
	if e != nil || res.Error != nil {
		t.Fatalf("reattach: %+v %v", res, e)
	}
	m := res.Result.(map[string]any)
	if m["run"] != "same-run" || m["phase"] != "complete" {
		t.Fatalf("wrong result: %v", m)
	}
	entries, e := os.ReadDir(filepath.Dir(client.Socket))
	if e != nil {
		t.Fatal(e)
	}
	for _, entry := range entries {
		if entry.Name() != "convorel.sock" {
			t.Fatalf("unexpected state artifact: %s", entry.Name())
		}
	}
}
func TestStreamingProgressAndDeadline(t *testing.T) {
	s := daemon.New()
	s.RegisterStream("wait", func(ctx context.Context, r rpc.Request, emit func(any) error) (any, error) {
		if e := emit(map[string]string{"phase": "delivered"}); e != nil {
			return nil, e
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	client, ctx := start(t, s)
	frames := 0
	e := client.Stream(ctx, rpc.Request{Command: "wait", Stream: true, Deadline: time.Now().Add(100 * time.Millisecond)}, func(r rpc.Response) error { frames++; return nil })
	if frames != 1 {
		t.Fatalf("expected progress: %d", frames)
	}
	if e == nil {
		t.Fatal("deadline was ignored")
	}
	res, e := client.Call(ctx, rpc.Request{Command: "ping"})
	if e != nil || res.Error != nil {
		t.Fatalf("deadline affected daemon: %+v %v", res, e)
	}
}
func TestMalformedAndPending(t *testing.T) {
	s := daemon.New()
	s.Register("pending", func(context.Context, rpc.Request) (any, error) {
		return daemon.Result{Value: map[string]string{"phase": "delivered"}, ExitCode: 2}, nil
	})
	client, ctx := start(t, s)
	r, e := client.Call(ctx, rpc.Request{Command: "pending"})
	if e != nil || r.ExitCode != 2 {
		t.Fatalf("pending: %+v %v", r, e)
	}
	c, e := net.Dial("unix", client.Socket)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	c.Write([]byte("invalid\n"))
	var res rpc.Response
	if e = json.NewDecoder(c).Decode(&res); e != nil || res.Error == nil || res.Error.Code != "INVALID_REQUEST" {
		t.Fatalf("invalid request: %+v %v", res, e)
	}
}
