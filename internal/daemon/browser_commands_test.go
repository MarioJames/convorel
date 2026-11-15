package daemon_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/rpc"
)

func TestLoginUsesSharedBrowserReservation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	paths := config.Paths{ConfigDir: t.TempDir(), StateDir: t.TempDir()}
	if err := config.Save(paths, config.Config{Version: 1, Workspace: t.TempDir(), CDP: "http://127.0.0.1:1"}); err != nil {
		t.Fatal(err)
	}
	s := daemon.New()
	var shared cdp.Browser
	cleanup, err := daemon.RegisterConversations(ctx, s, paths, func(_ context.Context, b cdp.Browser) (any, error) {
		if shared != nil && b != shared {
			t.Error("login replaced shared browser")
		}
		shared = b
		if b.IdleInfo().InFlight != 1 {
			t.Error("login has no idle reservation")
		}
		return map[string]any{"ready": true}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	for i := 0; i < 2; i++ {
		response := s.Dispatch(ctx, rpc.Request{Command: "login", Params: json.RawMessage(`{}`)})
		if response.Error != nil || response.ExitCode != 0 {
			t.Fatalf("login: %+v", response)
		}
		if shared.IdleInfo().InFlight != 0 {
			t.Fatal("login leaked activity reservation")
		}
	}
}

func TestLegacyControllerPreferenceUsesSavedChrome(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	paths := config.Paths{ConfigDir: t.TempDir(), StateDir: t.TempDir()}
	chrome := filepath.Join(t.TempDir(), "chrome")
	marker := chrome + ".called"
	if err := os.WriteFile(chrome, []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.Save(paths, config.Config{Version: 1, Workspace: t.TempDir(), CDP: "http://127.0.0.1:1", Browser: &config.Browser{Executable: chrome, UserDataDir: t.TempDir()}}); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"browser.executable": "/missing/agent-browser", "browser.headless": "true"} {
		if _, err := config.WritePreference(paths, key, value); err != nil {
			t.Fatal(err)
		}
	}
	s := daemon.New()
	cleanup, err := daemon.RegisterConversations(ctx, s, paths, func(ctx context.Context, b cdp.Browser) (any, error) { return nil, b.EnsureStarted(ctx) })
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	_ = s.Dispatch(ctx, rpc.Request{Command: "login", Params: json.RawMessage(`{}`)})
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("saved Chrome was not selected", err)
	}
	prefs, err := config.ReadPreferences(paths)
	if err != nil || prefs.Values["browser.executable"] != "/missing/agent-browser" {
		t.Fatal("legacy preference changed")
	}
}
