package service

import (
	"context"
	"strings"
	"testing"

	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/config"
)

type loginBrowser struct {
	cdp.Browser
	tab     *loginTab
	started bool
}

func (b *loginBrowser) EnsureStarted(context.Context) error { b.started = true; return nil }
func (b *loginBrowser) NewTab(ctx context.Context, url string) (cdp.Tab, error) {
	b.tab.url = url
	return b.tab, nil
}

type loginTab struct {
	cdp.Tab
	url, probe string
	closed     bool
}

func (t *loginTab) Evaluate(ctx context.Context, script string, out any) error {
	t.probe = script
	*(out.(*bool)) = true
	return nil
}
func (t *loginTab) Close(context.Context) error { t.closed = true; return nil }
func TestLoginUsesSessionAndConfiguredProfile(t *testing.T) {
	p := testPaths(t)
	c := config.Config{Version: 1, Workspace: t.TempDir(), CDP: "http://127.0.0.1:9222", Browser: &config.Browser{Executable: "/tmp/fake-chrome", UserDataDir: t.TempDir()}}
	if e := config.Save(p, c); e != nil {
		t.Fatal(e)
	}
	preferred := t.TempDir()
	if _, e := config.WritePreference(p, "browser.userDataDir", preferred); e != nil {
		t.Fatal(e)
	}
	tab := &loginTab{}
	browser := &loginBrowser{tab: tab}
	v, e := Login(context.Background(), p, browser)
	if e != nil {
		t.Fatal(e)
	}
	if !browser.started || tab.url != "https://chatgpt.com/" || !tab.closed {
		t.Fatal("login lifecycle not used")
	}
	if !strings.Contains(tab.probe, "location.origin !== 'https://chatgpt.com'") || !strings.Contains(tab.probe, "/api/auth/session") {
		t.Fatal("login not checked through authenticated session")
	}
	if v.(map[string]any)["profile"] != preferred || v.(map[string]any)["ready"] != true {
		t.Fatalf("wrong result: %v", v)
	}
}
