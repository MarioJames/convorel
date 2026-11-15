package config_test

import (
	"encoding/json"
	"github.com/MarioJames/convorel/internal/config"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func paths(t *testing.T) config.Paths {
	t.Helper()
	d := t.TempDir()
	return config.Paths{ConfigDir: filepath.Join(d, "cfg"), StateDir: filepath.Join(d, "state")}
}
func TestLegacyFilesAndDefaults(t *testing.T) {
	p := paths(t)
	if _, e := config.ReadPreferences(p); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(p.ConfigDir); !os.IsNotExist(e) {
		t.Fatal("read created directory")
	}
	old := config.Config{Version: 1, Workspace: "/tmp/work", CDP: "http://127.0.0.1:9222", Browser: &config.Browser{Executable: "/usr/bin/google-chrome", UserDataDir: "/tmp/old-profile"}}
	if e := config.Save(p, old); e != nil {
		t.Fatal(e)
	}
	got, e := config.Load(p)
	if e != nil || got.CDP != old.CDP || got.Browser.UserDataDir != "/tmp/old-profile" {
		t.Fatalf("legacy binding: %+v %v", got, e)
	}
	if e = os.MkdirAll(p.ConfigDir, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(p.PreferencesFile(), []byte(`{"version":1,"values":{"model":"Latest","tunnel.apiKey":"private","browser.userDataDir":"/tmp/preferred"}}`), 0600); e != nil {
		t.Fatal(e)
	}
	v, e := config.ReadPreferences(p)
	if e != nil {
		t.Fatal(e)
	}
	if v.Effort() != 5 || v.IdleStopMinutes() != 10 {
		t.Fatal("new defaults differ")
	}
	profile, source, e := config.ResolveBrowserProfile(p, got, v)
	if e != nil || profile != "/tmp/preferred" || source != "preference" {
		t.Fatalf("profile: %s %s %v", profile, source, e)
	}
	if got.Browser.UserDataDir != "/tmp/old-profile" {
		t.Fatal("rewrote saved fallback")
	}
	if config.Display("tunnel.apiKey", v.Values["tunnel.apiKey"])["value"] != "set" {
		t.Fatal("secret exposed")
	}
}
func TestPreferenceConcurrentWritesAndValidation(t *testing.T) {
	p := paths(t)
	var wg sync.WaitGroup
	for key, value := range map[string]string{"effort": "1", "browser.idleStopMinutes": "2", "model": "Latest"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := config.WritePreference(p, key, value); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	v, e := config.ReadPreferences(p)
	if e != nil || len(v.Values) != 3 || v.Effort() != 1 || v.IdleStopMinutes() != 2 {
		t.Fatalf("lost update: %+v %v", v, e)
	}
	for _, file := range []string{p.PreferencesFile(), p.ConfigDir} {
		st, e := os.Stat(file)
		if e != nil {
			t.Fatal(e)
		}
		want := os.FileMode(0600)
		if st.IsDir() {
			want = 0700
		}
		if st.Mode().Perm() != want {
			t.Fatalf("unsafe permissions: %s", file)
		}
	}
	for _, tc := range [][2]string{{"effort", "6"}, {"effort", "0"}, {"browser.idleStopMinutes", "-1"}, {"browser.headless", "yes"}, {"project.url", "https://chatgpt.com/g/g-p-fake"}, {"mcp.memoryRoots", `{"name":"/tmp/path"}`}, {"bad", "value"}} {
		if e := config.Validate(tc[0], tc[1]); e == nil {
			t.Errorf("accepted %v", tc)
		}
	}
	if e := config.Validate("mcp.memoryRoots", `["viking://tenant/user/memory"]`); e != nil {
		t.Fatal(e)
	}
	if _, e := config.WritePreference(p, "effort", ""); e != nil {
		t.Fatal(e)
	}
	v, _ = config.ReadPreferences(p)
	if v.Effort() != 5 {
		t.Fatal("empty preference should restore default")
	}
	b, _ := os.ReadFile(p.PreferencesFile())
	var raw map[string]any
	if json.Unmarshal(b, &raw) != nil || raw["version"] != float64(1) {
		t.Fatal("file format changed")
	}
}
func TestExplicitRuntimePathsAndPairSnapshot(t *testing.T) {
	p, args, e := config.ConsumeArgs([]string{"--state-dir", "relative-state", "--config-dir", "relative-config", "config", "set", "model", "--literal"})
	if e != nil || !filepath.IsAbs(p.StateDir) || len(args) != 4 || args[3] != "--literal" {
		t.Fatalf("args: %v %+v %v", args, p, e)
	}
	if _, _, e = config.ConsumeArgs([]string{"--state-dir", "--config-dir"}); e == nil {
		t.Fatal("missing path accepted")
	}
	_, e = config.Snapshot(config.Config{}, config.Preferences{Values: map[string]string{"project.name": "one half"}})
	if e == nil {
		t.Fatal("partial project accepted")
	}
}
