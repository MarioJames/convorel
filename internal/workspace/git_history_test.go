package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func historyFixture(t *testing.T) (*Workspace, *History) {
	t.Helper()
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	return workspace, workspace.History()
}

func commitAll(t *testing.T, dir, subject string) string {
	t.Helper()
	runGit(t, dir, "add", "-f", ".")
	runGit(t, dir, "commit", "-qm", subject)
	return runGit(t, dir, "rev-parse", "HEAD")
}

func TestHistoryCleanWorktreeRootCommitAndShallowFlag(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "code.ts", "first\n")
	sha := commitAll(t, workspace.Root, "initial")
	log, err := history.Log(LogOptions{})
	if err != nil {
		t.Fatal(err)
	}
	commits := log["commits"].([]Commit)
	if len(commits) != 1 || commits[0].SHA != sha || len(commits[0].Parents) != 0 || commits[0].Subject != "initial" {
		t.Fatalf("unexpected log: %#v", log)
	}
	if log["shallow"] != false {
		t.Fatal("expected non-shallow")
	}
	show, err := history.Show(ShowOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if show["effectiveBase"] != nil {
		t.Fatalf("root commit compared to a base: %#v", show["effectiveBase"])
	}
	files := show["files"].([]historyFile)
	if len(files) != 1 || files[0].Additions != 1 {
		t.Fatalf("unexpected files: %#v", files)
	}
	patch := show["patch"].(map[string]any)
	if !strings.Contains(patch["text"].(string), "+first") || patch["nextOffset"] != nil {
		t.Fatalf("unexpected patch: %#v", patch)
	}
}

func TestHistoryCommitMessagePagination(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "code.ts", "first\n")
	message := "subject\n\n" + strings.Repeat("Reason: 中😀\n", 2500)
	if err := os.WriteFile(filepath.Join(workspace.Root, "code.ts"), []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, workspace.Root, "add", ".")
	runGit(t, workspace.Root, "commit", "-qm", message)
	sha := runGit(t, workspace.Root, "rev-parse", "HEAD")
	offset := 0
	received := ""
	for {
		show, err := history.Show(ShowOptions{Ref: sha, MessageOffset: offset})
		if err != nil {
			t.Fatal(err)
		}
		if JSONSize(show) > 56*1024 {
			t.Fatalf("show exceeded budget: %d", JSONSize(show))
		}
		body := show["message"].(map[string]any)
		received += body["text"].(string)
		if body["nextOffset"] == nil {
			break
		}
		next := body["nextOffset"].(int)
		if next <= offset {
			t.Fatalf("non-progressing message cursor")
		}
		offset = next
	}
	if received != message {
		t.Fatalf("message reconstruction mismatch: %d vs %d bytes", len(received), len(message))
	}
}

func TestHistoryMergeParentsAndComparisonModes(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "root.txt", "root\n")
	root := commitAll(t, workspace.Root, "root")
	runGit(t, workspace.Root, "checkout", "-qb", "side")
	put(t, workspace.Root, "side.txt", "side\n")
	side := commitAll(t, workspace.Root, "side")
	runGit(t, workspace.Root, "checkout", "main")
	put(t, workspace.Root, "main.txt", "main\n")
	main := commitAll(t, workspace.Root, "main")
	direct, err := history.Compare(CompareOptions{Base: "main", Head: "side", Mode: "direct"})
	if err != nil {
		t.Fatal(err)
	}
	directFiles := direct["files"].([]historyFile)
	if len(directFiles) != 2 || direct["effectiveBase"] != main {
		t.Fatalf("unexpected direct comparison: %#v", direct)
	}
	merge, err := history.Compare(CompareOptions{Base: "main", Head: "side", Mode: "merge-base"})
	if err != nil {
		t.Fatal(err)
	}
	if merge["effectiveBase"] != root || len(merge["mergeBases"].([]string)) != 1 {
		t.Fatalf("unexpected merge-base comparison: %#v", merge)
	}
	runGit(t, workspace.Root, "merge", "--no-ff", "-qm", "merge", "side")
	first, err := history.Show(ShowOptions{Parent: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(first["files"].([]historyFile)) != 1 || first["files"].([]historyFile)[0].Path != "side.txt" {
		t.Fatalf("unexpected parent 1: %#v", first["files"])
	}
	second, err := history.Show(ShowOptions{Parent: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(second["files"].([]historyFile)) != 1 || second["files"].([]historyFile)[0].Path != "main.txt" {
		t.Fatalf("unexpected parent 2: %#v", second["files"])
	}
	if _, err := history.Show(ShowOptions{Parent: 3}); err == nil {
		t.Fatal("missing parent accepted")
	}
	_ = side
}

func TestHistoryDeletedFileReadAndRenamePolicies(t *testing.T) {
	workspace, history := historyFixture(t)
	content := []byte("你好\r\nnext\n")
	if err := os.WriteFile(filepath.Join(workspace.Root, "deleted.txt"), content, 0o644); err != nil {
		t.Fatal(err)
	}
	put(t, workspace.Root, ".env", "SECRET_SENTINEL\n")
	put(t, workspace.Root, ".convorelignore", "private.txt\n")
	put(t, workspace.Root, "private.txt", "HISTORICAL_SECRET\n")
	sha := commitAll(t, workspace.Root, "add")
	runGit(t, workspace.Root, "rm", "deleted.txt")
	runGit(t, workspace.Root, "mv", ".env", "public.txt")
	runGit(t, workspace.Root, "mv", "private.txt", "renamed.txt")
	runGit(t, workspace.Root, "rm", ".convorelignore")
	head := commitAll(t, workspace.Root, "delete and rename")
	read, err := history.Read(ReadOptions{Ref: sha, FilePath: "deleted.txt", StartLine: 2, MaxLines: 1})
	if err != nil {
		t.Fatal(err)
	}
	if read["content"] != "next" || read["commit"] != sha {
		t.Fatalf("unexpected read: %#v", read)
	}
	sum := sha256.Sum256(content)
	if read["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatal("blob hash mismatch")
	}
	if _, err := history.Read(ReadOptions{FilePath: "deleted.txt"}); err == nil {
		t.Fatal("deleted file readable at HEAD")
	}
	comparison, err := history.Compare(CompareOptions{Base: sha, Head: head})
	if err != nil {
		t.Fatal(err)
	}
	if comparison["summary"].(map[string]any)["hiddenFiles"] != 2 {
		t.Fatalf("unexpected hidden files: %#v", comparison["summary"])
	}
	encoded := mustJSON(t, comparison)
	for _, secret := range []string{"SECRET_SENTINEL", "HISTORICAL_SECRET", "public.txt", "renamed.txt"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("comparison disclosed %q", secret)
		}
	}
	if _, err := history.Read(ReadOptions{Ref: sha, FilePath: "private.txt"}); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("historical private read: %v", err)
	}
	if _, err := history.Compare(CompareOptions{Base: sha, Head: head, PatchFile: stringPtr("renamed.txt")}); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("historical patch read: %v", err)
	}
}

func TestHistoryMalformedPolicyAndIgnoredAncestorsFailClosed(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "nested/code.ts", "SECRET\n")
	put(t, workspace.Root, "nested/.gitignore", "code.ts\n")
	ignored := commitAll(t, workspace.Root, "historically ignored")
	runGit(t, workspace.Root, "rm", "nested/.gitignore")
	commitAll(t, workspace.Root, "remove policy")
	if _, err := history.Read(ReadOptions{Ref: ignored, FilePath: "nested/code.ts"}); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("historical ignore: %v", err)
	}
	for _, kind := range []string{"symlink", "large", "binary"} {
		switch kind {
		case "symlink":
			if err := os.Remove(filepath.Join(workspace.Root, "nested/.gitignore")); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if err := os.Symlink("code.ts", filepath.Join(workspace.Root, "nested/.gitignore")); err != nil {
				t.Fatal(err)
			}
		case "large":
			put(t, workspace.Root, "nested/.gitignore", strings.Repeat("x", 65537))
		case "binary":
			if err := os.WriteFile(filepath.Join(workspace.Root, "nested/.gitignore"), []byte{0, 1, 2}, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		bad := commitAll(t, workspace.Root, kind)
		runGit(t, workspace.Root, "rm", "nested/.gitignore")
		commitAll(t, workspace.Root, "remove "+kind)
		if _, err := history.Read(ReadOptions{Ref: bad, FilePath: "nested/code.ts"}); !HasCode(err, "POLICY_UNREADABLE") {
			t.Fatalf("%s policy: %v", kind, err)
		}
	}
}

func TestHistoryInvalidRefsPathsAndStrictInputs(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "a.txt", "a\n")
	commitAll(t, workspace.Root, "root")
	for _, ref := range []string{"missing", "--all", "HEAD:a.txt", "HEAD\x00", "HEAD --all"} {
		if _, err := history.Show(ShowOptions{Ref: ref}); err == nil {
			t.Errorf("ref %q accepted", ref)
		}
	}
	for _, path := range []string{"../a", "/etc/passwd", "a\\b", ".env"} {
		if _, err := history.Read(ReadOptions{FilePath: path}); err == nil {
			t.Errorf("path %q accepted", path)
		}
	}
	if _, err := history.Compare(CompareOptions{Base: "HEAD", Mode: "linear"}); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if _, err := history.Log(LogOptions{Limit: 101}); err == nil {
		t.Fatal("limit 101 accepted")
	}
}

func TestHistoryLogAndComparisonPaginationReconstructPatch(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "large.txt", "before\n")
	base := commitAll(t, workspace.Root, "base")
	lines := make([]string, 2500)
	for i := range lines {
		lines[i] = strconv.Itoa(i) + ":" + strings.Repeat(`中\"`, 8)
	}
	content := strings.Join(lines, "\n") + "\n"
	put(t, workspace.Root, "large.txt", content)
	put(t, workspace.Root, "second.txt", "second\n")
	head := commitAll(t, workspace.Root, "change")
	first, err := history.Log(LogOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first["nextOffset"] != 1 {
		t.Fatalf("unexpected log page: %#v", first)
	}
	older, err := history.Log(LogOptions{Ref: first["resolvedRef"].(string), Offset: 1, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if older["commits"].([]Commit)[0].SHA != base {
		t.Fatal("log cursor did not advance")
	}
	page, err := history.Compare(CompareOptions{Base: base, Head: head, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page["files"].([]historyFile)) != 1 || page["nextOffset"] != 1 {
		t.Fatalf("unexpected first comparison page: %#v", page)
	}
	other, err := history.Compare(CompareOptions{Base: base, Head: head, Offset: 1, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if other["files"].([]historyFile)[0].Path != "second.txt" {
		t.Fatalf("unexpected second file: %#v", other["files"])
	}
	patch := ""
	sha := ""
	next := 0
	for rounds := 0; ; rounds++ {
		if rounds > 100 {
			t.Fatal("non-progressing patch cursor")
		}
		page, err := history.Compare(CompareOptions{Base: base, Head: head, Limit: 1, PatchFile: stringPtr("large.txt"), PatchOffset: next})
		if err != nil {
			t.Fatal(err)
		}
		if JSONSize(page) > 56*1024 {
			t.Fatalf("comparison exceeded budget: %d", JSONSize(page))
		}
		fragment := page["patch"].(map[string]any)
		if fragment["text"].(string) == "" {
			t.Fatal("empty patch fragment")
		}
		patch += fragment["text"].(string)
		if sha == "" {
			sha = fragment["sha256"].(string)
		} else if sha != fragment["sha256"].(string) {
			t.Fatal("patch hash changed between pages")
		}
		if fragment["nextOffset"] == nil {
			break
		}
		next = fragment["nextOffset"].(int)
	}
	if !strings.Contains(patch, "+2499:") {
		t.Fatalf("patch tail missing (len %d): %q", len(patch), tail(patch, 500))
	}
	sum := sha256.Sum256([]byte(patch))
	if hex.EncodeToString(sum[:]) != sha {
		t.Fatal("patch hash mismatch")
	}
}

func TestHistoryRefusesBinarySymlinkGitlinkAndOversizedBlobs(t *testing.T) {
	workspace, history := historyFixture(t)
	if err := os.WriteFile(filepath.Join(workspace.Root, "binary.dat"), []byte{1, 0, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace.Root, "invalid.txt"), []byte{0xff, 0xfe}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace.Root, "large.txt"), []byte(strings.Repeat("x", 1024*1024+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("binary.dat", filepath.Join(workspace.Root, "link")); err != nil {
		t.Fatal(err)
	}
	root := commitAll(t, workspace.Root, "bad objects")
	runGit(t, workspace.Root, "update-index", "--add", "--cacheinfo", "160000,"+root+",submodule")
	runGit(t, workspace.Root, "commit", "-qm", "gitlink")
	for _, path := range []string{"binary.dat", "invalid.txt", "large.txt", "link", "submodule"} {
		if _, err := history.Read(ReadOptions{FilePath: path}); err == nil {
			t.Errorf("%q was readable", path)
		}
	}
	if _, err := history.Show(ShowOptions{Ref: root}); !HasCode(err, "GIT_INVALID_UTF8") {
		t.Fatalf("got %v, want GIT_INVALID_UTF8", err)
	}
}

func TestHistoryShallowPreservesParentsAndRefusesMissingBase(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "a.txt", "before\n")
	base := commitAll(t, workspace.Root, "before")
	put(t, workspace.Root, "a.txt", "after\n")
	head := commitAll(t, workspace.Root, "after")
	if err := os.WriteFile(filepath.Join(workspace.Root, ".git/shallow"), []byte(head+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	log, err := history.Log(LogOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if log["shallow"] != true || len(log["commits"].([]Commit)) != 1 || log["commits"].([]Commit)[0].Parents[0] != base {
		t.Fatalf("unexpected shallow log: %#v", log)
	}
	show, err := history.Show(ShowOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if show["base"] != base {
		t.Fatalf("unexpected shallow base: %#v", show["base"])
	}
	if err := os.RemoveAll(filepath.Join(workspace.Root, ".git/objects", base[:2])); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Show(ShowOptions{}); err == nil {
		t.Fatal("missing parent object accepted")
	}
}

func TestHistoryLiteralFilenames(t *testing.T) {
	workspace, history := historyFixture(t)
	for _, path := range []string{"[a]*.txt", "tab\tname.txt", "line\nname.txt", "中文.txt"} {
		put(t, workspace.Root, path, path+"\n")
	}
	commitAll(t, workspace.Root, "odd paths")
	for _, path := range []string{"[a]*.txt", "tab\tname.txt", "line\nname.txt", "中文.txt"} {
		read, err := history.Read(ReadOptions{FilePath: path})
		if err != nil {
			t.Fatalf("read %q: %v", path, err)
		}
		if read["filePath"] != path {
			t.Fatalf("path changed: %#v", read["filePath"])
		}
		show, err := history.Show(ShowOptions{PatchFile: stringPtr(path)})
		if err != nil {
			t.Fatalf("show %q: %v", path, err)
		}
		if show["patch"].(map[string]any)["filePath"] != path {
			t.Fatalf("patch path changed: %#v", show["patch"])
		}
	}
}

func TestHistoryNeverRunsExternalDiffOrTextconv(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, ".gitattributes", "*.txt diff=custom\n")
	put(t, workspace.Root, "code.txt", "before\n")
	base := commitAll(t, workspace.Root, "base")
	put(t, workspace.Root, "code.txt", "after\n")
	commitAll(t, workspace.Root, "after")
	runGit(t, workspace.Root, "config", "diff.external", "touch external-marker")
	runGit(t, workspace.Root, "config", "diff.custom.textconv", "touch textconv-marker")
	result, err := history.Compare(CompareOptions{Base: base})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result["patch"].(map[string]any)["text"].(string), "+after") {
		t.Fatal("missing patch")
	}
	for _, marker := range []string{"external-marker", "textconv-marker"} {
		if _, err := os.Stat(filepath.Join(workspace.Root, marker)); err == nil {
			t.Fatalf("%s ran", marker)
		}
	}
}

func TestHistoryReadyDenialWinsBeforeAnyGitCall(t *testing.T) {
	calls := 0
	history := &History{access: historyAccess{
		root:      "/nonexistent",
		id:        "id",
		normalize: func(p string) (string, error) { return p, nil },
		allowed:   func(string, bool) (bool, error) { return true, nil },
		ready:     func() error { return Fail("DENIED") },
		git: func([]string) ([]byte, error) {
			calls++
			return nil, nil
		},
	}}
	for name, call := range map[string]func() error{
		"log":     func() error { _, err := history.Log(LogOptions{}); return err },
		"show":    func() error { _, err := history.Show(ShowOptions{}); return err },
		"compare": func() error { _, err := history.Compare(CompareOptions{Base: "HEAD"}); return err },
		"read":    func() error { _, err := history.Read(ReadOptions{FilePath: "a"}); return err },
	} {
		if err := call(); !HasCode(err, "DENIED") {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if calls != 0 {
		t.Fatalf("git called %d times before ready denial", calls)
	}
}

func TestHistoryFixedRevisionTreeLimits(t *testing.T) {
	sha := strings.Repeat("a", 40)
	makeOutput := func(count int) []byte {
		var b strings.Builder
		for i := 0; i < count; i++ {
			b.WriteString("100644 blob " + sha + " 1\tcode-" + itoa(i) + ".ts\x00")
		}
		return []byte(b.String())
	}
	access := historyAccess{
		normalize: func(p string) (string, error) { return p, nil },
		git:       func([]string) ([]byte, error) { return makeOutput(30000), nil },
	}
	access.git = func([]string) ([]byte, error) { return makeOutput(20001), nil }
	if tree, err := newObservation(access).tree(sha); err != nil || len(tree) != 20001 {
		t.Fatalf("20001 files: %v, %d", err, len(tree))
	}
	access.git = func([]string) ([]byte, error) { return makeOutput(30000), nil }
	if tree, err := newObservation(access).tree(sha); err != nil || len(tree) != 30000 {
		t.Fatalf("30000 files: %v, %d", err, len(tree))
	}
	access.git = func([]string) ([]byte, error) { return makeOutput(30001), nil }
	if _, err := newObservation(access).tree(sha); !HasCode(err, "GIT_HISTORY_TREE_LIMIT") {
		t.Fatalf("got %v, want GIT_HISTORY_TREE_LIMIT", err)
	}
}

func TestHistoryFileToDirectoryPatchDoesNotLeakDescendants(t *testing.T) {
	workspace, history := historyFixture(t)
	put(t, workspace.Root, "source", "old source\n")
	base := commitAll(t, workspace.Root, "file")
	runGit(t, workspace.Root, "rm", "source")
	put(t, workspace.Root, "source/.env", "DESCENDANT_SECRET\n")
	put(t, workspace.Root, "source/public.txt", "public\n")
	head := commitAll(t, workspace.Root, "directory")
	result, err := history.Compare(CompareOptions{Base: base, Head: head, PatchFile: stringPtr("source")})
	if err != nil {
		t.Fatal(err)
	}
	text := result["patch"].(map[string]any)["text"].(string)
	if !strings.Contains(text, "-old source") || strings.Contains(text, "DESCENDANT_SECRET") || strings.Contains(text, "+public") {
		t.Fatalf("unexpected patch: %s", text)
	}
}

func TestHistoryDoesNotInvokeSignatureVerifier(t *testing.T) {
	workspace, _ := historyFixture(t)
	put(t, workspace.Root, "code.ts", "first\n")
	parent := commitAll(t, workspace.Root, "base")
	tree := runGit(t, workspace.Root, "rev-parse", "HEAD^{tree}")
	signedText := "tree " + tree + "\nparent " + parent + "\nauthor Fixture <fixture@example.invalid> 1600000000 +0000\ncommitter Fixture <fixture@example.invalid> 1600000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n ZmFrZQ==\n -----END PGP SIGNATURE-----\n\nsigned fixture\n"
	if err := os.WriteFile(filepath.Join(workspace.Root, "signed-commit.txt"), []byte(signedText), 0o644); err != nil {
		t.Fatal(err)
	}
	signed := runGit(t, workspace.Root, "hash-object", "-t", "commit", "-w", filepath.Join(workspace.Root, "signed-commit.txt"))
	verifier := filepath.Join(workspace.Root, "verifier")
	if err := os.WriteFile(verifier, []byte("#!/bin/sh\nprintf called > \"$0.called\"\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, workspace.Root, "config", "log.showSignature", "true")
	runGit(t, workspace.Root, "config", "gpg.program", verifier)
	history := workspace.History()
	if _, err := history.Log(LogOptions{Ref: signed}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(verifier + ".called"); err == nil {
		t.Fatal("signature verifier ran")
	}
}

func stringPtr(value string) *string { return &value }

func tail(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[len(value)-n:]
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	out := []byte{}
	for value > 0 {
		out = append([]byte{byte('0' + value%10)}, out...)
		value /= 10
	}
	return string(out)
}

func TestHistoryContinuesPastTenThousandCommits(t *testing.T) {
	workspace, history := historyFixture(t)
	chunks := make([]string, 0, 10003)
	for i := 1; i <= 10003; i++ {
		parent := ""
		if i > 1 {
			parent = "from :" + strconv.Itoa(i-1) + "\n"
		}
		chunks = append(chunks, "commit refs/heads/main\nmark :"+strconv.Itoa(i)+
			"\ncommitter Fixture <fixture@example.invalid> "+strconv.Itoa(1600000000+i)+" +0000\ndata 1\nx\n"+parent+"\n")
	}
	cmd := exec.Command("git", "-C", workspace.Root, "fast-import", "--quiet")
	cmd.Stdin = strings.NewReader(strings.Join(chunks, ""))
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fast-import: %v\n%s", err, out)
	}
	page, err := history.Log(LogOptions{Offset: 10000, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page["nextOffset"] != 10001 {
		t.Fatalf("unexpected cursor: %#v", page["nextOffset"])
	}
	next, err := history.Log(LogOptions{Ref: page["resolvedRef"].(string), Offset: 10001, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if next["commits"].([]Commit)[0].SHA == page["commits"].([]Commit)[0].SHA {
		t.Fatal("cursor did not advance")
	}
}
