package mcp

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

type processOptions struct {
	Dir     string
	Env     []string
	Timeout time.Duration
	// MaxOutput bounds each stream separately and fails the call when exceeded.
	MaxOutput int
	// CaptureLimit, when positive, switches to the sandbox capture mode: both
	// streams share one counter, at most CaptureLimit bytes are retained, and
	// KillOutputLimit terminates a runaway process.
	CaptureLimit    int
	KillOutputLimit int
	// CancelAsResult returns a killed result instead of COMMAND_CANCELLED when
	// the caller context ends. The isolated executor uses this to report the
	// observed termination like 0.9.
	CancelAsResult bool
}

type processResult struct {
	stdout        []byte
	stderr        []byte
	code          *int
	signal        *string
	timedOut      bool
	outputLimited bool
}

var (
	errOutputLimit = errors.New("COMMAND_OUTPUT_LIMIT")
	errCancelled   = errors.New("COMMAND_CANCELLED")
)

type captureWriter struct {
	mu     sync.Mutex
	buffer []byte
	max    int
	over   bool

	combined *int
	shared   *sync.Mutex
	capture  int
	killAt   int
	kill     func()
}

func (c *captureWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.combined != nil {
		c.shared.Lock()
		defer c.shared.Unlock()
		remaining := c.capture - *c.combined
		if remaining > 0 {
			take := len(p)
			if take > remaining {
				take = remaining
			}
			c.buffer = append(c.buffer, p[:take]...)
		}
		*c.combined += len(p)
		if c.killAt > 0 && *c.combined > c.killAt && c.kill != nil {
			c.kill()
		}
		return len(p), nil
	}
	if c.max > 0 && len(c.buffer)+len(p) > c.max {
		c.over = true
		return 0, errOutputLimit
	}
	c.buffer = append(c.buffer, p...)
	return len(p), nil
}

func (c *captureWriter) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte{}, c.buffer...)
}

func (c *captureWriter) limited() bool {
	if c.combined != nil {
		c.shared.Lock()
		defer c.shared.Unlock()
		return *c.combined > c.capture
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.over
}

// runBounded executes one argv in its own process group, enforcing a timeout,
// bounds and whole-group cleanup on failure.
func runBounded(ctx context.Context, argv []string, options processOptions) (processResult, error) {
	if len(argv) == 0 {
		return processResult{}, errors.New("COMMAND_DENIED")
	}
	if options.Timeout <= 0 {
		options.Timeout = 30 * time.Second
	}
	if err := ctx.Err(); err != nil {
		return processResult{}, errCancelled
	}
	runCtx, cancel := context.WithTimeout(ctx, options.Timeout)
	defer cancel()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = options.Dir
	cmd.Env = options.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	kill := func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}
	var combined int
	shared := &sync.Mutex{}
	stdout := &captureWriter{max: options.MaxOutput}
	stderr := &captureWriter{max: options.MaxOutput}
	if options.CaptureLimit > 0 {
		stdout.combined, stderr.combined = &combined, &combined
		stdout.shared, stderr.shared = shared, shared
		stdout.capture, stderr.capture = options.CaptureLimit, options.CaptureLimit
		stdout.killAt, stderr.killAt = options.KillOutputLimit, options.KillOutputLimit
		stdout.kill, stderr.kill = kill, kill
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return processResult{}, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-runCtx.Done():
		kill()
		<-done
		if ctx.Err() != nil && !options.CancelAsResult {
			return processResult{}, errCancelled
		}
		result := processResult{
			stdout:   stdout.Bytes(),
			stderr:   stderr.Bytes(),
			signal:   signalName(syscall.SIGKILL),
			timedOut: ctx.Err() == nil,
		}
		return result, nil
	case <-done:
		if stdout.over || stderr.over {
			return processResult{}, errOutputLimit
		}
		result := processResult{
			stdout:        stdout.Bytes(),
			stderr:        stderr.Bytes(),
			outputLimited: stdout.limited() || stderr.limited(),
		}
		if state := cmd.ProcessState; state != nil {
			if status, ok := state.Sys().(syscall.WaitStatus); ok {
				if status.Signaled() {
					result.signal = signalName(status.Signal())
				} else {
					code := status.ExitStatus()
					result.code = &code
				}
			}
		}
		return result, nil
	}
}

func signalName(signal syscall.Signal) *string {
	names := map[syscall.Signal]string{
		syscall.SIGHUP:  "SIGHUP",
		syscall.SIGINT:  "SIGINT",
		syscall.SIGQUIT: "SIGQUIT",
		syscall.SIGILL:  "SIGILL",
		syscall.SIGABRT: "SIGABRT",
		syscall.SIGFPE:  "SIGFPE",
		syscall.SIGKILL: "SIGKILL",
		syscall.SIGSEGV: "SIGSEGV",
		syscall.SIGPIPE: "SIGPIPE",
		syscall.SIGALRM: "SIGALRM",
		syscall.SIGTERM: "SIGTERM",
	}
	name, ok := names[signal]
	if !ok {
		name = signal.String()
	}
	return &name
}

func childEnvironment() []string {
	keys := []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"}
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}
