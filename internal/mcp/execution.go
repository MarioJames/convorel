package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/convorel/internal/workspace"
)

var execScript = regexp.MustCompile(`^(?:build|test|check|typecheck|dist)(?::[a-zA-Z0-9_-]+)?$`)

const executionNote = "Isolated Linux execution over a filtered input snapshot. No host HOME, credentials, Git metadata or network. Shared dependencies are explicit read-only grants and are not included in inputSha256. Generated files are ephemeral; host worktree is unchanged. Exit code and output must be checked; isolation can make otherwise valid tests fail."

// Execution runs the isolated Bun build/test subset of the exec tool.
type Execution struct {
	access          *workspace.Access
	dependencyRoots []string
	stateDir        string
	busy            sync.Mutex
}

// Available reports whether the Linux sandbox prerequisites are installed.
func (e *Execution) Available() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	for _, name := range []string{"bwrap", "prlimit", "bun"} {
		if _, err := exec.LookPath(name); err != nil {
			return false
		}
	}
	return true
}

// Run executes one permitted Bun command over a policy-filtered snapshot.
func (e *Execution) Run(ctx context.Context, command string, tokens []string, cwd string, timeoutSeconds int) (map[string]any, error) {
	permitted := (len(tokens) == 2 && tokens[0] == "bun" && tokens[1] == "test") ||
		(len(tokens) == 3 && tokens[0] == "bun" && tokens[1] == "run" && execScript.MatchString(tokens[2]))
	if !permitted {
		return nil, workspace.Fail("EXEC_COMMAND_DENIED")
	}
	if !e.Available() {
		return nil, workspace.Fail("EXEC_SANDBOX_UNAVAILABLE")
	}
	if !e.busy.TryLock() {
		return nil, workspace.Fail("EXEC_BUSY")
	}
	defer e.busy.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, workspace.Fail("EXEC_CANCELLED")
	}
	selected, err := e.access.Directory(cwd)
	if err != nil {
		return nil, err
	}
	identity, err := e.access.Identity(cwd)
	if err != nil {
		return nil, err
	}
	files, err := selected.ExecutionFiles()
	if err != nil {
		return nil, err
	}
	var packageFile *workspace.ExecutionFile
	for i := range files {
		if files[i].Path == "package.json" {
			packageFile = &files[i]
		}
	}
	if packageFile == nil {
		return nil, workspace.Fail("EXEC_PACKAGE_REQUIRED")
	}
	var pkg struct {
		PackageManager string            `json:"packageManager"`
		Scripts        map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(packageFile.Bytes, &pkg); err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
	}
	if pkg.PackageManager != "" && !strings.HasPrefix(pkg.PackageManager, "bun@") {
		return nil, workspace.Fail("EXEC_PACKAGE_MANAGER_UNSUPPORTED")
	}
	if pkg.PackageManager == "" {
		hasBunLock := false
		hasForeignLock := false
		for _, file := range files {
			switch file.Path {
			case "bun.lock", "bun.lockb":
				hasBunLock = true
			case "pnpm-lock.yaml", "package-lock.json", "yarn.lock":
				hasForeignLock = true
			}
		}
		if !hasBunLock && hasForeignLock {
			return nil, workspace.Fail("EXEC_PACKAGE_MANAGER_UNSUPPORTED")
		}
	}
	if tokens[1] == "run" && pkg.Scripts[tokens[2]] == "" {
		return nil, workspace.Fail("EXEC_SCRIPT_UNAVAILABLE")
	}
	manifest := make([][]any, 0, len(files))
	for _, file := range files {
		manifest = append(manifest, []any{file.Path, int(file.Mode), hashBytes(file.Bytes)})
	}
	encodedManifest, err := json.Marshal(manifest)
	if err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
	}
	inputSHA := hashBytes(encodedManifest)
	dependencies := []string{}
	for _, path := range e.dependencyRoots {
		if path != filepath.Join(selected.Root, "node_modules") {
			continue
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil || real != path {
			return nil, workspace.Fail("EXEC_DEPENDENCY_SYMLINK_DENIED")
		}
		dependencies = append(dependencies, path)
	}
	dir, err := os.MkdirTemp("", "convorel-exec-")
	if err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
	}
	defer os.RemoveAll(dir)
	source := filepath.Join(dir, "input")
	if err := os.Mkdir(source, 0o700); err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
	}
	startedAt := now()
	for _, file := range files {
		destination := filepath.Join(source, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
		}
		if err := os.WriteFile(destination, file.Bytes, os.FileMode(file.Mode)); err != nil {
			return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
		}
	}
	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_UNAVAILABLE")
	}
	bunPath, err := exec.LookPath("bun")
	if err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_UNAVAILABLE")
	}
	if real, err := filepath.EvalSymlinks(bunPath); err == nil {
		bunPath = real
	}
	bwrap := []string{
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--cap-drop", "ALL",
		"--ro-bind", "/usr", "/usr",
		"--symlink", "usr/bin", "/bin",
		"--symlink", "usr/lib", "/lib",
		"--symlink", "usr/lib64", "/lib64",
		"--proc", "/proc",
		"--dev", "/dev",
		"--size", "268435456", "--tmpfs", "/tmp",
		"--dir", "/home/sandbox",
		"--ro-bind", source, "/inputs",
		"--size", "536870912", "--tmpfs", "/workspace",
		"--ro-bind", bunPath, "/tools/bun",
		"--clearenv",
		"--setenv", "PATH", "/tools:/usr/bin:/bin",
		"--setenv", "HOME", "/home/sandbox",
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "CI", "1",
		"--setenv", "BUN_INSTALL_CACHE_DIR", "/tmp/bun-cache",
		"--chdir", "/workspace",
	}
	for _, path := range dependencies {
		bwrap = append(bwrap, "--ro-bind", path, "/dependencies")
	}
	bwrap = append(bwrap,
		"--remount-ro", "/",
		"--",
		"/usr/bin/prlimit", "--nproc=256",
		"--",
		"/bin/sh", "-c",
		"cp -a /inputs/. /workspace/ || exit 125; if [ -d /dependencies ]; then ln -s /dependencies /workspace/node_modules || exit 125; fi; exec /tools/bun \"$@\"",
		"convorel-exec",
	)
	bwrap = append(bwrap, tokens[1:]...)
	argv := []string{
		"prlimit",
		"--cpu=60",
		"--nofile=256",
		"--fsize=67108864",
		"--",
		bwrapPath,
	}
	argv = append(argv, bwrap...)
	result, err := runBounded(ctx, argv, processOptions{
		Dir:             "/",
		Env:             []string{},
		Timeout:         time.Duration(timeoutSeconds) * time.Second,
		CaptureLimit:    8192,
		KillOutputLimit: 1024 * 1024,
		CancelAsResult:  true,
	})
	if err != nil {
		return nil, workspace.Fail("EXEC_SANDBOX_FAILED")
	}
	data := map[string]any{
		"command":       command,
		"path":          selected.Root,
		"rootId":        identity.RootID,
		"workspaceId":   identity.WorkspaceID,
		"workspacePath": identity.WorkspacePath,
		"inputSha256":   inputSHA,
		"startedAt":     startedAt,
		"finishedAt":    now(),
		"exitCode":      optionalInt(result.code),
		"signal":        optionalString(result.signal),
		"timedOut":      result.timedOut,
		"outputLimited": result.outputLimited,
		"stdout":        string(result.stdout),
		"stderr":        string(result.stderr),
		"network":       false,
		"dependencies":  dependencies,
		"note":          executionNote,
	}
	if e.stateDir != "" {
		reports := filepath.Join(e.stateDir, "executions")
		if err := os.MkdirAll(reports, 0o700); err == nil {
			encoded, err := json.Marshal(data)
			if err == nil {
				_ = os.WriteFile(filepath.Join(reports, uuid()+".json"), encoded, 0o600)
			}
		}
	}
	return data, nil
}

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func uuid() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

func optionalInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
