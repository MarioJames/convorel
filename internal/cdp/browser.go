package cdp

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Options struct {
	// Zero uses the 0.9 defaults (400ms / 1500ms); negative disables a delay.
	ActionInterval time.Duration
	NavigationWait time.Duration
	Mode           string
	Endpoint       string
	Executable     string
	UserDataDir    string
	Headless       bool
	// ExtraArgs is intended for environment-specific Chrome flags (e.g. CI sandbox).
	ExtraArgs       []string
	StartupTimeout  time.Duration
	IdleStopTimeout time.Duration
	Now             func() time.Time
}

// Manager owns a connection and only the Chrome process it personally launched.
type Manager struct {
	mu      sync.Mutex
	opts    Options
	client  *Client
	process *exec.Cmd
	exited  chan struct{}
	tabs    map[string]*PageTab
	owned   map[string]bool
	idle    *Idle
	pacing  *pacing
}

var _ Browser = (*Manager)(nil)

func New(opts Options) (*Manager, error) {
	ep, e := Endpoint(opts.Endpoint)
	if e != nil {
		return nil, e
	}
	opts.Endpoint = ep
	if opts.Mode == "" {
		opts.Mode = "external"
	}
	if opts.Mode != "managed" && opts.Mode != "external" {
		return nil, errors.New("INVALID_BROWSER_MODE")
	}
	if opts.Mode == "managed" {
		u, _ := url.Parse(ep)
		if u.Hostname() != "127.0.0.1" || u.Port() == "" || !filepath.IsAbs(opts.UserDataDir) {
			return nil, errors.New("managed browser requires IPv4 loopback port and absolute profile")
		}
	}
	if opts.StartupTimeout <= 0 {
		opts.StartupTimeout = 30 * time.Second
	}
	m := &Manager{opts: opts, tabs: map[string]*PageTab{}, owned: map[string]bool{}}
	if opts.IdleStopTimeout <= 0 {
		opts.IdleStopTimeout = 10 * time.Minute
	}
	m.idle = NewIdle(opts.IdleStopTimeout, opts.Now, m.Stop)
	m.pacing = newPacing(opts.ActionInterval, opts.NavigationWait)
	return m, nil
}
func (m *Manager) EnsureStarted(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ensure(ctx)
}
func (m *Manager) Ensure(ctx context.Context) error { return m.EnsureStarted(ctx) }
func (m *Manager) ensure(ctx context.Context) error {
	if m.client != nil {
		select {
		case <-m.client.Done():
			m.client = nil
			m.tabs = map[string]*PageTab{}
			m.owned = map[string]bool{}
		default:
			return nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, m.opts.StartupTimeout)
	defer cancel()
	if m.opts.Mode == "external" {
		c, e := Dial(ctx, m.opts.Endpoint)
		m.client = c
		return e
	}
	own, occupied := profileProcess(m.opts)
	if occupied && !own {
		return errors.New("MANAGED_BROWSER_PORT_IN_USE: another profile owns the port")
	}
	probe, pcancel := context.WithTimeout(ctx, 500*time.Millisecond)
	_, reachable := version(probe, m.opts.Endpoint)
	pcancel()
	if reachable == nil && !own {
		return errors.New("MANAGED_BROWSER_PORT_IN_USE: endpoint profile unverified")
	}
	if !own && reachable != nil {
		if m.process != nil {
			select {
			case <-m.exited:
				m.process = nil
			default:
				return errors.New("managed Chrome still running without CDP")
			}
		}
		if e := m.launch(); e != nil {
			return e
		}
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		c, e := Dial(ctx, m.opts.Endpoint)
		if e == nil {
			m.client = c
			return nil
		}
		select {
		case <-ctx.Done():
			m.stopProcess()
			return fmt.Errorf("MANAGED_BROWSER_START_FAILED: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}
func profileProcess(o Options) (own, occupied bool) {
	u, _ := url.Parse(o.Endpoint)
	entries, _ := os.ReadDir("/proc")
	for _, ent := range entries {
		b, e := os.ReadFile(filepath.Join("/proc", ent.Name(), "cmdline"))
		if e != nil {
			continue
		}
		// Chrome may rewrite /proc cmdline into a single space-delimited argv[0].
		line := " " + strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " ")) + " "
		profile := strings.Contains(line, " --user-data-dir="+o.UserDataDir+" ")
		port := strings.Contains(line, " --remote-debugging-port="+u.Port()+" ")
		child := strings.Contains(line, " --type=")
		if port && !child {
			occupied = true
			if profile {
				own = true
			}
		}
	}
	return
}
func (m *Manager) launch() error {
	if e := os.MkdirAll(m.opts.UserDataDir, 0700); e != nil {
		return e
	}
	exe := m.opts.Executable
	if exe == "" {
		var e error
		exe, e = exec.LookPath("google-chrome")
		if e != nil {
			return e
		}
	}
	u, _ := url.Parse(m.opts.Endpoint)
	args := []string{"--user-data-dir=" + m.opts.UserDataDir, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + u.Port(), "--no-first-run", "--no-default-browser-check"}
	if m.opts.Headless {
		v, e := exec.Command(exe, "--version").Output()
		if e != nil {
			return e
		}
		major := regexp.MustCompile(`(\d+)\.\d+\.\d+\.\d+`).FindSubmatch(v)
		if major == nil {
			return errors.New("CHROME_VERSION_UNKNOWN")
		}
		args = append(args, "--headless=new", "--window-size=1600,1000", "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+string(major[1])+".0.0.0 Safari/537.36")
	}
	args = append(args, m.opts.ExtraArgs...)
	args = append(args, "about:blank")
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if e := cmd.Start(); e != nil {
		return e
	}
	m.process = cmd
	m.exited = make(chan struct{})
	done := m.exited
	go func() { _ = cmd.Wait(); close(done) }()
	return nil
}

// processGroupActive ignores zombies, which cannot write the profile anymore.
func processGroupActive(group int) bool {
	entries, _ := os.ReadDir("/proc")
	for _, entry := range entries {
		b, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		end := strings.LastIndexByte(string(b), ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(b[end+1:]))
		if len(fields) > 2 && fields[0] != "Z" && fields[2] == fmt.Sprint(group) {
			return true
		}
	}
	return false
}
func (m *Manager) stopProcess() {
	if m.process == nil {
		return
	}
	pid := m.process.Process.Pid
	select {
	case <-m.exited:
	default:
		_ = m.process.Process.Signal(syscall.SIGTERM)
		select {
		case <-m.exited:
		case <-time.After(2 * time.Second):
			_ = m.process.Process.Kill()
			<-m.exited
		}
	}
	// Chrome's parent may exit before renderers finish touching the profile.
	// All signals target only the private process group created by launch.
	deadline := time.Now().Add(2 * time.Second)
	for processGroupActive(pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if processGroupActive(pid) {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		for n := 0; n < 100 && processGroupActive(pid); n++ {
			time.Sleep(10 * time.Millisecond)
		}
	}
	m.process = nil
}
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.process != nil {
		if m.client != nil {
			c, cancel := context.WithTimeout(ctx, time.Second)
			_ = m.client.Call(c, "", "Browser.close", nil, nil)
			cancel()
		}
		select {
		case <-m.exited:
		case <-time.After(time.Second):
		}
		m.stopProcess()
	}
	if m.client != nil {
		_ = m.client.Close()
		m.client = nil
	}
	m.tabs = map[string]*PageTab{}
	m.owned = map[string]bool{}
	return nil
}
func (m *Manager) IdleInfo() IdleInfo {
	info := m.idle.Info()
	m.mu.Lock()
	defer m.mu.Unlock()
	info.Managed = m.opts.Mode == "managed"
	if m.client != nil {
		select {
		case <-m.client.Done():
		default:
			info.Running = true
		}
	}
	return info
}
func (m *Manager) IdlePolicy() *Idle { return m.idle }
func (m *Manager) NewTab(ctx context.Context, rawURL string) (Tab, error) {
	var tab Tab
	err := m.pacing.run(ctx, true, func() error { var err error; tab, err = m.newTab(ctx, rawURL); return err })
	return tab, err
}
func (m *Manager) newTab(ctx context.Context, rawURL string) (Tab, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.ensure(ctx); e != nil {
		return nil, e
	}
	var r struct {
		ID string `json:"targetId"`
	}
	if rawURL == "" {
		rawURL = "about:blank"
	}
	if e := m.client.Call(ctx, "", "Target.createTarget", map[string]any{"url": rawURL}, &r); e != nil {
		return nil, e
	}
	m.owned[r.ID] = true
	return m.attach(ctx, r.ID, true)
}

// AttachTab explicitly binds an existing target, granting permission to drive
// it, but never permission to destroy the borrowed tab.
func (m *Manager) AttachTab(ctx context.Context, id string) (Tab, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.ensure(ctx); e != nil {
		return nil, e
	}
	tab, err := m.attach(ctx, id, m.owned[id])
	if err != nil {
		return nil, err
	}
	return tab, nil
}
func (m *Manager) attach(ctx context.Context, id string, owned bool) (*PageTab, error) {
	if t := m.tabs[id]; t != nil {
		if t.ctx.Err() == nil {
			return t, nil
		}
		delete(m.tabs, id)
	}
	targets, e := m.client.Targets(ctx)
	if e != nil {
		return nil, e
	}
	found := false
	for _, t := range targets {
		if t.ID == id && t.Type == "page" {
			found = true
		}
	}
	if !found {
		delete(m.owned, id)
		return nil, errors.New("TARGET_NOT_FOUND")
	}
	var r struct {
		ID string `json:"sessionId"`
	}
	if e = m.client.Call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": id, "flatten": true}, &r); e != nil {
		return nil, e
	}
	// ChatGPT parks a background tab's transcript in an inert hidden view, and
	// only one tab per window is in front. Each driven tab sees itself as the
	// visible, focused page for as long as this session stays attached.
	if e = m.client.Call(ctx, r.ID, "Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true}, nil); e != nil {
		return nil, e
	}
	t := newTab(m, id, r.ID, owned)
	m.tabs[id] = t
	return t, nil
}

// Targets discovers tabs without binding or driving them.
func (m *Manager) Targets(ctx context.Context) ([]Target, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.ensure(ctx); e != nil {
		return nil, e
	}
	return m.client.Targets(ctx)
}

// Idle uses an injectable clock and explicit Tick so the daemon controls its
// scheduling. Begin must span the entire run, including awaiting its reply.
type Idle struct {
	mu      sync.Mutex
	timeout time.Duration
	now     func() time.Time
	stop    func(context.Context) error
	last    time.Time
	count   int
}

func NewIdle(timeout time.Duration, now func() time.Time, stop func(context.Context) error) *Idle {
	if now == nil {
		now = time.Now
	}
	return &Idle{timeout: timeout, now: now, stop: stop, last: now()}
}
func (i *Idle) Begin() func() {
	i.mu.Lock()
	i.count++
	i.last = i.now()
	i.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { i.mu.Lock(); i.count--; i.last = i.now(); i.mu.Unlock() }) }
}
func (i *Idle) Tick(ctx context.Context) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.count != 0 || i.timeout <= 0 || i.now().Sub(i.last) < i.timeout {
		return nil
	}
	if e := i.stop(ctx); e != nil {
		return e
	}
	i.last = i.now()
	return nil
}
func (i *Idle) Info() IdleInfo {
	i.mu.Lock()
	defer i.mu.Unlock()
	return IdleInfo{LastActivity: i.last, InFlight: i.count}
}
