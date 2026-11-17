// Package conversation owns durable run submission and daemon-lived observation.
package conversation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/rpc"
	"github.com/MarioJames/convorel/internal/store"
	"github.com/MarioJames/convorel/internal/workspace"
)

type Options struct {
	Store   *store.SQLiteStore
	Archive *archive.Archive
	Browser cdp.Browser
	Config  func(context.Context) (config.Config, error)
	Factory chatgpt.Factory
	// StartURL permits an alternate loopback page in disposable integrations.
	StartURL string
}
type taskState struct {
	mu     sync.Mutex
	active bool
	ready  chan struct{}
	page   chatgpt.Page
	tab    cdp.Tab
}
type Engine struct {
	opts    Options
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	tasks   map[string]*taskState
	notices map[string]archive.Notice
	wg      sync.WaitGroup
	release sync.Mutex
}

func New(ctx context.Context, opts Options) (*Engine, error) {
	if opts.Store == nil || opts.Browser == nil || opts.Config == nil {
		return nil, errors.New("conversation: store, browser and config are required")
	}
	if opts.Factory == nil {
		opts.Factory = chatgpt.NewPage
	}
	ctx, cancel := context.WithCancel(ctx)
	e := &Engine{opts: opts, ctx: ctx, cancel: cancel, tasks: map[string]*taskState{}, notices: map[string]archive.Notice{}}
	tasks, err := opts.Store.List(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	for _, task := range tasks {
		// Historic 0.9 records remain read-only until explicitly operated on.
		if task.Legacy || task.Binding != nil && task.Binding.Closed {
			continue
		}
		run, er := selectRun(task, "")
		if er != nil {
			continue
		}
		// A durable dispatch intent with no recorded network outcome cannot grant a resend.
		if run.State == store.Prepared && run.SubmittedAt != "" {
			next := run
			next.State = store.DeliveryUnknown
			next.Delivery.RequestSent = true
			next.Error = "DISPATCH_INTERRUPTED: observe only; delivery not established"
			if err = opts.Store.Transition(ctx, task.ID, run.ID, run.State, next); err != nil {
				cancel()
				return nil, err
			}
			run = next
		}
		if task.Naming != nil && task.NamingState == nil {
			var old struct {
				Verified bool   `json:"verified"`
				Title    string `json:"title"`
			}
			_ = json.Unmarshal(task.Organization, &old)
			ns := &store.NamingState{State: "pending"}
			if old.Verified {
				ns.State = "verified"
				ns.Verified = true
				ns.Title = old.Title
			}
			if err = opts.Store.UpdateTask(ctx, task.ID, func(t *store.Task) error { t.NamingState = ns; return nil }); err != nil {
				cancel()
				return nil, err
			}
			task.NamingState = ns
		}
		pendingName := run.State == store.Complete && task.Naming != nil && task.NamingState != nil && task.NamingState.State == "pending"
		if run.State == store.Delivered || run.State == store.DeliveryUnknown || pendingName {
			state := e.task(task.ID)
			state.mu.Lock()
			e.launch(state, task.ID, run.ID, false)
			state.mu.Unlock()
		}
	}
	if idle, ok := opts.Browser.(interface{ IdlePolicy() *cdp.Idle }); ok {
		e.wg.Add(1)
		go func() {
			defer e.wg.Done()
			tick := time.NewTicker(100 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					_ = idle.IdlePolicy().Tick(ctx)
				}
			}
		}()
	}
	return e, nil
}
func (e *Engine) Close() { e.cancel(); e.wg.Wait() }
func (e *Engine) task(id string) *taskState {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.tasks[id] == nil {
		e.tasks[id] = &taskState{}
	}
	return e.tasks[id]
}
func (e *Engine) begin() func() {
	if b, ok := e.opts.Browser.(interface{ IdlePolicy() *cdp.Idle }); ok {
		return b.IdlePolicy().Begin()
	}
	return func() {}
}
func quoteJSON(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.NewReplacer(`\u2028`, " ", `\u2029`, " ").Replace(strings.TrimSuffix(b.String(), "\n"))
}
func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func selectRun(t store.Task, id string) (store.Run, error) {
	if id == "" {
		id = t.CurrentRun
	}
	for _, r := range t.Runs {
		if r.ID == id {
			return r, nil
		}
	}
	return store.Run{}, store.ErrRunNotFound
}
func (e *Engine) read(id, run string) (store.Task, store.Run, error) {
	t, err := e.opts.Store.GetTask(e.ctx, id)
	if err != nil {
		return t, store.Run{}, err
	}
	r, err := selectRun(t, run)
	return t, r, err
}
func output(t store.Task, r store.Run) map[string]any {
	delivery := "pending"
	switch r.State {
	case store.Delivered, store.Complete:
		delivery = "confirmed"
	case store.Rejected:
		delivery = "rejected"
	case store.DeliveryUnknown:
		delivery = "unknown"
	case store.Prepared:
		delivery = "not_sent"
	}
	v := map[string]any{"id": t.ID, "run": r.ID, "phase": r.State, "delivery": delivery, "deliveryFacts": r.Delivery, "userMessageId": r.UserMessageID, "conversationId": r.Delivery.ConversationID, "reply": r.Reply, "naming": t.NamingState, "binding": t.Binding, "error": r.Error, "completedAt": r.CompletedAt}
	if r.Draft != nil {
		// The text is reported only while it is not back in its composer.
		draft := *r.Draft
		if draft.State == "restored" {
			draft.Text = ""
		}
		v["draft"] = draft
	}
	return v
}
func (e *Engine) Status(ctx context.Context, id, run string) (map[string]any, error) {
	t, r, err := e.read(id, run)
	if err != nil {
		return nil, err
	}
	v := output(t, r)
	e.mu.Lock()
	notice, exists := e.notices[id]
	e.mu.Unlock()
	if exists {
		v["archive"] = notice
	} else if e.opts.Archive == nil {
		v["archive"] = archive.Unavailable(nil)
	}
	return v, nil
}
func (e *Engine) Ask(ctx context.Context, p map[string]string, followup bool) (map[string]any, error) {
	id := p["id"]
	state := e.task(id)
	state.mu.Lock()
	input := p["prompt"]
	request := p["request-id"]
	if request == "" && !followup {
		request = "initial"
	}
	if strings.TrimSpace(input) == "" || len(input) > 100000 || request == "" || len(request) > 120 {
		state.mu.Unlock()
		return nil, rpc.NewError("INVALID_REQUEST", "nonempty prompt and request-id required")
	}
	if t, r, err := e.opts.Store.ByRequestID(e.ctx, id, request); err == nil {
		state.mu.Unlock()
		if t.ID != id || r.InputHash != digest(input) {
			return nil, store.ErrRequestConflict
		}
		if p["type"] != "" && (t.Naming == nil || t.Naming.Type != p["type"] || t.Naming.Topic != strings.TrimSpace(p["topic"]) || p["language"] != "" && t.Naming.Language != p["language"]) {
			return nil, rpc.NewError("NAMING_CONFLICT", "request-id already has different naming")
		}
		if p["workspace"] != "" && p["workspace"] != t.Config.Workspace {
			return nil, rpc.NewError("WORKSPACE_MISMATCH", "task workspace is immutable")
		}
		return output(t, r), nil
	} else if !errors.Is(err, store.ErrRequestNotFound) {
		state.mu.Unlock()
		return nil, err
	}
	var t store.Task
	var err error
	if followup {
		t, err = e.opts.Store.GetTask(e.ctx, id)
	} else {
		var c config.Config
		c, err = e.opts.Config(e.ctx)
		if err == nil {
			if p["workspace"] != "" {
				c.Workspace = p["workspace"]
			}
			if p["effort"] != "" {
				c.Effort, err = strconv.Atoi(p["effort"])
			}
			if c.Effort == 0 {
				c.Effort = 5
			}
			if c.Effort < 1 || c.Effort > 5 {
				err = rpc.NewError("INVALID_REQUEST", "effort must be 1..5")
			}
		}
		if err == nil {
			var w *workspace.Workspace
			w, err = workspace.NewWorkspace(c.Workspace)
			if err == nil {
				c.Workspace = w.Root
				t = store.Task{Version: 1, ID: id, Config: c, WorkspaceID: w.ID, AttemptID: uuid()}
			}
		}
		if err == nil && (p["type"] != "" || p["topic"] != "") {
			lang := p["language"]
			if lang == "" {
				lang = "en"
			}
			_, err = chatgpt.ConversationTitle(time.Now(), p["type"], p["topic"], "Asia/Shanghai", lang)
			if err == nil {
				t.Naming = &store.Naming{Type: p["type"], Topic: strings.TrimSpace(p["topic"]), Language: lang}
				t.NamingState = &store.NamingState{State: "pending"}
			}
		}
	}
	if err != nil {
		state.mu.Unlock()
		return nil, err
	}
	if state.active {
		state.mu.Unlock()
		return nil, rpc.NewError("RUN_IN_FLIGHT", "one run per task may be active")
	}
	pc := Context(t.Config.Workspace)
	pc.Effort = t.Config.Effort
	if p["effort"] != "" {
		effort, er := strconv.Atoi(p["effort"])
		if er != nil || effort < 1 || effort > 5 {
			state.mu.Unlock()
			return nil, rpc.NewError("INVALID_REQUEST", "effort must be 1..5")
		}
		pc.Effort = effort
	}
	b, _ := json.Marshal(pc)
	rid := uuid()
	marker := "[CONVOREL:" + rid + "]"
	prompt := RenderPrompt(marker, input, pc)
	r := store.Run{ID: rid, RequestID: request, Input: input, InputHash: digest(input), PromptContext: b, Prompt: prompt, PromptHash: digest(prompt), Marker: marker, State: store.Prepared, CreatedAt: now()}
	if followup {
		r, err = e.opts.Store.AppendRun(e.ctx, id, r)
	} else {
		t.CurrentRun = r.ID
		t.Runs = []store.Run{r}
		t, err = e.opts.Store.CreateTask(e.ctx, t)
	}
	if err != nil {
		state.mu.Unlock()
		return nil, err
	}
	ready := e.launch(state, id, r.ID, true)
	state.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-ready:
		return e.Status(ctx, id, r.ID)
	}
}
func (e *Engine) Retry(ctx context.Context, id, run string) (map[string]any, error) {
	s := e.task(id)
	s.mu.Lock()
	_, r, err := e.read(id, run)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if !r.State.Retryable() || r.SubmittedAt != "" && r.State == store.Prepared {
		s.mu.Unlock()
		return nil, rpc.NewError("RETRY_NOT_ALLOWED", "uncertain or confirmed delivery is observe-only")
	}
	if s.active {
		s.mu.Unlock()
		return nil, rpc.NewError("RUN_IN_FLIGHT", "already observing")
	}
	ready := e.launch(s, id, r.ID, true)
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-ready:
		return e.Status(ctx, id, r.ID)
	}
}

// Wait observes durable state; its cancellation has no effect on the engine job.
func (e *Engine) Wait(ctx context.Context, id, run string) (map[string]any, error) {
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		v, err := e.Status(ctx, id, run)
		if err != nil {
			return nil, err
		}
		phase := v["phase"].(store.Phase)
		if phase == store.Complete {
			t, r, err := e.read(id, run)
			if err != nil {
				return nil, err
			}
			if err = verifyResult(r); err != nil {
				return nil, err
			}
			if t.Naming != nil && t.NamingState != nil && t.NamingState.State == "failed" {
				state := e.task(id)
				state.mu.Lock()
				if !state.active {
					e.launch(state, id, r.ID, false)
				}
				state.mu.Unlock()
			}
		}
		if phase == store.Complete || phase == store.Failed || phase == store.Blocked || phase == store.Superseded {
			return v, nil
		}
		if phase.Retryable() {
			return v, nil
		}
		select {
		case <-ctx.Done():
			return v, nil
		case <-tick.C:
		}
	}
}
func (e *Engine) launch(s *taskState, id, rid string, send bool) <-chan struct{} {
	s.active = true
	s.ready = make(chan struct{})
	ready := s.ready
	end := e.begin()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		defer end()
		var once sync.Once
		signal := func() { once.Do(func() { close(ready) }) }
		defer signal()
		defer func() { s.mu.Lock(); s.active = false; s.mu.Unlock() }()
		for {
			e.run(s, id, rid, send, signal)
			task, run, err := e.read(id, rid)
			if err != nil || (run.State != store.Delivered && run.State != store.DeliveryUnknown) {
				return
			}
			// Recover interrupted observations in the daemon, retaining the
			// same idle reservation. This loop can never submit a message.
			signal()
			send = false
			delay := time.Second
			if task.URL == "" {
				delay = 5 * time.Second
			}
			select {
			case <-e.ctx.Done():
				return
			case <-time.After(delay):
			}
		}
	}()
	return ready
}
func (e *Engine) persist(id string, old store.Run, next store.Run) error {
	err := e.opts.Store.Transition(e.ctx, id, old.ID, old.State, next)
	if err == nil {
		_ = e.opts.Store.RememberPhase(e.ctx, id, next.ID, next.State)
	}
	return err
}
func (e *Engine) failure(id, rid, step string, err error) {
	if err == nil || e.ctx.Err() != nil {
		return
	}
	_, r, er := e.read(id, rid)
	if er == nil {
		next := r
		next.Error = err.Error()
		_ = e.persist(id, r, next)
	}
	_ = e.opts.Store.RecordFailure(e.ctx, store.Failure{TaskID: id, RunID: rid, Step: step, Event: "operation_result", Error: err})
}
func (e *Engine) publish(id string) {
	notice := archive.Unavailable(nil)
	if e.opts.Archive != nil {
		t, err := e.opts.Store.GetTask(e.ctx, id)
		if err == nil {
			b, _ := json.Marshal(t)
			notice = e.opts.Archive.PublishNotice(e.ctx, t, digest(string(b)))
		} else {
			notice = archive.Failure(err)
		}
	}
	e.mu.Lock()
	e.notices[id] = notice
	e.mu.Unlock()
}

func (e *Engine) open(s *taskState, t store.Task, r store.Run) (chatgpt.Page, error) {
	if err := e.opts.Browser.EnsureStarted(e.ctx); err != nil {
		return nil, err
	}
	if s.page != nil && t.Binding != nil {
		if _, attachErr := e.opts.Browser.AttachTab(e.ctx, t.Binding.Target); attachErr != nil {
			s.page = nil
			s.tab = nil
		}
	}
	if s.page != nil {
		if t.URL != "" {
			if err := s.page.Attach(e.ctx, identity(t, r, false)); err != nil {
				return nil, err
			}
			return s.page, nil
		}
		if r.State == store.Rejected {
			if err := s.page.Open(e.ctx, e.startURL(t)); err != nil {
				return nil, err
			}
		}
		return s.page, nil
	}
	var tab cdp.Tab
	var created bool
	var err error
	if t.Binding != nil && !t.Binding.Closed && t.Binding.Target != "" {
		tab, err = e.opts.Browser.AttachTab(e.ctx, t.Binding.Target)
	}
	if tab == nil {
		if t.URL == "" && !r.State.Retryable() {
			return e.recoverFirst(s, t, r)
		}
		raw := "about:blank"
		if t.URL != "" {
			raw = t.URL
		}
		tab, err = e.opts.Browser.NewTab(e.ctx, raw)
		created = true
	}
	if err != nil {
		return nil, err
	}
	page := e.opts.Factory(tab)
	if t.URL != "" {
		err = page.Attach(e.ctx, identity(t, r, false))
		if created {
			for attempt := 0; err != nil && attempt < 40; attempt++ {
				select {
				case <-e.ctx.Done():
					return nil, e.ctx.Err()
				case <-time.After(100 * time.Millisecond):
				}
				err = page.Attach(e.ctx, identity(t, r, false))
			}
		}
	} else if r.State.Retryable() {
		err = page.Open(e.ctx, e.startURL(t))
	} else {
		// An uncertain first send can precede persistence of the final URL.
		// Reattach to its existing target without navigating or clearing it.
		if obs, ok := page.(observable); ok {
			snap, er := obs.Snapshot(e.ctx)
			err = er
			matches := 0
			users := 0
			for _, m := range snap.Messages {
				if m.Role == "user" {
					users++
					if strings.Count(m.Text, r.Marker) == 1 && (r.UserMessageID == "" || r.UserMessageID == m.ID) {
						matches++
					}
				}
			}
			if err == nil && (users != 1 || matches != 1 || r.Delivery.ConversationID != "" && r.Delivery.ConversationID != snap.ConversationID) {
				err = errors.New("delivery_unknown: existing target lacks exact first-send marker")
			}
			if err == nil && snap.ConversationID != "" {
				err = page.Attach(e.ctx, chatgpt.Identity{URL: snap.URL, ConversationID: snap.ConversationID})
				if err == nil {
					err = e.bindURL(t, snap.ConversationID, obs)
				}
			}
		} else {
			err = errors.New("page cannot resume observation")
		}
	}
	if err != nil {
		if created {
			_ = tab.Close(e.ctx)
		}
		return nil, err
	}
	s.tab = tab
	s.page = page
	err = e.opts.Store.UpdateTask(e.ctx, t.ID, func(task *store.Task) error {
		owned := created || t.Binding != nil && t.Binding.Owned
		task.Binding = &store.Binding{Target: tab.ID(), Owned: owned, Epoch: tab.ID()}
		return nil
	})
	return page, err
}
func (e *Engine) startURL(t store.Task) string {
	if t.Config.ProjectURL != "" {
		return t.Config.ProjectURL
	}
	return e.opts.StartURL
}
func identity(t store.Task, r store.Run, previous bool) chatgpt.Identity {
	cid := r.Delivery.ConversationID
	if cid == "" {
		cid = conversationID(t.URL)
	}
	id := chatgpt.Identity{URL: t.URL, ConversationID: cid}
	if previous {
		id.UserMessageID = r.UserMessageID
		if r.Reply != nil {
			id.AssistantMessageID = r.Reply.ID
		}
	}
	return id
}
func conversationID(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	for i := range parts {
		if parts[i] == "c" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}
