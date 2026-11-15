package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/workspace"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func newServer(t *testing.T, roots []string, options ...func(*Options)) *Server {
	t.Helper()
	opt := Options{
		Roots:     roots,
		StateDir:  filepath.Join(t.TempDir(), "state"),
		ConfigDir: filepath.Join(t.TempDir(), "config"),
	}
	for _, apply := range options {
		apply(&opt)
	}
	server, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func call(t *testing.T, server *Server, name string, args any) CallResult {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return server.Call(context.Background(), name, raw)
}

func mustData(t *testing.T, result CallResult) map[string]any {
	t.Helper()
	if result.Code != "" {
		t.Fatalf("tool failed: %s", result.Code)
	}
	return result.Data
}

func requireCode(t *testing.T, result CallResult, code string) {
	t.Helper()
	if result.Code != code {
		t.Fatalf("got %q, want %q (data %v)", result.Code, code, result.Data)
	}
}

func writeFile(t *testing.T, root, path, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestToolListIsExactAndAnnotationsMatch(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	server := newServer(t, []string{root})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	go func() { _ = server.sdk.Run(ctx, serverTransport) }()
	client := sdk.NewClient(&sdk.Implementation{Name: "acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
		if tool.OutputSchema == nil {
			t.Fatalf("%s has no output schema", tool.Name)
		}
		if tool.Annotations == nil {
			t.Fatalf("%s has no annotations", tool.Name)
		}
		if tool.Name == "exec" && tool.Annotations.ReadOnlyHint {
			t.Fatal("exec must not be read-only")
		}
	}
	sorted := append([]string{}, names...)
	sort.Strings(sorted)
	if strings.Join(sorted, ",") != "artifact,capabilities,exec,memory" || len(names) != 4 {
		t.Fatalf("unexpected tool list: %v", names)
	}
	capResult, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "capabilities", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if capResult.IsError {
		t.Fatalf("capabilities failed: %v", capResult.Content)
	}
	structured, ok := capResult.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("unexpected structured content: %T", capResult.StructuredContent)
	}
	if structured["mode"] != "guarded" {
		t.Fatalf("unexpected mode: %v", structured["mode"])
	}
	if len(capResult.Content) != 1 {
		t.Fatalf("unexpected content: %v", capResult.Content)
	}
	text, ok := capResult.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("unexpected content type: %T", capResult.Content[0])
	}
	encoded, _ := json.Marshal(structured)
	if text.Text != string(encoded) {
		t.Fatal("text content diverges from structured content")
	}
}

func TestCapabilitiesShape(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "x\n")
	server := newServer(t, []string{root}, func(options *Options) {
		options.MemoryRoots = []string{"viking://user/test/memories/project"}
	})
	data := mustData(t, call(t, server, "capabilities", map[string]any{}))
	if data["mode"] != "guarded" {
		t.Fatalf("mode=%v", data["mode"])
	}
	workspaceValue, ok := data["workspace"]
	if !ok {
		t.Fatal("workspace missing")
	}
	if workspaceValue != nil {
		t.Fatalf("workspace should be null without path: %v", workspaceValue)
	}
	serverMap := data["server"].(map[string]any)
	if serverMap["capabilityVersion"] != "functions-v1" || serverMap["name"] != "convorel" {
		t.Fatalf("unexpected server block: %v", serverMap)
	}
	tools := serverMap["tools"].([]string)
	if strings.Join(tools, ",") != "exec,memory,artifact,capabilities" {
		t.Fatalf("unexpected tools: %v", tools)
	}
	execution := data["execution"].(map[string]any)
	if execution["runtime"] != "bun" || execution["network"] != false || execution["shell"] != false {
		t.Fatalf("unexpected execution: %v", execution)
	}
	commands := execution["commands"].([]map[string]any)
	if len(commands) != 10 {
		t.Fatalf("unexpected command count: %d", len(commands))
	}
	first := commands[0]
	if first["name"] != "tree" {
		t.Fatalf("unexpected first command: %v", first)
	}
	arguments := first["arguments"].([]string)
	if strings.Join(arguments, ",") != "path,depth,offset,limit" {
		t.Fatalf("unexpected arguments: %v", arguments)
	}
	if !strings.Contains(first["inputSchema"].(string), `"additionalProperties":false`) {
		t.Fatalf("unexpected schema: %s", first["inputSchema"])
	}
	memory := data["memory"].(map[string]any)
	if memory["configured"] != true || memory["status"] != "not-probed" {
		t.Fatalf("unexpected memory: %v", memory)
	}
	actions := memory["actions"].([]string)
	if strings.Join(actions, ",") != "search,read" {
		t.Fatalf("unexpected actions: %v", actions)
	}
	artifacts := data["artifacts"].(map[string]any)
	if artifacts["uploads"] != false {
		t.Fatalf("unexpected artifacts: %v", artifacts)
	}
}

func TestCapabilitiesWithPathReportsIdentity(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	writeFile(t, repo, "src/code.txt", "content\n")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, []string{root})
	data := mustData(t, call(t, server, "capabilities", map[string]any{"path": filepath.Join(repo, "src")}))
	workspaceValue := data["workspace"].(map[string]any)
	if workspaceValue["workspacePath"] != repo {
		t.Fatalf("unexpected workspace path: %v", workspaceValue["workspacePath"])
	}
	if workspaceValue["path"] != filepath.Join(repo, "src") {
		t.Fatalf("unexpected requested path: %v", workspaceValue["path"])
	}
	roots := data["roots"].([]map[string]any)
	if len(roots) != 1 || roots[0]["path"] != root {
		t.Fatalf("unexpected roots: %v", roots)
	}
	plainDir := filepath.Join(root, "plain/deep")
	if err := os.MkdirAll(plainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	plain := mustData(t, call(t, server, "capabilities", map[string]any{"path": plainDir}))
	plainWorkspace := plain["workspace"].(map[string]any)
	if plainWorkspace["workspacePath"] != root || plainWorkspace["workspaceId"] != plainWorkspace["rootId"] {
		t.Fatalf("non-Git fallback identity is wrong: %v", plainWorkspace)
	}
}

func TestRootOutsideReadIsDenied(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	writeFile(t, outside, "secret.txt", "SECRET_SENTINEL\n")
	server := newServer(t, []string{root})
	for _, path := range []string{
		filepath.Join(outside, "secret.txt"),
		filepath.Join(root, "..", filepath.Base(outside), "secret.txt"),
		"relative/secret.txt",
		"/etc/passwd",
	} {
		result := call(t, server, "artifact", map[string]any{"kind": "text", "path": path})
		if result.Code == "" {
			t.Fatalf("read outside root succeeded: %q", path)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "SECRET_SENTINEL") {
			t.Fatalf("sentinel disclosed for %q", path)
		}
	}
	if result := call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "hello.ts")}); result.Code != "" {
		t.Fatalf("allowed read failed: %s", result.Code)
	}
}

func TestArtifactPolicyAndImageContent(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "report.txt", "line one\nline two\n")
	writeFile(t, root, ".env", "SECRET_SENTINEL\n")
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7}
	if err := os.WriteFile(filepath.Join(root, "proof.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, []string{root})
	text := mustData(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "report.txt"), "startLine": 2, "maxLines": 1}))
	artifact := text["artifact"].(map[string]any)
	result := artifact["result"].(map[string]any)
	if artifact["kind"] != "text" || result["content"] != "line two" {
		t.Fatalf("unexpected artifact: %v", text)
	}
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, ".env")}), "ACCESS_DENIED")
	image := call(t, server, "artifact", map[string]any{"kind": "image", "path": filepath.Join(root, "proof.png")})
	if image.Code != "" {
		t.Fatalf("image failed: %s", image.Code)
	}
	if string(image.Image) != string(png) || image.MIMEType != "image/png" {
		t.Fatalf("unexpected image payload")
	}
	imageArtifact := image.Data["artifact"].(map[string]any)
	imageResult := imageArtifact["result"].(map[string]any)
	if _, exists := imageResult["imageData"]; exists {
		t.Fatal("structured image result leaked base64 bytes")
	}
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "image", "path": filepath.Join(root, "proof.png"), "startLine": 1}), "INVALID_ARGUMENTS")
}

func TestSymlinkEscapeAndHardlinkAreDenied(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, outside, "secret.txt", "SECRET_SENTINEL\n")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "alias.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "public.txt", "PUBLIC\n")
	if err := os.Link(filepath.Join(root, "public.txt"), filepath.Join(root, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, []string{root})
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "alias.txt")}), "ACCESS_DENIED")
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "hard.txt")}), "ACCESS_DENIED")
}

func TestStateAndPreferencesInsideRootsAreRefused(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "x\n")
	state := filepath.Join(root, "state")
	if _, err := New(Options{Roots: []string{root}, StateDir: state}); err == nil {
		t.Fatal("state inside root accepted")
	}
	config := filepath.Join(root, "config")
	if _, err := New(Options{Roots: []string{root}, ConfigDir: config}); err == nil {
		t.Fatal("config inside root accepted")
	}
	if _, err := New(Options{Roots: []string{root}, StateDir: t.TempDir(), ConfigDir: t.TempDir()}); err != nil {
		t.Fatalf("private sibling rejected: %v", err)
	}
}

func TestTreeSharesPolicyDepthAndPagination(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, ".gitignore", "private/\n")
	writeFile(t, root, ".convorelignore", "internal/\n")
	for _, path := range []string{"src/deep/more", "private", "internal", "node_modules"} {
		if err := os.MkdirAll(filepath.Join(root, path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, root, "src/.gitignore", "hidden.ts\n")
	for _, path := range []string{"private/leak.ts", "internal/leak.ts", "node_modules/leak.ts", "src/hidden.ts"} {
		writeFile(t, root, path, "SECRET_SENTINEL")
	}
	writeFile(t, root, "src/index.ts", "export {};\n")
	writeFile(t, root, "src/deep/module.ts", "export {};\n")
	writeFile(t, root, "src/deep/more/last.ts", "export {};\n")
	writeFile(t, root, `line
break".ts`, "export {};\n")
	if err := os.Symlink(filepath.Join(root, "src"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, []string{root})
	shallow := mustData(t, call(t, server, "tree", map[string]any{"path": root, "depth": 1}))
	if shallow["depthLimited"] != true {
		t.Fatal("expected depth limit")
	}
	shallowEntries := shallow["entries"].([]treeEntry)
	for _, entry := range shallowEntries {
		if entry.Depth != 1 {
			t.Fatalf("unexpected depth: %v", entry)
		}
	}
	if strings.Contains(mustJSON(t, shallow), "index.ts") {
		t.Fatal("shallow tree descended")
	}
	full := mustData(t, call(t, server, "tree", map[string]any{"path": root, "depth": 4}))
	if full["depthLimited"] != false || full["scanTruncated"] != false || full["truncated"] != false || full["nextOffset"] != nil {
		t.Fatalf("unexpected full tree flags: %v", full)
	}
	fullEntries := full["entries"].([]treeEntry)
	encoded := mustJSON(t, full)
	for _, denied := range []string{"secret.key", "private", "internal", "node_modules", "hidden.ts", "alias"} {
		if strings.Contains(encoded, denied) {
			t.Fatalf("tree disclosed %q", denied)
		}
	}
	found := false
	for _, entry := range fullEntries {
		if entry.Path == "src/deep/module.ts" && entry.Depth == 3 && entry.ParentPath == "src/deep" {
			found = true
		}
	}
	if !found {
		t.Fatalf("nested entry missing: %v", fullEntries)
	}
	treeText := full["tree"].(string)
	if !strings.Contains(treeText, `    "src/deep/module.ts"`) {
		t.Fatalf("unexpected tree render: %s", treeText)
	}
	if len(strings.Split(treeText, "\n")) != len(fullEntries) {
		t.Fatal("tree render line count diverges from entries")
	}
	paged := []treeEntry{}
	offset := 0
	for i := 0; i < 100; i++ {
		page := mustData(t, call(t, server, "tree", map[string]any{"path": root, "depth": 4, "offset": offset, "limit": 2}))
		entries := page["entries"].([]treeEntry)
		if len(entries) > 2 {
			t.Fatal("page exceeded limit")
		}
		paged = append(paged, entries...)
		next, ok := page["nextOffset"].(int)
		if !ok {
			break
		}
		if next != offset+len(entries) {
			t.Fatalf("bad nextOffset: %d vs %d", next, offset+len(entries))
		}
		offset = next
	}
	if mustJSON(t, paged) != mustJSON(t, fullEntries) {
		t.Fatal("pagination did not reconstruct the tree")
	}
	nested := mustData(t, call(t, server, "tree", map[string]any{"path": filepath.Join(root, "src"), "depth": 4}))
	for _, entry := range nested["entries"].([]treeEntry) {
		if entry.Path == "hidden.ts" {
			t.Fatal("nested policy failed")
		}
	}
	for _, args := range []map[string]any{
		{"path": root, "depth": 5},
		{"path": root, "limit": 501},
		{"path": root, "offset": 10001},
		{"path": filepath.Join(root, "private")},
		{"path": filepath.Join(root, "alias")},
	} {
		if result := call(t, server, "tree", args); result.Code == "" {
			t.Fatalf("tree accepted %v", args)
		}
	}
}

func TestTreeByteTruncationPreservesOffsets(t *testing.T) {
	root := t.TempDir()
	names := []string{}
	for i := 0; i < 400; i++ {
		name := padded(i) + "-" + strings.Repeat("x", 180) + ".ts"
		names = append(names, name)
		writeFile(t, root, name, "")
	}
	writeFile(t, root, "hello.ts", "")
	server := newServer(t, []string{root})
	paths := []string{}
	offset := 0
	for i := 0; i < 100; i++ {
		page := mustData(t, call(t, server, "tree", map[string]any{"path": root, "limit": 500, "offset": offset}))
		if workspaceJSONSize(page) > 64*1024 {
			t.Fatalf("page exceeded response budget: %d", workspaceJSONSize(page))
		}
		entries := page["entries"].([]treeEntry)
		for _, entry := range entries {
			paths = append(paths, entry.Path)
		}
		next, ok := page["nextOffset"].(int)
		if !ok {
			break
		}
		if page["truncated"] != true || len(entries) == 0 || next != offset+len(entries) {
			t.Fatalf("bad truncated page: %v", page)
		}
		offset = next
	}
	if len(paths) != len(names)+1 {
		t.Fatalf("got %d paths, want %d", len(paths), len(names)+1)
	}
}

func TestExecRejectsInjectionAndUnknownCommands(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "report.txt", "line one\nline two\n")
	server := newServer(t, []string{root})
	for _, command := range []string{
		"rm --path /tmp",
		"git status --path /tmp; id",
		"git status $(id)",
		"git status > out",
		"git status | cat",
		"git status\nid",
		"read_file --path $HOME",
		"bun run build && id",
		"bun -e 'console.log(1)'",
		"bun run build --watch",
	} {
		if result := call(t, server, "exec", map[string]any{"command": command, "cwd": root}); result.Code == "" {
			t.Fatalf("command accepted: %q", command)
		}
	}
	requireCode(t, call(t, server, "exec", map[string]any{
		"command": "artifact --kind text --path '" + filepath.Join(root, "report.txt") + "'",
	}), "COMMAND_DENIED")
	read := mustData(t, call(t, server, "exec", map[string]any{
		"command": "read_file --path '" + filepath.Join(root, "report.txt") + "'",
	}))
	execution := read["execution"].(map[string]any)
	if execution["operation"] != "read_file" {
		t.Fatalf("unexpected operation: %v", execution["operation"])
	}
	inner := execution["result"].(map[string]any)
	if inner["content"] != "line one\nline two" {
		t.Fatalf("unexpected read: %v", inner["content"])
	}
	unknown := call(t, server, "exec", map[string]any{"command": "read_file --path '" + filepath.Join(root, "report.txt") + "' --unknown 1"})
	requireCode(t, unknown, "INVALID_ARGUMENTS")
	conflict := call(t, server, "exec", map[string]any{"command": "git status --path /tmp", "cwd": root})
	requireCode(t, conflict, "EXEC_PATH_CONFLICT")
	duplicate := call(t, server, "exec", map[string]any{"command": "read_file --path a --path b"})
	requireCode(t, duplicate, "DUPLICATE_ARGUMENT")
	missing := call(t, server, "exec", map[string]any{"command": "read_file"})
	requireCode(t, missing, "INVALID_ARGUMENTS")
}

func TestSearchFindAndBudgets(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "src/a.ts", "before\nneedle.*\nafter\nneedle.* again\n")
	writeFile(t, root, "src/b.ts", "needle.* last\n")
	writeFile(t, root, "src/ignored.ts", "SECRET_SENTINEL\n")
	writeFile(t, root, "src/.convorelignore", "ignored.ts\n")
	writeFile(t, root, "many.txt", strings.Join(repeatStrings(80, strings.Repeat("中", 1000)), "\n"))
	server := newServer(t, []string{root})
	found := mustData(t, call(t, server, "find_files", map[string]any{"path": root, "pattern": "*.ts", "limit": 1}))
	if len(found["entries"].([]workspace.Entry)) != 1 {
		t.Fatalf("unexpected find page: %v", found)
	}
	next := found["nextOffset"].(int)
	second := mustData(t, call(t, server, "find_files", map[string]any{"path": root, "pattern": "src/*.ts", "offset": next, "limit": 1}))
	entries := second["entries"].([]workspace.Entry)
	if entries[0].Path != "src/b.ts" {
		t.Fatalf("unexpected second page: %v", entries)
	}
	search := mustData(t, call(t, server, "search_workspace", map[string]any{"path": filepath.Join(root, "src"), "query": "needle.*", "pattern": "*.ts", "contextLines": 1, "limit": 1}))
	matches := search["matches"].([]workspace.SearchMatch)
	if len(matches) != 1 || matches[0].Path != "a.ts" || matches[0].Line != 2 {
		t.Fatalf("unexpected search: %v", search)
	}
	secret := mustData(t, call(t, server, "search_workspace", map[string]any{"path": root, "query": "SECRET_SENTINEL"}))
	if len(secret["matches"].([]workspace.SearchMatch)) != 0 {
		t.Fatal("ignored file disclosed")
	}
	bounded := mustData(t, call(t, server, "search_workspace", map[string]any{"path": root, "query": "中"}))
	if workspaceJSONSize(bounded["matches"]) > 64*1024 {
		t.Fatal("search matches exceeded budget")
	}
	if bounded["truncated"] != true {
		t.Fatal("expected search truncation")
	}
}

func TestInvalidArgumentsAreRejected(t *testing.T) {
	root := t.TempDir()
	server := newServer(t, []string{root})
	for _, test := range []struct {
		name string
		args map[string]any
	}{
		{"tree", map[string]any{"path": root, "unknown": true}},
		{"tree", map[string]any{"path": root, "depth": 0}},
		{"tree", map[string]any{"path": root, "limit": 501}},
		{"read_file", map[string]any{}},
		{"read_file", map[string]any{"path": root, "startLine": 0}},
		{"find_files", map[string]any{"path": root, "pattern": "../*"}},
		{"search_workspace", map[string]any{"path": root, "query": ""}},
		{"git_diff", map[string]any{"path": root, "mode": "linear"}},
		{"memory", map[string]any{"action": "write", "uri": "viking://a/b/c"}},
	} {
		result := call(t, server, test.name, test.args)
		if result.Code == "" {
			t.Fatalf("%s accepted %v", test.name, test.args)
		}
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func workspaceJSONSize(value any) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return 0
	}
	return len(encoded)
}

func repeatStrings(n int, value string) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = value
	}
	return out
}

func padded(value int) string {
	text := itoa(value)
	for len(text) < 3 {
		text = "0" + text
	}
	return text
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
