package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/rpc"
)

func TestSetupIsImmutableAndUsesChromeDirectly(t *testing.T) {
	p := testPaths(t)
	workspace := t.TempDir()
	chrome := filepath.Join(t.TempDir(), "chrome")
	put(t, chrome, "#!/bin/sh\nexit 0\n", 0755)
	args := map[string]string{"workspace": workspace, "chrome": chrome, "headless": "true"}
	if _, e := Setup(context.Background(), p, args); e != nil {
		t.Fatal(e)
	}
	first, e := config.Load(p)
	if e != nil {
		t.Fatal(e)
	}
	if first.Browser.Executable != chrome || first.Browser.UserDataDir != filepath.Join(p.StateDir, "chrome") {
		t.Fatalf("wrong browser: %+v", first.Browser)
	}
	if _, e = Setup(context.Background(), p, args); e != nil {
		t.Fatal(e)
	}
	second, _ := config.Load(p)
	if second.CDP != first.CDP {
		t.Fatal("repeated setup changed endpoint")
	}
	args["workspace"] = t.TempDir()
	if _, e = Setup(context.Background(), p, args); e == nil {
		t.Fatal("rebound existing workspace")
	}
	preserved, _ := config.Load(p)
	if preserved.Workspace != workspace {
		t.Fatal("failed setup changed binding")
	}
	pref, e := config.ReadPreferences(p)
	if e != nil || pref.Values["browser.headless"] != "true" {
		t.Fatal("preference missing")
	}
}
func TestSetupRejectsStateWithinWorkspace(t *testing.T) {
	root := t.TempDir()
	p := config.Paths{ConfigDir: filepath.Join(root, "cfg"), StateDir: filepath.Join(root, "state")}
	if _, e := Setup(context.Background(), p, map[string]string{"workspace": root, "cdp": "http://127.0.0.1:9222"}); e == nil {
		t.Fatal("state exposed")
	}
	if _, e := os.Stat(p.StateDir); !os.IsNotExist(e) {
		t.Fatal("rejected setup created state")
	}
}
func TestLoginRegistrationUsesSharedLifecycle(t *testing.T) {
	p := testPaths(t)
	s := daemon.New()
	called := false
	Register(s, p, func(ctx context.Context, got config.Paths) (any, error) {
		called = true
		if got != p {
			t.Fatal("wrong paths")
		}
		return map[string]any{"ready": true}, nil
	})
	result := s.Dispatch(context.Background(), rpc.Request{Command: "login", Params: []byte(`{}`)})
	if result.Error != nil || !called {
		t.Fatalf("login callback: %+v", result)
	}
}
