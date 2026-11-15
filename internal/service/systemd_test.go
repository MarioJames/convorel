package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MarioJames/convorel/internal/config"
)

func testPaths(t *testing.T) config.Paths {
	t.Helper()
	root := t.TempDir()
	return config.Paths{ConfigDir: filepath.Join(root, "config"), StateDir: filepath.Join(root, "state")}
}
func put(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(path, []byte(body), mode); e != nil {
		t.Fatal(e)
	}
}
func TestUnitAndMigration(t *testing.T) {
	p := testPaths(t)
	root := t.TempDir()
	calls := filepath.Join(root, "calls")
	fake := filepath.Join(root, "bin", "systemctl")
	put(t, fake, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_CALLS\"\ncase \"$*\" in *is-active*) echo active ;; esac\n", 0755)
	t.Setenv("PATH", filepath.Dir(fake)+":"+os.Getenv("PATH"))
	t.Setenv("SYSTEMCTL_CALLS", calls)
	units := filepath.Join(root, "units")
	put(t, filepath.Join(units, "convorel-tunnel.service"), "old", 0600)
	put(t, filepath.Join(units, "convorel-tunnel.service.d", "recover-lock.conf"), "legacy", 0600)
	unrelated := filepath.Join(root, "unrelated", "convorel-tunnel.service")
	put(t, unrelated, "keep", 0600)
	m := Manager{UnitDir: units, Executable: "/tmp/space path/convorel%$", Paths: p}
	unit, e := m.Unit()
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(unit, `ExecStart="/tmp/space path/convorel%%$$"`) || !strings.Contains(unit, "Restart=on-failure") || !strings.Contains(unit, `"daemon"`) {
		t.Fatalf("bad unit: %s", unit)
	}
	if _, e = m.Install(context.Background()); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(units, "convorel-tunnel.service")); !os.IsNotExist(e) {
		t.Fatal("legacy unit remains")
	}
	if _, e := os.Stat(filepath.Join(units, "convorel-tunnel.service.d")); !os.IsNotExist(e) {
		t.Fatal("legacy drop-in remains")
	}
	if b, e := os.ReadFile(unrelated); e != nil || string(b) != "keep" {
		t.Fatal("changed another directory")
	}
	b, e := os.ReadFile(calls)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(b), "--user disable --now convorel-tunnel.service") || !strings.Contains(string(b), "--user enable --now "+filepath.Join(units, "convorel.service")) {
		t.Fatalf("wrong targets: %s", b)
	}
	status, e := m.Status(context.Background())
	if e != nil || status.(map[string]any)["active"] != true {
		t.Fatalf("status: %v %v", status, e)
	}
	if _, e = m.Uninstall(context.Background()); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(units, "convorel.service")); !os.IsNotExist(e) {
		t.Fatal("unit remains")
	}
}
func TestUnitRejectsInjection(t *testing.T) {
	for _, value := range []string{"relative", "/tmp/a\nExecStart=/bin/evil", "/tmp/a\x00b"} {
		m := Manager{Executable: value, Paths: testPaths(t)}
		if _, e := m.Unit(); e == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
func TestSystemctlFailurePreservesLegacyUnit(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, "bin", "systemctl"), "#!/bin/sh\nexit 1\n", 0755)
	t.Setenv("PATH", filepath.Join(root, "bin"))
	old := filepath.Join(root, "units", "convorel-tunnel.service")
	put(t, old, "old", 0600)
	m := Manager{UnitDir: filepath.Dir(old), Executable: "/tmp/convorel", Paths: testPaths(t)}
	if _, e := m.Install(context.Background()); e == nil {
		t.Fatal("ignored systemctl error")
	}
	if _, e := os.Stat(old); e != nil {
		t.Fatal("removed legacy before stopping it")
	}
}
