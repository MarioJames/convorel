package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestLatestAndValidation(t *testing.T) {
	platform, e := Platform()
	if e != nil {
		t.Skip(e)
	}
	body := strings.Repeat("a", 64) + "  convorel-1.2.3-" + platform + ".tar.gz\n"
	var requested string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requested = r.URL.Path; _, _ = w.Write([]byte(body)) }))
	defer server.Close()
	m, e := ReleaseManifest(context.Background(), server.URL, "")
	if e != nil || m.Version != "1.2.3" || requested != "/latest/download/sha256sums.txt" {
		t.Fatalf("latest: %+v %s %v", m, requested, e)
	}
	if _, e = ReleaseManifest(context.Background(), server.URL, "v1.2.3"); e != nil || requested != "/download/v1.2.3/sha256sums.txt" {
		t.Fatalf("version: %s %v", requested, e)
	}
	if _, e = ReleaseManifest(context.Background(), server.URL, "1.2.4"); e == nil {
		t.Fatal("version mismatch accepted")
	}
	for _, invalid := range []string{body + body, strings.ReplaceAll(body, "1.2.3", "../../evil"), strings.Replace(body, strings.Repeat("a", 64), "zz", 1)} {
		body = invalid
		if _, e = ReleaseManifest(context.Background(), server.URL, ""); e == nil {
			t.Fatalf("accepted manifest %s", invalid)
		}
	}
}
func TestInstallerKeepsCurrentAndPrevious(t *testing.T) {
	platform, e := Platform()
	if e != nil {
		t.Skip(e)
	}
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	prefix := filepath.Join(root, "prefix")
	bin := filepath.Join(root, "bin")
	if e = os.MkdirAll(dist, 0700); e != nil {
		t.Fatal(e)
	}
	installer, e := filepath.Abs("../../install.sh")
	if e != nil {
		t.Fatal(e)
	}
	for _, version := range []string{"1.0.0", "1.1.0", "1.2.0"} {
		name := "convorel-" + version + "-" + platform
		stage := filepath.Join(root, name)
		put(t, filepath.Join(stage, "bin", "convorel"), "#!/bin/sh\nprintf '%s\\n' '{\"version\":\""+version+"\"}'\n", 0755)
		archive := filepath.Join(dist, name+".tar.gz")
		if out, e := exec.Command("tar", "-czf", archive, "-C", root, name).CombinedOutput(); e != nil {
			t.Fatalf("tar: %s %v", out, e)
		}
		out, e := exec.Command("sha256sum", archive).Output()
		if e != nil {
			t.Fatal(e)
		}
		put(t, filepath.Join(dist, "sha256sums.txt"), strings.Fields(string(out))[0]+"  "+name+".tar.gz\n", 0600)
		cmd := exec.Command("bash", installer, "--dist-dir", dist, "--prefix", prefix, "--bin-dir", bin)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("install %s: %s %v", version, out, e)
		}
	}
	entries, e := os.ReadDir(filepath.Join(prefix, "versions"))
	if e != nil {
		t.Fatal(e)
	}
	if len(entries) != 2 {
		t.Fatalf("retained %d versions", len(entries))
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "1.0.0-") {
			t.Fatal("old version retained")
		}
	}
	active, e := filepath.EvalSymlinks(filepath.Join(bin, "convorel"))
	if e != nil || !strings.Contains(active, "1.2.0-") {
		t.Fatalf("wrong active: %s %v", active, e)
	}
	// A tampered archive must leave the current link and both retained releases intact.
	put(t, filepath.Join(dist, "sha256sums.txt"), strings.Repeat("0", 64)+"  convorel-1.2.0-"+platform+".tar.gz\n", 0600)
	if e = exec.Command("bash", installer, "--dist-dir", dist, "--prefix", prefix, "--bin-dir", bin).Run(); e == nil {
		t.Fatal("bad checksum accepted")
	}
	after, e := filepath.EvalSymlinks(filepath.Join(bin, "convorel"))
	if e != nil || after != active {
		t.Fatal("failed install changed active link")
	}
}
func TestSkillsInstallPreservesExisting(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	target := filepath.Join(home, ".agents", "skills", "chatgpt-review")
	old := skillFiles
	skillFiles = map[string]string{"SKILL.md": "review", "references/note.md": "note"}
	defer func() { skillFiles = old }()
	if _, e := InstallSkill(""); e != nil {
		t.Fatal(e)
	}
	put(t, filepath.Join(target, "SKILL.md"), "personal", 0600)
	if _, e := InstallSkill(target); e == nil {
		t.Fatal("overwrote personal skill")
	}
	b, e := os.ReadFile(filepath.Join(target, "SKILL.md"))
	if e != nil || string(b) != "personal" {
		t.Fatal("personal skill changed")
	}
}
