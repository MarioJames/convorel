package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitWorktreeRequiresAllowedMetadataAndRefusesAlternates(t *testing.T) {
	requireGit(t)
	base := t.TempDir()
	sources := filepath.Join(base, "sources")
	work := filepath.Join(base, "work")
	repo := filepath.Join(sources, "repo")
	checkout := filepath.Join(work, "checkout")
	for _, path := range []string{repo, work} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, repo, "init", "-q")
	put(t, repo, "code.ts", "before\n")
	commitAll(t, repo, "fixture")
	runGit(t, repo, "worktree", "add", "-qb", "fixture", checkout)
	put(t, checkout, "code.ts", "after\n")
	allowed, err := NewAccess([]string{sources, work})
	if err != nil {
		t.Fatal(err)
	}
	checkoutIdentity, err := allowed.Identity(checkout)
	if err != nil {
		t.Fatal(err)
	}
	fileIdentity, err := allowed.Identity(filepath.Join(checkout, "code.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if checkoutIdentity != fileIdentity || checkoutIdentity.WorkspacePath != checkout || checkoutIdentity.RootID != allowed.Roots[1].ID {
		t.Fatalf("unexpected worktree identity: %#v %#v", checkoutIdentity, fileIdentity)
	}
	repoIdentity, err := allowed.Identity(repo)
	if err != nil {
		t.Fatal(err)
	}
	if checkoutIdentity.WorkspaceID == repoIdentity.WorkspaceID {
		t.Fatal("worktree and main repository share identity")
	}
	directory, err := allowed.Directory(checkout)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := directory.Diff("unstaged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff["diff"].(string), "+after") {
		t.Fatalf("worktree diff failed: %v", diff["diff"])
	}
	restricted, err := NewAccess([]string{work})
	if err != nil {
		t.Fatal(err)
	}
	restrictedDir, err := restricted.Directory(checkout)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restrictedDir.Status(0, 200); !HasCode(err, "GIT_STORAGE_OUTSIDE_ROOTS") {
		t.Fatalf("status: %v", err)
	}
	if _, err := restrictedDir.Diff("unstaged", DiffOptions{}); !HasCode(err, "GIT_STORAGE_OUTSIDE_ROOTS") {
		t.Fatalf("diff: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".git/objects/info/alternates"), []byte("/unapproved/objects\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := directory.Diff("unstaged", DiffOptions{}); !HasCode(err, "GIT_ALTERNATES_UNSUPPORTED") {
		t.Fatalf("worktree alternates: %v", err)
	}
	repoDir, err := allowed.Directory(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repoDir.Status(0, 200); !HasCode(err, "GIT_ALTERNATES_UNSUPPORTED") {
		t.Fatalf("repo alternates: %v", err)
	}
}

func TestGitStorageLinksAndSpecialFilesAreDenied(t *testing.T) {
	requireGit(t)
	for _, location := range []string{"loose-file", "loose-directory", "pack-file", "pack-index", "pack-directory", "loose-hardlink", "pack-hardlink"} {
		t.Run(location, func(t *testing.T) {
			dir := t.TempDir()
			runGit(t, dir, "init", "-q")
			put(t, dir, "public.txt", "OBJECT_SENTINEL\n")
			commitAll(t, dir, "base")
			workspace, err := NewWorkspace(dir)
			if err != nil {
				t.Fatal(err)
			}
			target := ""
			if strings.HasPrefix(location, "pack") {
				runGit(t, dir, "repack", "-ad")
				packs := filepath.Join(dir, ".git/objects/pack")
				if location == "pack-directory" {
					target = packs
				} else {
					entries, err := os.ReadDir(packs)
					if err != nil {
						t.Fatal(err)
					}
					suffix := ".pack"
					if location == "pack-index" {
						suffix = ".idx"
					}
					for _, entry := range entries {
						if strings.HasSuffix(entry.Name(), suffix) {
							target = filepath.Join(packs, entry.Name())
						}
					}
				}
			} else {
				oid := runGit(t, dir, "rev-parse", "HEAD:public.txt")
				target = filepath.Join(dir, ".git/objects", oid[:2], oid[2:])
				if location == "loose-directory" {
					target = filepath.Dir(target)
				}
			}
			if target == "" {
				t.Fatal("fixture target missing")
			}
			if _, err := workspace.History().Read(ReadOptions{FilePath: "public.txt"}); err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "external-object")
			if err := os.Rename(target, outside); err != nil {
				t.Fatal(err)
			}
			if strings.HasSuffix(location, "hardlink") {
				if err := os.Link(outside, target); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Symlink(outside, target); err != nil {
				t.Fatal(err)
			}
			if runGit(t, dir, "show", "HEAD:public.txt") != "OBJECT_SENTINEL" {
				t.Fatal("git itself no longer accepts redirected storage")
			}
			if _, err := workspace.History().Read(ReadOptions{FilePath: "public.txt"}); !HasCode(err, "GIT_STORAGE_LINK_DENIED") {
				t.Fatalf("read: %v", err)
			}
			if _, err := workspace.Status(0, 200); !HasCode(err, "GIT_STORAGE_LINK_DENIED") {
				t.Fatalf("status: %v", err)
			}
			if _, err := workspace.Diff("unstaged", DiffOptions{}); !HasCode(err, "GIT_STORAGE_LINK_DENIED") {
				t.Fatalf("diff: %v", err)
			}
			info, err := workspace.Info()
			if err != nil {
				t.Fatal(err)
			}
			if info["gitError"] != "GIT_STORAGE_LINK_DENIED" {
				t.Fatalf("gitError=%v", info["gitError"])
			}
		})
	}
}

func TestGitObjectStorageRefusesSpecialFilesAndDepthOverflow(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q")
	put(t, dir, "public.txt", "OBJECT_SENTINEL\n")
	commitAll(t, dir, "base")
	objects := filepath.Join(dir, ".git/objects")
	fifo := filepath.Join(objects, "pack/unsafe.pipe")
	if err := execMkfifo(fifo); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Status(0, 200); !HasCode(err, "GIT_STORAGE_NOT_REGULAR") {
		t.Fatalf("fifo: %v", err)
	}
	if err := os.Remove(fifo); err != nil {
		t.Fatal(err)
	}
	deep := objects
	for i := 0; i < 9; i++ {
		deep = filepath.Join(deep, "nested")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Status(0, 200); !HasCode(err, "GIT_STORAGE_SCAN_LIMIT") {
		t.Fatalf("depth: %v", err)
	}
}

func TestOrdinaryManyObjectRepositoryRemainsReadable(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q")
	put(t, dir, "public.txt", "OBJECT_SENTINEL\n")
	commitAll(t, dir, "base")
	for i := 0; i < 1500; i++ {
		put(t, dir, "sources/"+itoa(i)+".txt", "unique fixture "+itoa(i)+"\n")
	}
	runGit(t, dir, "add", "sources")
	runGit(t, dir, "commit", "-qm", "many loose objects")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	read, err := workspace.History().Read(ReadOptions{FilePath: "sources/1499.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if read["content"] != "unique fixture 1499" {
		t.Fatalf("unexpected content: %v", read["content"])
	}
	status, err := workspace.Status(0, 200)
	if err != nil || status["dirty"] != false {
		t.Fatalf("status=%v err=%v", status, err)
	}
	runGit(t, dir, "repack", "-ad")
	read, err = workspace.History().Read(ReadOptions{FilePath: "sources/1499.txt"})
	if err != nil || read["content"] != "unique fixture 1499" {
		t.Fatalf("packed read=%v err=%v", read, err)
	}
	diff, err := workspace.Diff("unstaged", DiffOptions{})
	if err != nil || len(diff["files"].([]DiffFile)) != 0 {
		t.Fatalf("diff=%v err=%v", diff, err)
	}
}

func TestUnmergedDiffProvidesStageEvidence(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	put(t, dir, "conflict.txt", "base\n")
	put(t, dir, "other.txt", "old\n")
	put(t, dir, ".env", "SECRET_BASE\n")
	runGit(t, dir, "add", "-f", "conflict.txt", "other.txt", ".env")
	runGit(t, dir, "commit", "-qm", "base conflict")
	runGit(t, dir, "checkout", "-qb", "side")
	put(t, dir, "conflict.txt", "theirs\n")
	put(t, dir, ".env", "SECRET_THEIRS\n")
	runGit(t, dir, "commit", "-qam", "side")
	runGit(t, dir, "checkout", "main")
	put(t, dir, "conflict.txt", "ours\n")
	put(t, dir, ".env", "SECRET_OURS\n")
	runGit(t, dir, "commit", "-qam", "main")
	if result := gitAllowFail(t, dir, "merge", "--no-edit", "side"); result == 0 {
		t.Fatal("merge unexpectedly succeeded")
	}
	put(t, dir, "other.txt", "new\n")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	status, err := workspace.Status(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range status["entries"].([]statusEntry) {
		if entry.Path == "conflict.txt" && entry.Change == "UU" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing UU status: %#v", status["entries"])
	}
	for _, mode := range []string{"unstaged", "staged"} {
		result, err := workspace.Diff(mode, DiffOptions{})
		if err != nil {
			t.Fatal(err)
		}
		files := result["files"].([]DiffFile)
		var conflictFiles []DiffFile
		for _, file := range files {
			if file.Path == "conflict.txt" {
				conflictFiles = append(conflictFiles, file)
			}
		}
		if len(conflictFiles) != 1 || conflictFiles[0].Change != "U" || conflictFiles[0].PreviousPath != nil {
			t.Fatalf("%s: unexpected conflict files %#v", mode, conflictFiles)
		}
		if result["patchFile"] != "conflict.txt" || !strings.Contains(result["diff"].(string), "Unmerged") {
			t.Fatalf("%s: unexpected patch %#v", mode, result["patchFile"])
		}
		for stage := 1; stage <= 3; stage++ {
			oid := runGit(t, dir, "rev-parse", ":"+itoa(stage)+":conflict.txt")
			if !strings.Contains(result["diff"].(string), oid) {
				t.Fatalf("%s: missing stage %d", mode, stage)
			}
		}
		encoded := mustJSON(t, result)
		if strings.Contains(encoded, "SECRET_") || strings.Contains(encoded, `"path":".env"`) {
			t.Fatalf("%s: disclosed protected path", mode)
		}
	}
	other, err := workspace.Diff("unstaged", DiffOptions{PatchFile: stringPtr("other.txt")})
	if err != nil || !strings.Contains(other["diff"].(string), "+new") {
		t.Fatalf("ordinary patch: %v %v", other, err)
	}
	head, err := workspace.Diff("head", DiffOptions{PatchFile: stringPtr("conflict.txt")})
	if err != nil || !strings.Contains(head["diff"].(string), "<<<<<<<") {
		t.Fatalf("head patch: %v %v", head, err)
	}
	first, err := workspace.Diff("unstaged", DiffOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first["nextOffset"] != 1 {
		t.Fatalf("unexpected cursor: %#v", first["nextOffset"])
	}
	second, err := workspace.Diff("unstaged", DiffOptions{Offset: 1, Limit: 1})
	if err != nil || second["patchFile"] != "other.txt" {
		t.Fatalf("second page: %#v %v", second, err)
	}
	suffix, err := workspace.Diff("unstaged", DiffOptions{PatchFile: stringPtr("conflict.txt"), PatchOffset: 12})
	if err != nil {
		t.Fatal(err)
	}
	if suffix["patchSha256"] != first["patchSha256"] || suffix["diff"] != first["diff"].(string)[12:] {
		t.Fatalf("suffix mismatch: %#v", suffix)
	}
	runGit(t, dir, "add", "conflict.txt")
	staged, err := workspace.Diff("staged", DiffOptions{PatchFile: stringPtr("conflict.txt")})
	if err != nil || !strings.Contains(staged["diff"].(string), "+<<<<<<<") {
		t.Fatalf("resolved staged patch: %v %v", staged, err)
	}
}

func TestDeleteModifyConflictPreservesMissingStages(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	path := "conflict\n\"quoted\".txt"
	put(t, dir, path, "base\n")
	runGit(t, dir, "add", path)
	runGit(t, dir, "commit", "-qm", "base")
	runGit(t, dir, "checkout", "-qb", "side")
	put(t, dir, path, "theirs\n")
	runGit(t, dir, "commit", "-qam", "modify")
	runGit(t, dir, "checkout", "main")
	runGit(t, dir, "rm", path)
	runGit(t, dir, "commit", "-qm", "delete")
	if result := gitAllowFail(t, dir, "merge", "--no-edit", "side"); result == 0 {
		t.Fatal("merge unexpectedly succeeded")
	}
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"unstaged", "staged"} {
		result, err := workspace.Diff(mode, DiffOptions{})
		if err != nil {
			t.Fatal(err)
		}
		files := result["files"].([]DiffFile)
		if len(files) != 1 || files[0].Path != path || files[0].Change != "U" {
			t.Fatalf("%s: unexpected files %#v", mode, files)
		}
		text := result["diff"].(string)
		for _, expected := range []string{`"` + "conflict\\n\\\"quoted\\\".txt" + `"`, "base (stage 1)", "theirs (stage 3)"} {
			if !strings.Contains(text, expected) {
				t.Fatalf("%s: missing %q in %s", mode, expected, text)
			}
		}
		if strings.Contains(text, "ours (stage 2)") {
			t.Fatalf("%s: invented stage 2", mode)
		}
		if !strings.Contains(text, runGit(t, dir, "rev-parse", ":3:"+path)) {
			t.Fatalf("%s: missing stage 3 oid", mode)
		}
	}
}

func execMkfifo(path string) error {
	return runCommand("mkfifo", path)
}

func gitAllowFail(t *testing.T, dir string, args ...string) int {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
	_ = cmd.Run()
	return cmd.ProcessState.ExitCode()
}

func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	return cmd.Run()
}
