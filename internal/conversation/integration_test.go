package conversation_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/chatgpt/fixture"
	"github.com/MarioJames/convorel/internal/cli"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/conversation"
	"github.com/MarioJames/convorel/internal/daemon"
	"github.com/MarioJames/convorel/internal/store"
	"github.com/MarioJames/convorel/internal/workspace"
)

type rig struct {
	t       *testing.T
	ctx     context.Context
	paths   config.Paths
	st      *store.SQLiteStore
	ar      *archive.Archive
	browser *cdp.Manager
	engine  *conversation.Engine
	server  *daemon.Server
	fixture *fixture.Server
	cfg     config.Config
	factory chatgpt.Factory
	stop    context.CancelFunc
	served  chan error
}
type namedPage struct {
	*chatgpt.BrowserPage
	gate <-chan struct{}
}

func (p *namedPage) Rename(ctx context.Context, title string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.gate:
		return p.BrowserPage.Rename(ctx, title)
	}
}
func newRig(t *testing.T, o fixture.Options, idle time.Duration, gate <-chan struct{}) *rig {
	t.Helper()
	if _, err := os.Stat("/usr/bin/google-chrome"); err != nil {
		t.Skip("disposable headless Chrome unavailable: /usr/bin/google-chrome")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home+"/config")
	t.Setenv("XDG_CACHE_HOME", home+"/cache")
	t.Setenv("XDG_DATA_HOME", home+"/data")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "http://" + listener.Addr().String()
	listener.Close()
	browser, err := cdp.New(cdp.Options{Mode: "managed", Endpoint: endpoint, Executable: "/usr/bin/google-chrome", UserDataDir: t.TempDir(), Headless: true, ActionInterval: -1, NavigationWait: -1, IdleStopTimeout: idle, ExtraArgs: []string{"--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"}})
	if err != nil {
		t.Fatal(err)
	}
	paths := config.Paths{ConfigDir: t.TempDir(), StateDir: t.TempDir()}
	st, err := store.Open(paths.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := archive.Open(paths.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, ctx: ctx, paths: paths, st: st, ar: ar, browser: browser, fixture: fixture.New(o), cfg: config.Config{Version: 1, Workspace: t.TempDir(), Effort: 1, CDP: endpoint}}
	if gate != nil {
		r.factory = func(tab cdp.Tab) chatgpt.Page { return &namedPage{chatgpt.New(tab), gate} }
	}
	t.Cleanup(func() {
		r.shutdown()
		cancel()
		stopCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := browser.Stop(stopCtx); err != nil {
			t.Error(err)
		}
		r.fixture.Close()
		ar.Close()
		st.Close()
	})
	r.start()
	return r
}
func (r *rig) start() {
	r.t.Helper()
	ctx, stop := context.WithCancel(r.ctx)
	r.stop = stop
	engine, err := conversation.New(ctx, conversation.Options{Store: r.st, Archive: r.ar, Browser: r.browser, Config: func(context.Context) (config.Config, error) { return r.cfg, nil }, Factory: r.factory, StartURL: r.fixture.URL + "/"})
	if err != nil {
		r.t.Fatal(err)
	}
	r.engine = engine
	r.server = daemon.New()
	daemon.RegisterConversationEngine(r.server, engine)
	if err = r.server.Listen(r.paths.StateDir); err != nil {
		r.t.Fatal(err)
	}
	r.served = make(chan error, 1)
	go func() { r.served <- r.server.Serve(ctx) }()
}
func (r *rig) shutdown() {
	if r.stop == nil {
		return
	}
	r.stop()
	r.engine.Close()
	r.server.Close()
	if err := <-r.served; err != nil {
		r.t.Error(err)
	}
	r.stop = nil
}
func (r *rig) call(code int, args ...string) map[string]any {
	r.t.Helper()
	var out bytes.Buffer
	full := append([]string{"--config-dir", r.paths.ConfigDir, "--state-dir", r.paths.StateDir}, args...)
	got := cli.Run(r.ctx, full, strings.NewReader(""), &out)
	var v map[string]any
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		r.t.Fatalf("invalid JSON %q: %v", out.String(), err)
	}
	if got != code {
		r.t.Fatalf("%v exit %d want %d: %s", args, got, code, out.String())
	}
	return v
}
func (r *rig) eventually(fn func() bool) {
	r.t.Helper()
	until := time.Now().Add(10 * time.Second)
	for time.Now().Before(until) {
		if fn() {
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	r.t.Fatal("condition did not become true")
}
func TestCLICompletedNamingFollowup(t *testing.T) {
	gate := make(chan struct{})
	r := newRig(t, fixture.Options{Markdown: "OK", SlowReply: 600 * time.Millisecond, HiddenExtraForm: true}, time.Minute, gate)
	input := "Only reply OK.\n  Keep this input <verbatim> & intact.\n"
	ask := r.call(0, "ask", "--id", "first", "--prompt", input, "--type", "DES", "--topic", "Engine", "--effort", "1")
	if ask["delivery"] != "confirmed" || ask["userMessageId"] == "" {
		t.Fatal(ask)
	}
	task, err := r.st.GetTask(r.ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	run := task.Runs[0]
	if run.Input != input || run.Prompt != conversation.RenderPrompt(run.Marker, input, conversation.Context(r.cfg.Workspace)) || r.fixture.Requests()[0].Prompt != run.Prompt {
		t.Fatal("stored/rendered/transmitted prompt mismatch")
	}
	replay := r.call(0, "ask", "--id", "first", "--prompt", input)
	if replay["run"] != ask["run"] || len(r.fixture.Requests()) != 1 {
		t.Fatal("request replay sent again")
	}
	r.call(1, "ask", "--id", "first", "--prompt", "different")
	wait := r.call(0, "wait", "--id", "first", "--timeout-seconds", "10")
	if wait["reply"].(map[string]any)["markdown"] != "OK" {
		t.Fatal(wait)
	}
	completed, _ := time.Parse(time.RFC3339Nano, wait["completedAt"].(string))
	if time.Since(completed) > 3*time.Second {
		t.Fatal("wait completion exceeded 3 seconds")
	}
	status := r.call(0, "status", "--id", "first")
	if status["naming"].(map[string]any)["state"] != "pending" {
		t.Fatal("wait was gated on naming", status)
	}
	close(gate)
	r.eventually(func() bool {
		task, _ := r.st.GetTask(r.ctx, "first")
		return task.NamingState != nil && task.NamingState.Verified
	})
	status = r.call(0, "status", "--id", "first")
	if status["naming"].(map[string]any)["title"] != "1114｜DES｜Engine" {
		t.Fatal(status)
	}
	r.call(0, "followup", "--id", "first", "--prompt", "next", "--request-id", "follow", "--effort", "2")
	r.call(0, "wait", "--id", "first", "--timeout-seconds", "10")
	history := r.call(0, "history", "--id", "first")
	r.call(1, "ask", "--id", "collision", "--request-id", "follow", "--prompt", "next")
	if len(history["runs"].([]any)) != 2 || len(r.fixture.Requests()) != 2 {
		t.Fatal(history)
	}
	r.eventually(func() bool { _, err := r.engine.Finish(r.ctx, "first", ""); return err == nil })
	r.call(0, "result", "--id", "first", "--run", run.ID)
	search := r.call(0, "search", "--query", "verbatim")
	if search["total"].(float64) < 1 {
		t.Fatal(search)
	}
}
func TestCLIRejectedRetryFrozenPrompt(t *testing.T) {
	r := newRig(t, fixture.Options{Forbidden: true, Markdown: "OK"}, time.Minute, nil)
	v := r.call(2, "ask", "--id", "reject", "--prompt", "Only reply OK")
	if v["phase"] != "rejected" || v["deliveryFacts"].(map[string]any)["postStatus"] != float64(403) {
		t.Fatal(v)
	}
	r.fixture.SetOptions(fixture.Options{Markdown: "OK"})
	r.call(0, "retry", "--id", "reject")
	r.call(0, "wait", "--id", "reject", "--timeout-seconds", "10")
	reqs := r.fixture.Requests()
	if len(reqs) != 2 || reqs[0].Prompt != reqs[1].Prompt {
		t.Fatal("retry did not reuse rendered text", reqs)
	}
	task, _ := r.st.GetTask(r.ctx, "reject")
	tab, err := r.browser.AttachTab(r.ctx, task.Binding.Target)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := chatgpt.New(tab).Snapshot(r.ctx)
	if err != nil {
		t.Fatal(err)
	}
	users := 0
	for _, m := range snapshot.Messages {
		if m.Role == "user" {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("accepted browser message count %d", users)
	}
}
func TestCLIUnknownRefusesRetry(t *testing.T) {
	r := newRig(t, fixture.Options{CutBeforeInputMessage: true}, time.Minute, nil)
	v := r.call(2, "ask", "--id", "unknown", "--prompt", "Only reply OK")
	if v["phase"] != "delivery_unknown" {
		t.Fatal(v)
	}
	refused := r.call(1, "retry", "--id", "unknown")
	if refused["code"] != "RETRY_NOT_ALLOWED" {
		t.Fatal(refused)
	}
	// A bounded engine wait returns its current pending result; it never dispatches.
	ctx, cancel := context.WithTimeout(r.ctx, 100*time.Millisecond)
	defer cancel()
	pending, err := r.engine.Wait(ctx, "unknown", "")
	if err != nil || pending["phase"] != store.DeliveryUnknown {
		t.Fatal(pending, err)
	}
	cliPending := r.call(2, "wait", "--id", "unknown", "--timeout-seconds", "1")
	if cliPending["phase"] != "delivery_unknown" {
		t.Fatal(cliPending)
	}
	if len(r.fixture.Requests()) != 1 {
		t.Fatal("uncertain message was resent")
	}
}
func TestWaitClientHelper(t *testing.T) {
	if os.Getenv("CONVOREL_WAIT_HELPER") != "1" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(os.Getenv("CONVOREL_WAIT_ARGS")), &args); err != nil {
		os.Exit(90)
	}
	os.Exit(cli.Run(context.Background(), args, os.Stdin, os.Stdout))
}
func TestKilledWaitAndDaemonRecovery(t *testing.T) {
	r := newRig(t, fixture.Options{Markdown: "OK", SlowReply: 1800 * time.Millisecond}, time.Minute, nil)
	ask := r.call(0, "ask", "--id", "recover", "--prompt", "Only reply OK")
	r.call(1, "followup", "--id", "recover", "--request-id", "busy", "--prompt", "must not send")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args, _ := json.Marshal([]string{"--config-dir", r.paths.ConfigDir, "--state-dir", r.paths.StateDir, "wait", "--id", "recover", "--timeout-seconds", "10"})
	process := exec.Command(executable, "-test.run=^TestWaitClientHelper$")
	process.Env = append(os.Environ(), "CONVOREL_WAIT_HELPER=1", "CONVOREL_WAIT_ARGS="+string(args))
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill() })
	time.Sleep(150 * time.Millisecond)
	if err = process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = process.Wait()
	r.shutdown()
	// A replacement daemon gets a fresh CDP connection to the surviving Chrome.
	external, er := cdp.New(cdp.Options{Mode: "external", Endpoint: r.cfg.CDP, ActionInterval: -1, NavigationWait: -1})
	if er != nil {
		t.Fatal(er)
	}
	t.Cleanup(func() { _ = external.Stop(context.Background()) })
	r.browser = external
	r.start()
	wait := r.call(0, "wait", "--id", "recover", "--timeout-seconds", "10")
	if wait["run"] != ask["run"] || wait["reply"].(map[string]any)["markdown"] != "OK" {
		t.Fatal(wait)
	}
	again := r.call(0, "wait", "--id", "recover")
	if again["run"] != wait["run"] {
		t.Fatal(again)
	}
	if len(r.fixture.Requests()) != 1 {
		t.Fatal("restart duplicated submission")
	}
	r.eventually(func() bool { _, err := r.engine.Finish(r.ctx, "recover", ""); return err == nil })
	filepath.WalkDir(r.paths.StateDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(d.Name(), "lock") {
			t.Errorf("lock file created: %s", path)
		}
		return nil
	})
}
func TestIdleChromeStopsAndRelaunches(t *testing.T) {
	r := newRig(t, fixture.Options{Markdown: "OK", SlowReply: 500 * time.Millisecond}, 300*time.Millisecond, nil)
	r.call(0, "ask", "--id", "idle", "--prompt", "Only reply OK")
	// The run exceeds the idle timeout, but Chrome must remain alive.
	time.Sleep(350 * time.Millisecond)
	if !r.browser.IdleInfo().Running {
		t.Fatal("Chrome stopped during a run")
	}
	r.call(0, "wait", "--id", "idle", "--timeout-seconds", "10")
	r.eventually(func() bool { return !r.browser.IdleInfo().Running })
	r.call(0, "list")
	// The fixture exposes one conversation per origin. A fresh origin models
	// the distinct remote conversation created by a new task.
	r.fixture.Close()
	r.fixture = fixture.New(fixture.Options{Markdown: "OK"})
	r.cfg.ProjectURL = r.fixture.URL + "/"
	r.call(0, "ask", "--id", "awake", "--prompt", "Only reply OK")
	r.call(0, "wait", "--id", "awake", "--timeout-seconds", "10")
}

func TestPreparedIntentRecoveryNeverResends(t *testing.T) {
	r := newRig(t, fixture.Options{}, time.Minute, nil)
	tab, err := r.browser.NewTab(r.ctx, "about:blank")
	if err != nil {
		t.Fatal(err)
	}
	page := chatgpt.New(tab)
	if err = page.Open(r.ctx, r.fixture.URL+"/"); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after durable intent and before the first network fact.
	// The page must be preserved, even if it has no persisted conversation URL.
	if err = page.FillComposer(r.ctx, "preserve this unsent draft"); err != nil {
		t.Fatal(err)
	}
	id := "00000000-0000-4000-8000-000000000001"
	marker := "[CONVOREL:" + id + "]"
	prompt := conversation.RenderPrompt(marker, "Only reply OK", conversation.Context(r.cfg.Workspace))
	w, err := workspace.NewWorkspace(r.cfg.Workspace)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.st.CreateTask(r.ctx, store.Task{Version: 1, ID: "intent", Config: r.cfg, WorkspaceID: w.ID, CurrentRun: id, Binding: &store.Binding{Target: tab.ID(), Owned: true}, Runs: []store.Run{{ID: id, RequestID: "initial", InputHash: "unused", Prompt: prompt, PromptHash: "unused", Marker: marker, State: store.Prepared, CreatedAt: time.Now().Format(time.RFC3339Nano), SubmittedAt: time.Now().Format(time.RFC3339Nano)}}})
	if err != nil {
		t.Fatal(err)
	}
	r.shutdown()
	r.start()
	r.call(1, "retry", "--id", "intent")
	r.eventually(func() bool {
		task, _ := r.st.GetTask(r.ctx, "intent")
		return task.Runs[0].State == store.DeliveryUnknown
	})
	var draft string
	if err = tab.Evaluate(r.ctx, `document.querySelector('textarea').value`, &draft); err != nil {
		t.Fatal(err)
	}
	if draft != "preserve this unsent draft" || len(r.fixture.Requests()) != 0 {
		t.Fatalf("recovery changed draft or sent: %q %+v", draft, r.fixture.Requests())
	}
}

type failedNamingPage struct{ *chatgpt.BrowserPage }

func (p *failedNamingPage) Rename(context.Context, string) error {
	return errors.New("fixture rename unavailable")
}
func TestNamingAndArchiveFailuresDoNotChangeCompletion(t *testing.T) {
	r := newRig(t, fixture.Options{Markdown: "OK", SlowReply: 300 * time.Millisecond}, time.Minute, nil)
	r.shutdown()
	r.factory = func(tab cdp.Tab) chatgpt.Page { return &failedNamingPage{chatgpt.New(tab)} }
	r.start()
	if err := r.ar.Close(); err != nil {
		t.Fatal(err)
	}
	r.call(0, "ask", "--id", "notices", "--prompt", "Only reply OK", "--type", "DES", "--topic", "Notices")
	wait := r.call(0, "wait", "--id", "notices", "--timeout-seconds", "10")
	if wait["phase"] != "complete" {
		t.Fatal(wait)
	}
	r.eventually(func() bool {
		task, _ := r.st.GetTask(r.ctx, "notices")
		return task.NamingState != nil && task.NamingState.State == "failed"
	})
	status := r.call(0, "status", "--id", "notices")
	if status["phase"] != "complete" || status["archive"].(map[string]any)["status"] != "failed" {
		t.Fatal(status)
	}
	r.call(0, "result", "--id", "notices")
}
func TestNoPOSTRemainsPrepared(t *testing.T) {
	r := newRig(t, fixture.Options{MissingSendButton: true}, time.Minute, nil)
	ask := r.call(2, "ask", "--id", "prepared", "--prompt", "Only reply OK")
	if ask["phase"] != "prepared" || ask["deliveryFacts"].(map[string]any)["requestSent"] != false || len(r.fixture.Requests()) != 0 {
		t.Fatal(ask)
	}
	r.fixture.SetOptions(fixture.Options{Markdown: "OK"})
	// Retry reopens a rejected/new-conversation page, retaining the frozen text.
	// The existing page still lacks a control; this retry must remain safe.
	r.call(2, "retry", "--id", "prepared")
	if len(r.fixture.Requests()) != 0 {
		t.Fatal("missing Send dispatched a POST")
	}
	// A stopped managed browser loses its target. A proven unsent run may
	// create a replacement tab, retaining its frozen prompt and run ID.
	r.shutdown()
	if err := r.browser.Stop(r.ctx); err != nil {
		t.Fatal(err)
	}
	r.start()
	retried := r.call(0, "retry", "--id", "prepared")
	if retried["run"] != ask["run"] {
		t.Fatal("retry changed run")
	}
	r.call(0, "wait", "--id", "prepared", "--timeout-seconds", "10")
	if len(r.fixture.Requests()) != 1 {
		t.Fatal("retry did not send exactly once")
	}
}

func TestDifferentTasksObserveConcurrently(t *testing.T) {
	r := newRig(t, fixture.Options{Markdown: "OK", SlowReply: 2 * time.Second}, time.Minute, nil)
	other := fixture.New(fixture.Options{Markdown: "OK", SlowReply: 2 * time.Second})
	defer other.Close()
	r.call(0, "ask", "--id", "parallel-a", "--prompt", "Only reply OK")
	r.cfg.ProjectURL = other.URL + "/"
	r.call(0, "ask", "--id", "parallel-b", "--prompt", "Only reply OK")
	if r.browser.IdleInfo().InFlight != 2 {
		t.Fatalf("expected two active runs, got %+v", r.browser.IdleInfo())
	}
	r.call(0, "wait", "--id", "parallel-a", "--timeout-seconds", "10")
	r.call(0, "wait", "--id", "parallel-b", "--timeout-seconds", "10")
	if len(r.fixture.Requests()) != 1 || len(other.Requests()) != 1 {
		t.Fatal("cross-task submission contamination")
	}
}

func TestFinishMissingUnsentTarget(t *testing.T) {
	r := newRig(t, fixture.Options{MissingSendButton: true}, time.Minute, nil)
	r.call(2, "ask", "--id", "abandoned", "--prompt", "Only reply OK")
	if err := r.browser.Stop(r.ctx); err != nil {
		t.Fatal(err)
	}
	done := r.call(0, "finish", "--id", "abandoned")
	if done["cleanup"].(map[string]any)["alreadyGone"] != true {
		t.Fatal(done)
	}
	if len(r.fixture.Requests()) != 0 {
		t.Fatal("cleanup sent a message")
	}
}

func TestMarkerIdentitySurvivesRestartDuringReply(t *testing.T) {
	r := newRig(t, fixture.Options{OmitInputIdentity: true, SlowReply: 2 * time.Second, Markdown: "OK"}, time.Minute, nil)
	sent := r.call(0, "ask", "--id", "marker-recovery", "--prompt", "Only reply OK")
	if sent["phase"] != store.Delivered && sent["phase"] != "delivered" {
		t.Fatalf("ask waited for answer instead of persisting identity: %+v", sent)
	}
	if sent["userMessageId"] == "" || sent["reply"] != nil {
		t.Fatal(sent)
	}
	r.shutdown()
	r.start()
	result := r.call(0, "wait", "--id", "marker-recovery", "--timeout-seconds", "10")
	if result["userMessageId"] != sent["userMessageId"] || len(r.fixture.Requests()) != 1 {
		t.Fatal("restart changed identity or resent", result)
	}
}

type missingNetworkIdentityPage struct{ *chatgpt.BrowserPage }

func (p *missingNetworkIdentityPage) Send(ctx context.Context) (<-chan chatgpt.SubmissionEvent, error) {
	events, err := p.BrowserPage.Send(ctx)
	if err != nil {
		return nil, err
	}
	out := make(chan chatgpt.SubmissionEvent, 32)
	go func() {
		defer close(out)
		for e := range events {
			if e.Kind == chatgpt.HTTPStatus || e.Kind == chatgpt.InputMessage {
				continue
			}
			select {
			case out <- e:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}
func TestDOMIdentityWithoutHTTPRemainsObserveOnly(t *testing.T) {
	r := newRig(t, fixture.Options{SlowReply: 2 * time.Second, Markdown: "OK"}, time.Minute, nil)
	r.shutdown()
	r.factory = func(tab cdp.Tab) chatgpt.Page { return &missingNetworkIdentityPage{chatgpt.New(tab)} }
	r.start()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = r.engine.Execute(r.ctx, "ask", map[string]string{"id": "dom-only", "prompt": "Only reply OK"})
	}()
	r.eventually(func() bool {
		task, err := r.st.GetTask(r.ctx, "dom-only")
		return err == nil && task.Runs[0].UserMessageID != "" && task.Runs[0].State == store.DeliveryUnknown
	})
	r.call(1, "retry", "--id", "dom-only")
	r.shutdown()
	r.start()
	r.call(0, "wait", "--id", "dom-only", "--timeout-seconds", "10")
	<-done
	if len(r.fixture.Requests()) != 1 {
		t.Fatal("uncertain input was resent")
	}
}

// A first-send POST can be accepted before either canonical identity reaches the
// daemon. Kill Chrome as systemd does, then discover only by the durable marker.
func TestFirstSendRecoveryAfterChromeDeathBeforeInput(t *testing.T) {
	r := newRig(t, fixture.Options{OmitInputIdentity: true, BeforeInputDelay: 3 * time.Second, SlowReply: time.Second, Markdown: "OK", RequirePageAuth: true, ListDelay: 300 * time.Millisecond, StaleSidebar: true}, time.Minute, nil)
	r.cfg.ProjectURL = r.fixture.URL + "/g/g-p-fixture/project"
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = r.engine.Execute(r.ctx, "ask", map[string]string{"id": "early-restart", "prompt": "Only reply OK", "effort": "1"})
	}()
	r.eventually(func() bool {
		task, err := r.st.GetTask(r.ctx, "early-restart")
		return err == nil && task.Runs[0].Delivery.RequestSent && task.Runs[0].UserMessageID == "" && len(r.fixture.Requests()) == 1
	})
	before, _ := r.st.GetTask(r.ctx, "early-restart")
	if before.URL != "" || before.Runs[0].Delivery.ConversationID != "" {
		t.Fatal("fixture missed pre-identity window", before)
	}
	r.shutdown()
	<-done
	if err := r.browser.Stop(r.ctx); err != nil {
		t.Fatal(err)
	}
	r.start()
	result := r.call(0, "wait", "--id", "early-restart", "--timeout-seconds", "15")
	if result["userMessageId"] == "" || len(r.fixture.Requests()) != 1 {
		t.Fatal("did not recover exact single send", result, r.fixture.Requests())
	}
	task, _ := r.st.GetTask(r.ctx, "early-restart")
	tab, err := r.browser.AttachTab(r.ctx, task.Binding.Target)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := chatgpt.New(tab).Snapshot(r.ctx)
	users := 0
	for _, m := range snap.Messages {
		if m.Role == "user" {
			users++
			if strings.Count(m.Text, task.Runs[0].Marker) != 1 {
				t.Fatal("wrong marker adopted")
			}
		}
	}
	if err != nil || users != 1 {
		t.Fatalf("page users=%d error=%v", users, err)
	}
	r.eventually(func() bool { _, err := r.engine.Finish(r.ctx, "early-restart", ""); return err == nil })
}
