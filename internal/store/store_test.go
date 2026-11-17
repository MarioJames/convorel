package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func run(id, request string) Run {
	return Run{ID: id, RequestID: request, InputHash: "input-hash", Input: "only reply OK", Prompt: "frozen rendered prompt", PromptHash: "prompt-hash", Marker: "marker-" + id, CreatedAt: "2026-11-14T00:00:00Z", State: Prepared}
}
func task(id string, r Run) Task { return Task{Version: 1, ID: id, CurrentRun: r.ID, Runs: []Run{r}} }
func TestIdempotencyAndGlobalClaims(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	r := run(firstRunID, "initial")
	if _, err := s.CreateTask(ctx, task("one", r)); err != nil {
		t.Fatal(err)
	}
	retry := task("one", run("new-id", "initial"))
	got, err := s.CreateTask(ctx, retry)
	if err != nil || got.Runs[0].ID != r.ID {
		t.Fatalf("replay %+v %v", got, err)
	}
	if got.RuntimeVersion != 2 || got.Legacy || got.NamingState == nil || got.NamingState.State != "not_requested" {
		t.Fatalf("new task read as legacy or lost naming state: %+v", got)
	}
	retry.Runs[0].InputHash = "different"
	if _, err = s.CreateTask(ctx, retry); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("changed input: %v", err)
	}
	if _, err = s.CreateTask(ctx, task("two", r)); err != nil {
		t.Fatalf("initial must be task scoped: %v", err)
	}
	explicit := run("explicit-id", "global-key")
	if _, err = s.CreateTask(ctx, task("three", explicit)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateTask(ctx, task("four", explicit)); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("global conflict %v", err)
	}
	if _, _, err = s.ByRequestID(ctx, "four", "global-key"); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("foreign lookup %v", err)
	}
	if _, err = s.AppendRun(ctx, "one", run("next", "followup")); !errors.Is(err, ErrPriorRunNotComplete) {
		t.Fatalf("in flight append %v", err)
	}
	r.State = DeliveryUnknown
	r.Delivery.RequestSent = true
	if err = s.Transition(ctx, "one", r.ID, Prepared, r); err != nil {
		t.Fatal(err)
	}
	r.State = Complete
	r.Reply = &Reply{ID: "reply", Markdown: "OK"}
	if err = s.Transition(ctx, "one", r.ID, DeliveryUnknown, r); err != nil {
		t.Fatal(err)
	}
	appended, err := s.AppendRun(ctx, "one", run("next", "followup"))
	if err != nil || appended.ID != "next" {
		t.Fatalf("append %+v %v", appended, err)
	}
	replay, err := s.AppendRun(ctx, "one", run("ignored", "initial"))
	if err != nil || replay.ID != firstRunID {
		t.Fatalf("old replay %+v %v", replay, err)
	}
	history, err := s.History(ctx, "one")
	if err != nil || len(history) != 2 {
		t.Fatalf("history %d %v", len(history), err)
	}
}
func TestTransitionsProtectDeliveryAndPrompt(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	r := run(firstRunID, "initial")
	r.PromptContext = []byte(`{ "version": 1, "guidance": "frozen" }`)
	if _, err := s.CreateTask(ctx, task("test", r)); err != nil {
		t.Fatal(err)
	}
	bad := r
	bad.State = Rejected
	if err := s.Transition(ctx, "test", r.ID, Prepared, bad); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("unproven rejection %v", err)
	}
	rejected := r
	rejected.State = Rejected
	rejected.Delivery = DeliveryFacts{RequestSent: true, POSTStatus: 403}
	if err := s.Transition(ctx, "test", r.ID, Prepared, rejected); err != nil {
		t.Fatal(err)
	}
	if err := s.Transition(ctx, "test", r.ID, Prepared, rejected); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("stale compare %v", err)
	}
	if err := s.Transition(ctx, "test", r.ID, Rejected, r); err != nil {
		t.Fatalf("confirmed rejection retry %v", err)
	}
	unknown := r
	unknown.State = DeliveryUnknown
	unknown.Delivery.RequestSent = true
	if err := s.Transition(ctx, "test", r.ID, Prepared, unknown); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []Phase{Prepared, Rejected} {
		bad = unknown
		bad.State = phase
		if err := s.Transition(ctx, "test", r.ID, DeliveryUnknown, bad); !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("unknown -> %s %v", phase, err)
		}
	}
	bad = unknown
	bad.Prompt = "changed"
	if err := s.Transition(ctx, "test", r.ID, DeliveryUnknown, bad); err == nil {
		t.Fatal("allowed prompt overwrite")
	}
	delivered := unknown
	delivered.State = Delivered
	delivered.UserMessageID = "user"
	delivered.Delivery.UserMessageID = "user"
	if err := s.Transition(ctx, "test", r.ID, DeliveryUnknown, delivered); err != nil {
		t.Fatal(err)
	}
	bad = delivered
	bad.UserMessageID = ""
	bad.Delivery.UserMessageID = ""
	if err := s.Transition(ctx, "test", r.ID, Delivered, bad); err == nil {
		t.Fatal("erased confirmed identity")
	}
	bad = delivered
	bad.State = Complete
	if err := s.Transition(ctx, "test", r.ID, Delivered, bad); err == nil {
		t.Fatal("completed without captured reply")
	}
	got, err := s.GetTask(ctx, "test")
	if err != nil || got.Runs[0].State != Delivered || got.Runs[0].Prompt != r.Prompt {
		t.Fatalf("failed writes leaked %+v %v", got, err)
	}
}
func TestConcurrentClaimAndCompare(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	var wg sync.WaitGroup
	results := make(chan string, 24)
	errs := make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := s.CreateTask(ctx, task("test", run(firstRunID, "claim")))
			errs <- err
			if err == nil {
				results <- got.Runs[0].ID
			}
		}()
	}
	wg.Wait()
	close(errs)
	close(results)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for id := range results {
		if id != firstRunID {
			t.Fatal(id)
		}
	}
	var wins int
	var lock sync.Mutex
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := run(firstRunID, "claim")
			r.State = DeliveryUnknown
			r.Delivery.RequestSent = true
			err := s.Transition(ctx, "test", firstRunID, Prepared, r)
			if err == nil {
				lock.Lock()
				wins++
				lock.Unlock()
			} else if !errors.Is(err, ErrTransitionConflict) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("CAS winners %d", wins)
	}
}
func TestMetadataCannotOverwriteRuns(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	if _, err := s.CreateTask(ctx, task("test", run(firstRunID, "initial"))); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTask(ctx, "test", func(t *Task) error { t.Runs = nil; return nil }); err == nil {
		t.Fatal("metadata erased history")
	}
	if err := s.UpdateTask(ctx, "test", func(t *Task) error { t.NamingState = &NamingState{State: "failed", Error: "naming only"}; return nil }); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, "test")
	if err != nil || got.Runs[0].State != Prepared || got.NamingState.State != "failed" {
		t.Fatalf("metadata %+v %v", got, err)
	}
}
func TestDatabasePathAndIdentity(t *testing.T) {
	dir := t.TempDir()
	foreign := filepath.Join(t.TempDir(), "foreign")
	if err := os.WriteFile(foreign, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, filepath.Join(dir, "tasks.db")); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(dir); err == nil {
		s.Close()
		t.Fatal("followed db symlink")
	}
	dir = t.TempDir()
	db := fixtureDB(t, filepath.Join(dir, "tasks.db"), "create table foreign_data(value text); insert into foreign_data values('retained');")
	if s, err := Open(dir); err == nil {
		s.Close()
		t.Fatal("accepted foreign db")
	}
	var value string
	if err := db.QueryRow("select value from foreign_data").Scan(&value); err != nil || value != "retained" {
		t.Fatalf("foreign data changed %s %v", value, err)
	}
}
func TestDurableReopenAndPrivateWAL(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r := run(firstRunID, "initial")
	if _, err = s.CreateTask(ctx, task("test", r)); err != nil {
		t.Fatal(err)
	}
	r.State = DeliveryUnknown
	r.Delivery.RequestSent = true
	if err = s.Transition(ctx, "test", r.ID, Prepared, r); err != nil {
		t.Fatal(err)
	}
	var mode string
	var timeout int
	if err = s.tasks.QueryRow("pragma journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal %s %v", mode, err)
	}
	if err = s.tasks.QueryRow("pragma busy_timeout").Scan(&timeout); err != nil || timeout != 5000 {
		t.Fatalf("timeout %d %v", timeout, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		st, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0600 {
			t.Errorf("%s permission %v", e.Name(), st.Mode())
		}
		if strings.Contains(e.Name(), "lock") || strings.Contains(e.Name(), "mutex") {
			t.Errorf("unexpected lock %s", e.Name())
		}
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, run, err := s.ByRequestID(ctx, "test", "initial")
	if err != nil || got.ID != "test" || run.State != DeliveryUnknown || run.Prompt != r.Prompt {
		t.Fatalf("reopen %+v %+v %v", got, run, err)
	}
}

func TestDispatchIntentPersistsUnconfirmedRequestIdentity(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	r := run(firstRunID, "dispatch")
	if _, err := s.CreateTask(ctx, task("dispatch", r)); err != nil {
		t.Fatal(err)
	}
	next := r
	next.SubmittedAt = "2026-11-15T00:00:00Z"
	next.Delivery = DeliveryFacts{RequestSent: true, RequestUserMessageID: "candidate", ConversationID: "server-conversation"}
	if err := s.Transition(ctx, "dispatch", r.ID, Prepared, next); err != nil {
		t.Fatal(err)
	}
	saved, err := s.GetTask(ctx, "dispatch")
	if err != nil || saved.Runs[0].UserMessageID != "" || saved.Runs[0].Delivery.RequestUserMessageID != "candidate" {
		t.Fatal(saved, err)
	}
	rejected := next
	rejected.State = Rejected
	rejected.Delivery.POSTStatus = 403
	if err := s.Transition(ctx, "dispatch", r.ID, Prepared, rejected); err != nil {
		t.Fatal("request candidate prevented proven rejection", err)
	}
}
func TestTaskIDAcceptsWeaverMissionPrefix(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	// Weaver mission IDs look like m_f5fzpkyehi; the skill tells agents to use
	// <mission ID>-<dialogue name> verbatim as the Convorel task ID.
	if _, err := s.CreateTask(ctx, task("m_f5fzpkyehi-mixed-period", run(firstRunID, "initial"))); err != nil {
		t.Fatalf("mission-prefixed task id rejected: %v", err)
	}
	for _, id := range []string{"", "_lead", "Upper", "has space", "中文", strings.Repeat("a", 81)} {
		_, err := s.CreateTask(ctx, task(id, run("bad-"+id, "bad-"+id)))
		if err == nil || !strings.HasPrefix(err.Error(), "INVALID_TASK: ") || !strings.Contains(err.Error(), "task id") {
			t.Fatalf("%q: want INVALID_TASK naming the id rule, got %v", id, err)
		}
	}
}
