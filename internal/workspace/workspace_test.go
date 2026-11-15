package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func requireGit(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not installed")
	}
	return path
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=Fixture",
		"GIT_AUTHOR_EMAIL=fixture@example.invalid",
		"GIT_COMMITTER_NAME=Fixture",
		"GIT_COMMITTER_EMAIL=fixture@example.invalid",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func put(t *testing.T, root, path, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readContent(t *testing.T, workspace *Workspace, path string) string {
	t.Helper()
	result, err := workspace.Read(path, 1, 400)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return result["content"].(string)
}

func TestSharedPolicyBlocksSecretsTraversalSymlinksAndIgnoredContents(t *testing.T) {
	dir := t.TempDir()
	put(t, dir, "code.ts", "hello\nworld\n")
	put(t, dir, ".env", "SECRET_SENTINEL")
	put(t, dir, ".gitignore", "private/\n")
	put(t, dir, "private/code.ts", "SECRET_SENTINEL")
	if err := os.Symlink(filepath.Join(dir, ".env"), filepath.Join(dir, "alias.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", filepath.Join(dir, "outside")); err != nil {
		t.Fatal(err)
	}
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../etc/passwd", "/etc/passwd", ".env", "alias.txt", "outside/passwd", "private/code.ts"} {
		if _, err := workspace.Read(path, 1, 400); err == nil {
			t.Errorf("read(%q) succeeded, want denial", path)
		}
	}
	listing, err := workspace.List(".", 1, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	encoded := mustJSON(t, listing)
	for _, secret := range []string{".env", "alias", "private"} {
		if strings.Contains(encoded, secret) {
			t.Errorf("listing disclosed %q: %s", secret, encoded)
		}
	}
	search, err := workspace.Search("SECRET_SENTINEL", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if matches := search["matches"].([]SearchMatch); len(matches) != 0 {
		t.Fatalf("search disclosed ignored content: %v", matches)
	}
	page, err := workspace.Read("code.ts", 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page["content"] != "world" || page["startLine"] != 2 || len(page["sha256"].(string)) != 64 {
		t.Fatalf("unexpected page: %#v", page)
	}
}

func TestNestedIgnoreByteBudgetsLiteralSearchAndChangedRoot(t *testing.T) {
	dir := t.TempDir()
	put(t, dir, "src/.gitignore", "hidden.ts\n")
	put(t, dir, "src/hidden.ts", "secret")
	put(t, dir, "src/visible.ts", "a.*b\n")
	put(t, dir, "big.txt", strings.Repeat("x", 2*1024*1024))
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"src/hidden.ts", "big.txt"} {
		if _, err := workspace.Read(path, 1, 400); err == nil {
			t.Errorf("read(%q) succeeded", path)
		}
	}
	if _, err := workspace.Read("src/visible.ts", 0, 10); err == nil {
		t.Error("startLine 0 accepted")
	}
	search, err := workspace.Search(".*", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if matches := search["matches"].([]SearchMatch); len(matches) != 1 {
		t.Fatalf("got %d matches", len(matches))
	}
	moved := dir + "-old"
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	put(t, dir, "src.txt", "replacement")
	if _, err := workspace.Read("src.txt", 1, 10); err == nil {
		t.Fatal("replaced root was readable")
	}
}

func TestGitFiltersSensitivePathsAndBothRenameSides(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q")
	put(t, dir, "code.ts", "old\n")
	put(t, dir, ".env", "SECRET_SENTINEL\n")
	runGit(t, dir, "add", "-f", ".env", "code.ts")
	runGit(t, dir, "commit", "-qm", "fixture")
	put(t, dir, "code.ts", "new\n")
	put(t, dir, ".env", "NEW_SECRET_SENTINEL\n")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := workspace.Diff("unstaged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff["diff"].(string), "+new") || strings.Contains(diff["diff"].(string), "SECRET") {
		t.Fatalf("unexpected diff: %v", diff["diff"])
	}
	if diff["hidden"].(int) == 0 {
		t.Fatal("expected hidden entries")
	}
	status, err := workspace.Status(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mustJSON(t, status), ".env") {
		t.Fatalf("status disclosed .env: %s", mustJSON(t, status))
	}
	runGit(t, dir, "mv", ".env", "public.txt")
	renamed, err := workspace.Diff("staged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(renamed["diff"].(string), "SECRET") || strings.Contains(renamed["diff"].(string), "public.txt") {
		t.Fatalf("rename disclosed protected paths: %v", renamed["diff"])
	}
	elsewhere := t.TempDir()
	fresh, err := NewWorkspace(elsewhere)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fresh.Status(0, 200); err == nil {
		t.Fatal("status outside Git succeeded")
	}
}

func TestGitDisablesExternalDiffFsmonitorAndFilters(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q")
	put(t, dir, "code.ts", "before")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-qm", "fixture")
	put(t, dir, "code.ts", "after")
	runGit(t, dir, "config", "diff.external", "false")
	runGit(t, dir, "config", "core.fsmonitor", "touch marker")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	diff, err := workspace.Diff("unstaged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff["diff"].(string), "+after") {
		t.Fatalf("missing change: %v", diff["diff"])
	}
	if _, err := os.Stat(filepath.Join(dir, "marker")); err == nil {
		t.Fatal("fsmonitor ran")
	}
	runGit(t, dir, "config", "filter.custom.clean", "touch marker")
	put(t, dir, ".gitattributes", "*.ts filter=custom")
	workspace, _ = NewWorkspace(dir)
	if _, err := workspace.Status(0, 200); !HasCode(err, "GIT_FILTER_UNSUPPORTED") {
		t.Fatalf("status: %v, want GIT_FILTER_UNSUPPORTED", err)
	}
	if _, err := workspace.Diff("unstaged", DiffOptions{}); !HasCode(err, "GIT_FILTER_UNSUPPORTED") {
		t.Fatalf("diff: %v, want GIT_FILTER_UNSUPPORTED", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "marker")); err == nil {
		t.Fatal("filter ran")
	}
}

func TestSearchLimitsUTF8OutputAndReportsDepthTruncation(t *testing.T) {
	dir := t.TempDir()
	put(t, dir, "many.txt", strings.Join(arrayFill(80, strings.Repeat("中", 1000)), "\n"))
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	result, err := workspace.Search("中", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if JSONSize(result["matches"]) > MaxOut {
		t.Fatalf("matches exceeded budget: %d", JSONSize(result["matches"]))
	}
	if result["truncated"] != true {
		t.Fatal("expected truncation")
	}
	deep := filepath.Join(append([]string{dir}, arrayFill(14, "deep")...)...)
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	absent, err := workspace.Search("absent", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if absent["truncated"] != true {
		t.Fatal("expected depth truncation")
	}
}

func TestAccessRejectsInvalidOverlappingAndSymlinkRoots(t *testing.T) {
	base := t.TempDir()
	a := filepath.Join(base, "a")
	b := filepath.Join(base, "b")
	for _, path := range []string{a, b} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(a, filepath.Join(base, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewAccess(nil); err == nil {
		t.Fatal("empty roots accepted")
	}
	if _, err := NewAccess([]string{a, a}); err == nil {
		t.Fatal("duplicate roots accepted")
	}
	if _, err := NewAccess([]string{base, a}); err == nil {
		t.Fatal("overlapping roots accepted")
	}
	if _, err := NewAccess([]string{filepath.Join(base, "alias")}); err == nil {
		t.Fatal("symlink root accepted")
	}
	access, err := NewAccess([]string{a})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := access.Directory(b); err == nil {
		t.Fatal("outside directory accepted")
	}
	if err := access.AssertPrivate(filepath.Join(a, "state")); !HasCode(err, "STATE_INSIDE_WORKSPACE") {
		t.Fatalf("got %v", err)
	}
	if err := access.AssertPrivate(filepath.Join(b, "state")); err != nil {
		t.Fatalf("state sibling denied: %v", err)
	}
	if _, _, err := access.File("relative/code.ts"); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, _, err := access.File(a + "-sibling/code.ts"); err == nil {
		t.Fatal("prefix sibling accepted")
	}
}

func TestParentPoliciesApplyToFileAndRepositoryTools(t *testing.T) {
	requireGit(t)
	base := t.TempDir()
	a := filepath.Join(base, "workspaces")
	repo := filepath.Join(a, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	put(t, a, ".convorelignore", "repo/parent-hidden.txt\n")
	put(t, repo, "parent-hidden.txt", "SECRET_MARKER\n")
	put(t, repo, ".env.local", "SECRET_MARKER\n")
	put(t, repo, "code.ts", "export const a = 1;\n")
	access, err := NewAccess([]string{a})
	if err != nil {
		t.Fatal(err)
	}
	selected, err := access.Directory(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := selected.Read("parent-hidden.txt", 1, 10); err == nil {
		t.Fatal("parent policy did not hide file")
	}
	if _, err := selected.Read(".env.local", 1, 10); err == nil {
		t.Fatal(".env.local readable")
	}
	put(t, repo, ".gitignore", "!.env.local\n")
	if _, err := selected.Read(".env.local", 1, 10); err == nil {
		t.Fatal("child negation re-enabled credential name")
	}
	runGit(t, repo, "init", "-q")
	runGit(t, repo, "add", "-f", "code.ts", "parent-hidden.txt", ".env.local")
	diff, err := selected.Diff("staged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff["diff"].(string), "a = 1") || strings.Contains(diff["diff"].(string), "SECRET_MARKER") {
		t.Fatalf("unexpected diff: %v", diff["diff"])
	}
	status, err := selected.Status(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mustJSON(t, status), "parent-hidden.txt") {
		t.Fatal("status disclosed parent-hidden path")
	}
}

func TestProjectIdentityFollowsClosestCheckout(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "allowed")
	repo := filepath.Join(root, "repo")
	nested := filepath.Join(repo, "nested")
	for _, path := range []string{
		filepath.Join(base, ".git"),
		filepath.Join(root, "plain/deep"),
		filepath.Join(repo, ".git"),
		filepath.Join(nested, ".git"),
		filepath.Join(nested, "src"),
	} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	put(t, nested, "src/file.txt", "fixture")
	access, err := NewAccess([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	rootIdentity, err := access.Identity(root)
	if err != nil {
		t.Fatal(err)
	}
	if rootIdentity.WorkspacePath != root || rootIdentity.WorkspaceID != rootIdentity.RootID {
		t.Fatalf("unexpected root identity: %#v", rootIdentity)
	}
	deep, err := access.Identity(filepath.Join(root, "plain/deep"))
	if err != nil {
		t.Fatal(err)
	}
	if deep != rootIdentity {
		t.Fatalf("plain path changed identity: %#v", deep)
	}
	identity, err := access.Identity(filepath.Join(nested, "src/file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if identity.WorkspacePath != nested || identity.WorkspaceID == access.Roots[0].ID {
		t.Fatalf("unexpected project identity: %#v", identity)
	}
	if _, err := access.Identity(base); err == nil {
		t.Fatal("outside path got identity")
	}
}

func TestEvidenceDiscoveryPagination(t *testing.T) {
	root := t.TempDir()
	put(t, root, "src/a.ts", "before\nneedle.*\nafter\nneedle.* again\n")
	put(t, root, "src/b.ts", "needle.* last\n")
	put(t, root, "src/ignored.ts", "SECRET_SENTINEL\n")
	put(t, root, "src/.convorelignore", "ignored.ts\n")
	put(t, root, "outside.txt", "needle.*\n")
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	found, err := workspace.Find("*.ts", 12, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	entries := found["entries"].([]Entry)
	if len(entries) != 1 || entries[0].Path != "src/a.ts" || found["nextOffset"] != 1 {
		t.Fatalf("unexpected first page: %#v", found)
	}
	second, err := workspace.Find("src/*.ts", 12, found["nextOffset"].(int), 1)
	if err != nil {
		t.Fatal(err)
	}
	if second["entries"].([]Entry)[0].Path != "src/b.ts" {
		t.Fatalf("unexpected second page: %#v", second)
	}
	sub, err := workspace.Subdirectory("src")
	if err != nil {
		t.Fatal(err)
	}
	one, err := sub.Search("needle.*", SearchOptions{Pattern: "*.ts", Limit: 1, ContextLines: 1})
	if err != nil {
		t.Fatal(err)
	}
	match := one["matches"].([]SearchMatch)[0]
	if match.Path != "a.ts" || match.Line != 2 || one["nextOffset"] != 1 {
		t.Fatalf("unexpected match: %#v", one)
	}
	three, err := sub.Search("needle.*", SearchOptions{Pattern: "*.ts", Offset: 2, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if three["matches"].([]SearchMatch)[0].Path != "b.ts" || three["nextOffset"] != nil {
		t.Fatalf("unexpected third page: %#v", three)
	}
	if secret, _ := sub.Search("SECRET_SENTINEL", SearchOptions{}); len(secret["matches"].([]SearchMatch)) != 0 {
		t.Fatal("ignored file disclosed")
	}
}

func TestImageEvidenceBoundary(t *testing.T) {
	root := t.TempDir()
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3}
	if err := os.WriteFile(filepath.Join(root, "proof.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	put(t, root, "report.svg", "<svg/>")
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	result, err := workspace.Image("proof.png")
	if err != nil {
		t.Fatal(err)
	}
	if result["mimeType"] != "image/png" || result["sha256"] != sha256Hex(png) {
		t.Fatalf("unexpected image: %#v", result)
	}
	for _, path := range []string{".env", "../proof.png"} {
		if _, err := workspace.Image(path); err == nil {
			t.Errorf("image(%q) succeeded", path)
		}
	}
	if _, err := workspace.Image("report.svg"); !HasCode(err, "UNSUPPORTED_IMAGE") {
		t.Fatalf("got %v", err)
	}
	huge := append(append([]byte{}, png...), make([]byte, 1024*1024)...)
	if err := os.WriteFile(filepath.Join(root, "huge.png"), huge, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Image("huge.png"); !HasCode(err, "FILE_TOO_LARGE") {
		t.Fatalf("got %v", err)
	}
}

func TestPolicyFilesFailClosed(t *testing.T) {
	root := t.TempDir()
	put(t, root, "private.txt", "POLICY_SENTINEL")
	put(t, root, "public.txt", "PUBLIC")
	put(t, root, ".gitignore", "private.txt\x00suffix\n")
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() error{
		"read":   func() error { _, err := workspace.Read("private.txt", 1, 10); return err },
		"list":   func() error { _, err := workspace.List(".", 1, 0, 10); return err },
		"search": func() error { _, err := workspace.Search("POLICY_SENTINEL", SearchOptions{}); return err },
	} {
		if err := call(); !HasCode(err, "POLICY_UNREADABLE") {
			t.Errorf("%s: got %v, want POLICY_UNREADABLE", name, err)
		}
	}
	put(t, root, ".gitignore", "\uFEFFprivate.txt\r\n# 注释\r\n")
	workspace, _ = NewWorkspace(root)
	if _, err := workspace.Read("private.txt", 1, 10); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("got %v, want ACCESS_DENIED", err)
	}
	put(t, root, ".gitignore", "[z-a]\n")
	workspace, _ = NewWorkspace(root)
	if _, err := workspace.Read("public.txt", 1, 10); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("malformed policy widened access: %v", err)
	}
}

func arrayFill(n int, value string) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = value
	}
	return out
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestListReportsInventoryScanTruncation(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 10010; i++ {
		put(t, root, "file-"+itoa(i)+".ts", "")
	}
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	page, err := workspace.List(".", 1, 10000, 200)
	if err != nil {
		t.Fatal(err)
	}
	entries := page["entries"].([]Entry)
	if len(entries) != 0 || page["scanTruncated"] != true || page["truncated"] != true || page["depthLimited"] != false || page["nextOffset"] != nil {
		t.Fatalf("unexpected scan page: %#v", page)
	}
}

func TestTextChunkBoundsEscapedUTF8WithoutSplittingSurrogates(t *testing.T) {
	source := strings.Repeat("😀\t中\"", 25000)
	offset := 0
	reconstructed := ""
	for i := 0; i < 1000; i++ {
		chunk, next, err := TextChunk(source, offset, MaxOut)
		if err != nil {
			t.Fatal(err)
		}
		if JSONSize(chunk) >= MaxOut {
			t.Fatalf("chunk exceeded budget: %d", JSONSize(chunk))
		}
		reconstructed += chunk
		if next == nil {
			break
		}
		if *next <= offset {
			t.Fatal("non-progressing chunk cursor")
		}
		offset = *next
	}
	if reconstructed != source {
		t.Fatalf("reconstruction mismatch: %d vs %d bytes", len(reconstructed), len(source))
	}
	if _, _, err := TextChunk("😀x", 1, 100); !HasCode(err, "INVALID_OFFSET") {
		t.Fatalf("split surrogate accepted: %v", err)
	}
}

func TestOversizedFirstSearchResultFails(t *testing.T) {
	root := t.TempDir()
	context := strings.Repeat("\x01", 1000)
	lines := []string{context, context, context, context, context, "needle", context, context, context, context, context}
	put(t, root, "control.txt", strings.Join(lines, "\n"))
	workspace, err := NewWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workspace.Search("needle", SearchOptions{ContextLines: 5}); !HasCode(err, "SEARCH_ENTRY_TOO_LARGE") {
		t.Fatalf("got %v, want SEARCH_ENTRY_TOO_LARGE", err)
	}
}

func TestLiveDiffPagesReconstructLargePatch(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	runGit(t, dir, "init", "-q")
	put(t, dir, "a.txt", "old\n")
	put(t, dir, "b.txt", "old\n")
	commitAll(t, dir, "base")
	lines := make([]string, 12000)
	for i := range lines {
		lines[i] = `中😀	"` + itoa(i)
	}
	put(t, dir, "a.txt", strings.Join(lines, "\n")+"\n")
	put(t, dir, "b.txt", "new\n")
	workspace, err := NewWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	status, err := workspace.Status(0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if status["nextOffset"] != 1 {
		t.Fatalf("unexpected status cursor: %#v", status)
	}
	second, err := workspace.Status(1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if second["entries"].([]statusEntry)[0].Path != "b.txt" {
		t.Fatalf("unexpected second status: %#v", second["entries"])
	}
	offset := 0
	patch := ""
	sha := ""
	for rounds := 0; ; rounds++ {
		if rounds > 200 {
			t.Fatal("non-progressing patch cursor")
		}
		page, err := workspace.Diff("unstaged", DiffOptions{Limit: 1, PatchFile: stringPtr("a.txt"), PatchOffset: offset})
		if err != nil {
			t.Fatal(err)
		}
		if JSONSize(page) >= MaxOut {
			t.Fatalf("diff page exceeded budget: %d", JSONSize(page))
		}
		if page["nextOffset"] != 1 {
			t.Fatalf("unexpected file cursor: %#v", page["nextOffset"])
		}
		if sha == "" {
			sha = page["patchSha256"].(string)
		} else if page["patchSha256"] != sha {
			t.Fatal("patch hash changed between pages")
		}
		patch += page["diff"].(string)
		next, ok := page["nextPatchOffset"].(int)
		if !ok {
			break
		}
		if next <= offset {
			t.Fatal("non-progressing patch offset")
		}
		offset = next
	}
	expected := runGitOutput(t, dir, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--find-renames=1%", "--", "a.txt")
	if patch != expected {
		t.Fatalf("patch reconstruction mismatch: %d vs %d bytes\nours=%q\ntheirs=%q", len(patch), len(expected), tailOf(patch, 80), tailOf(expected, 80))
	}
	sum := sha256.Sum256([]byte(patch))
	if hex.EncodeToString(sum[:]) != sha {
		t.Fatal("patch hash mismatch")
	}
	put(t, dir, "a.txt", "changed again\n")
	changed, err := workspace.Diff("unstaged", DiffOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if changed["patchSha256"] == sha {
		t.Fatal("patch hash did not change")
	}
}

func TestIdentityDeniesSymlinkAliasesAndParentPolicies(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "repo/nested")
	if err := os.MkdirAll(filepath.Join(nested, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	put(t, nested, "src/file.txt", "fixture")
	access, err := NewAccess([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(nested, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := access.Identity(filepath.Join(root, "alias/src/file.txt")); !HasCode(err, "POLICY_UNREADABLE") {
		t.Fatalf("got %v, want POLICY_UNREADABLE", err)
	}
	put(t, root, ".convorelignore", "repo/nested/\n")
	if _, err := access.Identity(filepath.Join(nested, "src/file.txt")); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("got %v, want ACCESS_DENIED", err)
	}
	if _, err := access.Info(nested); !HasCode(err, "ACCESS_DENIED") {
		t.Fatalf("info: %v", err)
	}
}

func tailOf(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[len(value)-n:]
}

func runGitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}
