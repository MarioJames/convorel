package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/workspace"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
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

func TestMemoryEnforcesExplicitURIScope(t *testing.T) {
	root := t.TempDir()
	memoryRoot := "viking://user/test/memories/project"
	backend := filepath.Join(t.TempDir(), "ov-fixture")
	script := `#!/bin/sh
if [ "$1" = "read" ]; then
  printf '%s\n' '{"ok":true,"result":"shared memory"}'
else
  printf '%s\n' 'ov 0.4.19 command hint'
  printf '%s\n' '{"ok":true,"result":{"memories":[{"uri":"` + memoryRoot + `/shared fact.md","abstract":"shared fact","score":0.9},{"uri":"viking://user/test/memories/private/secret.md","abstract":"PRIVATE_SENTINEL","score":1}],"resources":[],"skills":[]}}'
fi
`
	if err := os.WriteFile(backend, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	server := newServer(t, []string{root}, func(options *Options) {
		options.MemoryRoots = []string{memoryRoot}
		options.MemoryExecutable = backend
	})
	search := mustData(t, call(t, server, "memory", map[string]any{"action": "search", "uri": memoryRoot, "query": "fact"}))
	matches := search["matches"].([]memoryHit)
	if len(matches) != 1 || matches[0].URI != memoryRoot+"/shared fact.md" {
		t.Fatalf("unexpected matches: %v", matches)
	}
	if strings.Contains(mustJSON(t, search), "PRIVATE_SENTINEL") {
		t.Fatal("out-of-scope hit disclosed")
	}
	read := mustData(t, call(t, server, "memory", map[string]any{"action": "read", "uri": memoryRoot + "/shared fact.md"}))
	if read["content"] != "shared memory" {
		t.Fatalf("unexpected content: %v", read["content"])
	}
	for _, uri := range []string{
		memoryRoot + "-private/fact.md",
		memoryRoot + "/../private/fact.md",
		memoryRoot + "/%2e%2e/private",
		"viking://~/memories",
		"viking://user/test/memories",
	} {
		result := call(t, server, "memory", map[string]any{"action": "read", "uri": uri})
		if result.Code == "" {
			t.Fatalf("uri %q accepted", uri)
		}
	}
	requireCode(t, call(t, server, "memory", map[string]any{"action": "read", "uri": memoryRoot, "query": "x"}), "MEMORY_ARGUMENTS_INVALID")
	requireCode(t, call(t, server, "memory", map[string]any{"action": "search", "uri": memoryRoot}), "MEMORY_QUERY_REQUIRED")
	unconfigured := newServer(t, []string{root})
	requireCode(t, call(t, unconfigured, "memory", map[string]any{"action": "read", "uri": memoryRoot + "/fact.md"}), "MEMORY_NOT_CONFIGURED")
	broken := newServer(t, []string{root}, func(options *Options) {
		options.MemoryRoots = []string{memoryRoot}
		options.MemoryExecutable = filepath.Join(t.TempDir(), "missing-ov")
	})
	requireCode(t, call(t, broken, "memory", map[string]any{"action": "read", "uri": memoryRoot + "/fact.md"}), "MEMORY_BACKEND_FAILED")
}

func TestGitToolsShareIdentityAndPolicy(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-q", "-b", "main")
	writeFile(t, root, "code.ts", "before\n")
	writeFile(t, root, ".env", "SECRET_SENTINEL\n")
	git(t, root, "add", "-f", "code.ts", ".env")
	git(t, root, "commit", "-qm", "base")
	base := git(t, root, "rev-parse", "HEAD")
	writeFile(t, root, "code.ts", "after\n")
	writeFile(t, root, ".env", "NEW_SECRET_SENTINEL\n")
	git(t, root, "add", "-f", "code.ts", ".env")
	git(t, root, "commit", "-qm", "change")
	head := git(t, root, "rev-parse", "HEAD")
	server := newServer(t, []string{root})
	info := mustData(t, call(t, server, "capabilities", map[string]any{"path": root}))
	workspaceInfo := info["workspace"].(map[string]any)
	rootID := workspaceInfo["rootId"].(string)
	workspaceID := workspaceInfo["workspaceId"].(string)
	if workspaceInfo["gitHead"] != head || workspaceInfo["gitBranch"] != "main" {
		t.Fatalf("unexpected git identity: %v", workspaceInfo)
	}
	requests := []struct {
		name string
		args map[string]any
	}{
		{"git_status", map[string]any{"path": root}},
		{"git_diff", map[string]any{"path": root}},
		{"git_log", map[string]any{"path": root}},
		{"git_show", map[string]any{"path": root}},
		{"git_compare", map[string]any{"path": root, "base": base, "head": head}},
		{"git_read_file", map[string]any{"path": root, "filePath": "code.ts"}},
	}
	for _, request := range requests {
		data := mustData(t, call(t, server, request.name, request.args))
		if data["rootId"] != rootID || data["workspaceId"] != workspaceID || data["workspacePath"] != root || data["path"] != root {
			t.Fatalf("%s identity mismatch: %v", request.name, data)
		}
		if strings.Contains(mustJSON(t, data), "SECRET_SENTINEL") {
			t.Fatalf("%s disclosed a secret", request.name)
		}
	}
	status := mustData(t, call(t, server, "git_status", map[string]any{"path": root}))
	if status["dirty"] != false {
		t.Fatalf("unexpected clean status: %v", status)
	}
	diff := mustData(t, call(t, server, "git_diff", map[string]any{"path": root}))
	if need, ok := diff["files"]; !ok || need == nil {
		t.Fatalf("missing diff files: %v", diff)
	}
	log := mustData(t, call(t, server, "git_log", map[string]any{"path": root}))
	commits := log["commits"].([]workspace.Commit)
	if len(commits) != 2 || commits[0].SHA != head {
		t.Fatalf("unexpected log: %v", commits)
	}
	show := mustData(t, call(t, server, "git_show", map[string]any{"path": root, "ref": head}))
	patch := show["patch"].(map[string]any)
	if !strings.Contains(patch["text"].(string), "+after") {
		t.Fatalf("unexpected patch: %v", patch["text"])
	}
	old := mustData(t, call(t, server, "git_read_file", map[string]any{"path": root, "ref": base, "filePath": "code.ts"}))
	if old["content"] != "before" || old["commit"] != base {
		t.Fatalf("unexpected historical read: %v", old)
	}
	requireCode(t, call(t, server, "git_read_file", map[string]any{"path": root, "filePath": ".env"}), "ACCESS_DENIED")
	requireCode(t, call(t, server, "git_log", map[string]any{"path": root, "ref": "--all"}), "INVALID_ARGUMENTS")
	requireCode(t, call(t, server, "git_compare", map[string]any{"path": root, "base": "missing"}), "GIT_FAILED")
	other := t.TempDir()
	requireCode(t, call(t, server, "git_status", map[string]any{"path": other}), "ACCESS_DENIED")
}

func TestIsolatedExecutionLimitsAndCleanup(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "package.json", `{"packageManager":"bun@1.4.2","scripts":{"build":"bun build.ts","test:fail":"exit 7","test:hang":"bun hang.ts","test:noise":"bun noise.ts"}}`)
	writeFile(t, root, "build.ts", `import {existsSync,writeFileSync} from 'node:fs';
if (existsSync('.env')) throw Error('host env exposed');
if (existsSync('/home/mocha')) throw Error('host home exposed');
let blocked=false; try { await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(500)}); } catch { blocked=true; }
if(!blocked) throw Error('network exposed');
writeFileSync('generated.txt','built');
console.log('BUILD_OK');`)
	writeFile(t, root, "hang.ts", "setInterval(()=>{},1000);")
	writeFile(t, root, "noise.ts", "console.log('x'.repeat(50000));")
	writeFile(t, root, ".env", "SECRET_SENTINEL=hidden\n")
	server := newServer(t, []string{root})
	if !server.execution.Available() {
		t.Skip("bwrap, prlimit and bun are required for the isolated execution test")
	}
	built := mustData(t, call(t, server, "exec", map[string]any{"command": "bun run build", "cwd": root}))
	result := built["execution"].(map[string]any)["result"].(map[string]any)
	if result["exitCode"] != 0 || !strings.Contains(result["stdout"].(string), "BUILD_OK") || result["timedOut"] != false {
		t.Fatalf("build failed: %v", result)
	}
	if len(result["inputSha256"].(string)) != 64 {
		t.Fatalf("missing input hash: %v", result)
	}
	if strings.Contains(mustJSON(t, result), "SECRET_SENTINEL") {
		t.Fatal("sandbox output disclosed .env")
	}
	if _, err := os.Stat(filepath.Join(root, "generated.txt")); err == nil {
		t.Fatal("sandbox wrote into the host worktree")
	}
	reports, err := os.ReadDir(filepath.Join(server.execution.stateDir, "executions"))
	if err != nil || len(reports) != 1 {
		t.Fatalf("expected one execution report: %v %v", reports, err)
	}
	failed := mustData(t, call(t, server, "exec", map[string]any{"command": "bun run test:fail", "cwd": root}))
	failedResult := failed["execution"].(map[string]any)["result"].(map[string]any)
	if failedResult["exitCode"] != 7 {
		t.Fatalf("unexpected failure exit: %v", failedResult)
	}
	hang := mustData(t, call(t, server, "exec", map[string]any{"command": "bun run test:hang", "cwd": root, "timeoutSeconds": 1}))
	hangResult := hang["execution"].(map[string]any)["result"].(map[string]any)
	if hangResult["timedOut"] != true || hangResult["exitCode"] != nil {
		t.Fatalf("unexpected timeout result: %v", hangResult)
	}
	noise := mustData(t, call(t, server, "exec", map[string]any{"command": "bun run test:noise", "cwd": root}))
	noiseResult := noise["execution"].(map[string]any)["result"].(map[string]any)
	if noiseResult["outputLimited"] != true {
		t.Fatalf("expected output limit: %v", noiseResult)
	}
	if workspaceJSONSize(noise) >= 64*1024 {
		t.Fatalf("noise response exceeded budget: %d", workspaceJSONSize(noise))
	}
	writeFile(t, root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
	writeFile(t, root, "package.json", `{"scripts":{"build":"echo should-not-run"}}`)
	requireCode(t, call(t, server, "exec", map[string]any{"command": "bun run build", "cwd": root}), "EXEC_PACKAGE_MANAGER_UNSUPPORTED")
	requireCode(t, call(t, server, "exec", map[string]any{"command": "bun -e 'console.log(1)'", "cwd": root}), "EXEC_COMMAND_DENIED")
	requireCode(t, call(t, server, "exec", map[string]any{"command": "bun run build"}), "EXEC_CWD_REQUIRED")
}

func TestDependencyGrantsAreReadOnly(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "package.json", `{"packageManager":"bun@1.4.2","scripts":{"build":"bun build.ts"}}`)
	writeFile(t, root, "node_modules/value.js", "export default 42;\n")
	writeFile(t, root, "build.ts", `import value from './node_modules/value.js';
import {writeFileSync} from 'node:fs';
if(value!==42) throw Error('dependency missing');
let denied=false;try{writeFileSync('node_modules/value.js','changed')}catch{denied=true}
if(!denied) throw Error('dependency writable'); console.log('DEPENDENCY_OK');`)
	server := newServer(t, []string{root}, func(options *Options) {
		options.DependencyRoots = []string{filepath.Join(root, "node_modules")}
	})
	if !server.execution.Available() {
		t.Skip("bwrap, prlimit and bun are required for the dependency grant test")
	}
	data := mustData(t, call(t, server, "exec", map[string]any{"command": "bun run build", "cwd": root}))
	result := data["execution"].(map[string]any)["result"].(map[string]any)
	if result["exitCode"] != 0 || !strings.Contains(result["stdout"].(string), "DEPENDENCY_OK") {
		t.Fatalf("dependency grant failed: %v", result)
	}
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "node_modules/value.js")}), "ACCESS_DENIED")
}

func TestCancellationReleasesSandbox(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "package.json", `{"packageManager":"bun@1.4.2","scripts":{"test:hang":"bun hang.ts","test:fail":"exit 7"}}`)
	writeFile(t, root, "hang.ts", "setInterval(()=>{},1000);")
	server := newServer(t, []string{root})
	if !server.execution.Available() {
		t.Skip("bwrap, prlimit and bun are required for the cancellation test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	raw := mustJSONRaw(map[string]any{"command": "bun run test:hang", "cwd": root})
	_ = server.Call(ctx, "exec", raw)
	deadline := time.Now().Add(2 * time.Second)
	var result CallResult
	for time.Now().Before(deadline) {
		result = call(t, server, "exec", map[string]any{"command": "bun run test:fail", "cwd": root})
		if result.Code != "EXEC_BUSY" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if result.Code != "" {
		t.Fatalf("sandbox stayed busy: %s", result.Code)
	}
	final := result.Data["execution"].(map[string]any)["result"].(map[string]any)
	if final["exitCode"] != 7 {
		t.Fatalf("unexpected follow-up exit: %v", final)
	}
}

func TestProcessGroupCleanupOnTimeout(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "marker")
	command := "(sleep 0.4; touch " + marker + ") & sleep 30"
	result, err := runBounded(context.Background(), []string{"/bin/sh", "-c", command}, processOptions{
		Timeout:   150 * time.Millisecond,
		MaxOutput: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.timedOut {
		t.Fatal("expected timeout")
	}
	time.Sleep(700 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("descendant process survived the group kill")
	}
}

func TestBoundedOutputFailure(t *testing.T) {
	_, err := runBounded(context.Background(), []string{"/bin/sh", "-c", "yes x"}, processOptions{
		Timeout:   2 * time.Second,
		MaxOutput: 64,
	})
	if err == nil {
		t.Fatal("unbounded output accepted")
	}
}

func TestStdioServeWorksWithoutDaemon(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	configDir := filepath.Join(t.TempDir(), "config")
	stateDir := filepath.Join(t.TempDir(), "state")
	preferences := map[string]any{"version": 1, "values": map[string]string{}}
	encoded, _ := json.Marshal(preferences)
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "preferences.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	repoRoot := findRepoRoot(t)
	binary := filepath.Join(t.TempDir(), "convorel")
	build := exec.Command("go", "build", "-o", binary, "./cmd/convorel")
	build.Dir = repoRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	rootJSON, _ := json.Marshal([]string{root})
	command := exec.Command(binary, "--config-dir", configDir, "--state-dir", stateDir, "mcp", "serve", "--roots", string(rootJSON))
	var stderr bytes.Buffer
	command.Stderr = &stderr
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect: %v (stderr %s)", err, stderr.String())
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 4 {
		t.Fatalf("tools: %v %v", tools, err)
	}
	names := []string{}
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "artifact,capabilities,exec,memory" {
		t.Fatalf("unexpected tool list: %v", names)
	}
	info, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "capabilities", Arguments: map[string]any{"path": root}})
	if err != nil || info.IsError {
		t.Fatalf("capabilities: %v %v (stderr %s)", info, err, stderr.String())
	}
	read, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "artifact", Arguments: map[string]any{"kind": "text", "path": filepath.Join(root, "hello.ts")}})
	if err != nil || read.IsError {
		t.Fatalf("artifact: %v %v", read, err)
	}
	executed, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "exec", Arguments: map[string]any{"command": "read_file --path '" + filepath.Join(root, "hello.ts") + "'"}})
	if err != nil || executed.IsError {
		t.Fatalf("exec: %v %v", executed, err)
	}
	executedContent, ok := executed.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("unexpected exec structure: %T", executed.StructuredContent)
	}
	execution := executedContent["execution"].(map[string]any)
	if execution["operation"] != "read_file" {
		t.Fatalf("unexpected exec operation: %v", execution["operation"])
	}
	inner := execution["result"].(map[string]any)
	if !strings.Contains(inner["content"].(string), "answer = 42") {
		t.Fatalf("unexpected exec result: %v", inner["content"])
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("SECRET_SENTINEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	denied, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "artifact", Arguments: map[string]any{"kind": "text", "path": outside}})
	if err != nil {
		t.Fatal(err)
	}
	if !denied.IsError {
		t.Fatal("outside read succeeded")
	}
	if strings.Contains(mustJSON(t, denied), "SECRET_SENTINEL") {
		t.Fatal("outside content disclosed")
	}
	if text, ok := denied.Content[0].(*sdk.TextContent); !ok || text.Text != "ACCESS_DENIED" {
		t.Fatalf("unexpected denial: %v", denied.Content)
	}
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}

func mustJSONRaw(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func TestPrivatePreferencesAndStateAreUnreadable(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "x\n")
	configDir := filepath.Join(t.TempDir(), "config")
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "executions"), 0o700); err != nil {
		t.Fatal(err)
	}
	preferences := filepath.Join(configDir, "preferences.json")
	if err := os.WriteFile(preferences, []byte(`{"version":1,"values":{"tunnel.apiKey":"PREFERENCES_SENTINEL"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(stateDir, "executions", "report.json")
	if err := os.WriteFile(report, []byte("STATE_SENTINEL"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{Roots: []string{root}, ConfigDir: configDir, StateDir: stateDir})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{preferences, report} {
		result := call(t, server, "artifact", map[string]any{"kind": "text", "path": path})
		if result.Code == "" {
			t.Fatalf("private path %q was readable", path)
		}
		if strings.Contains(mustJSON(t, result), "SENTINEL") {
			t.Fatalf("private content leaked for %q", path)
		}
	}
}

func TestEmptyFileAndMissingFileCodes(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "empty.txt", "")
	server := newServer(t, []string{root})
	empty := mustData(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "empty.txt")}))
	result := empty["artifact"].(map[string]any)["result"].(map[string]any)
	if result["endLine"] != 0 || result["totalLines"] != 0 || result["content"] != "" {
		t.Fatalf("unexpected empty page: %v", result)
	}
	requireCode(t, call(t, server, "artifact", map[string]any{"kind": "text", "path": filepath.Join(root, "missing.ts")}), "FILE_NOT_FOUND")
}

func TestExecGitAliasDispatches(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-q")
	writeFile(t, root, "code.ts", "after\n")
	server := newServer(t, []string{root})
	data := mustData(t, call(t, server, "exec", map[string]any{"command": "git status --path '" + root + "'"}))
	execution := data["execution"].(map[string]any)
	if execution["operation"] != "git_status" {
		t.Fatalf("unexpected alias: %v", execution["operation"])
	}
	inner := execution["result"].(map[string]any)
	if inner["dirty"] != true {
		t.Fatalf("unexpected status: %v", inner)
	}
}

func TestGitDiffModesThroughMCP(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-q")
	git(t, root, "config", "user.name", "Fixture")
	git(t, root, "config", "user.email", "fixture@example.invalid")
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	writeFile(t, root, ".env", "SECRET_SENTINEL\n")
	git(t, root, "add", "-f", "hello.ts", ".env")
	git(t, root, "commit", "-qm", "fixture")
	writeFile(t, root, "hello.ts", "export const answer = 43;\n")
	writeFile(t, root, ".env", "NEW_SECRET_SENTINEL\n")
	server := newServer(t, []string{root})
	info := mustData(t, call(t, server, "capabilities", map[string]any{"path": root}))
	workspaceInfo := info["workspace"].(map[string]any)
	if !regexp.MustCompile(`^[a-f0-9]{40,64}$`).MatchString(workspaceInfo["gitHead"].(string)) {
		t.Fatalf("unexpected head: %v", workspaceInfo["gitHead"])
	}
	status := mustData(t, call(t, server, "git_status", map[string]any{"path": root}))
	if status["dirty"] != true || strings.Contains(mustJSON(t, status), "secret.key") {
		t.Fatalf("unexpected status: %v", status)
	}
	if status["hidden"].(int) == 0 {
		t.Fatal("expected hidden entries")
	}
	for _, mode := range []string{"unstaged", "head", "staged"} {
		if mode == "staged" {
			git(t, root, "add", "hello.ts", ".env")
		}
		diff := mustData(t, call(t, server, "git_diff", map[string]any{"path": root, "mode": mode}))
		if diff["mode"] != mode || !strings.Contains(diff["diff"].(string), "+export const answer = 43;") {
			t.Fatalf("%s diff: %v", mode, diff["diff"])
		}
		if diff["hashScope"] != "returned-diff" || diff["hidden"].(int) == 0 {
			t.Fatalf("%s metadata: %v", mode, diff)
		}
		if strings.Contains(mustJSON(t, diff), "SECRET_SENTINEL") {
			t.Fatalf("%s disclosed a secret", mode)
		}
	}
}

func TestStdioServeUsesPreferencesRoots(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	configDir := filepath.Join(t.TempDir(), "config")
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rootsJSON, _ := json.Marshal([]string{root})
	preferences, _ := json.Marshal(map[string]any{
		"version": 1,
		"values":  map[string]string{"mcp.roots": string(rootsJSON)},
	})
	if err := os.WriteFile(filepath.Join(configDir, "preferences.json"), preferences, 0o600); err != nil {
		t.Fatal(err)
	}
	repoRoot := findRepoRoot(t)
	binary := filepath.Join(t.TempDir(), "convorel")
	build := exec.Command("go", "build", "-o", binary, "./cmd/convorel")
	build.Dir = repoRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	command := exec.Command(binary, "--config-dir", configDir, "--state-dir", stateDir, "mcp", "serve")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect: %v (stderr %s)", err, stderr.String())
	}
	defer session.Close()
	info, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "capabilities", Arguments: map[string]any{"path": root}})
	if err != nil || info.IsError {
		t.Fatalf("capabilities: %v %v (stderr %s)", info, err, stderr.String())
	}
	structured := info.StructuredContent.(map[string]any)
	workspaceInfo := structured["workspace"].(map[string]any)
	if workspaceInfo["path"] != root {
		t.Fatalf("preference roots not used: %v", workspaceInfo["path"])
	}
}

func TestStdioServeFallsBackToSavedWorkspace(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "hello.ts", "export const answer = 42;\n")
	configDir := filepath.Join(t.TempDir(), "config")
	stateDir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	configDocument, _ := json.Marshal(map[string]any{
		"version":   1,
		"workspace": root,
	})
	if err := os.WriteFile(filepath.Join(stateDir, "config.json"), configDocument, 0o600); err != nil {
		t.Fatal(err)
	}
	repoRoot := findRepoRoot(t)
	binary := filepath.Join(t.TempDir(), "convorel")
	build := exec.Command("go", "build", "-o", binary, "./cmd/convorel")
	build.Dir = repoRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v\n%s", err, output)
	}
	command := exec.Command(binary, "--config-dir", configDir, "--state-dir", stateDir, "mcp", "serve")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client := sdk.NewClient(&sdk.Implementation{Name: "acceptance", Version: "1"}, nil)
	session, err := client.Connect(ctx, &sdk.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect: %v (stderr %s)", err, stderr.String())
	}
	defer session.Close()
	read, err := session.CallTool(ctx, &sdk.CallToolParams{Name: "artifact", Arguments: map[string]any{"kind": "text", "path": filepath.Join(root, "hello.ts")}})
	if err != nil || read.IsError {
		t.Fatalf("artifact: %v %v (stderr %s)", read, err, stderr.String())
	}
}
