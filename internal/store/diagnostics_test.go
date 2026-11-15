package store

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestDiagnosticsClassifiedExcerptAndFiltering(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	message := "No accessibility node found for selector 'main form': " + strings.Repeat("汉", 1000)
	if err := s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "fill", Error: errors.New(message)}); err != nil {
		t.Fatal(err)
	}
	if err := s.RememberPhase(ctx, "test", firstRunID, DeliveryUnknown); err != nil {
		t.Fatal(err)
	}
	if err := s.RememberPhase(ctx, "test", firstRunID, DeliveryUnknown); err != nil {
		t.Fatal(err)
	}
	retry := true
	if err := s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Event: "observe_failed", Step: "observe", Error: context.DeadlineExceeded, Retryable: &retry}); err != nil {
		t.Fatal(err)
	}
	events, total, err := s.Diagnostics(ctx, DiagnosticQuery{TaskID: "test", RunID: firstRunID})
	if err != nil || total != 3 || len(events) != 3 {
		t.Fatalf("events=%+v total=%d err=%v", events, total, err)
	}
	if events[0].Code != "UI_UNRECOGNIZED" || len(events[0].Excerpt) > 2048 || !utf8.ValidString(events[0].Excerpt) || !strings.HasPrefix(message, events[0].Excerpt) {
		t.Fatalf("excerpt %+v", events[0])
	}
	if events[1].Code != string(DeliveryUnknown) || events[2].Code != "COMMAND_TIMEOUT" || events[2].Retryable == nil || !*events[2].Retryable {
		t.Fatalf("events %+v", events)
	}
	limited, count, err := s.Diagnostics(ctx, DiagnosticQuery{Limit: 1})
	if err != nil || len(limited) != 1 || count != 3 {
		t.Fatalf("limit=%+v total=%d err=%v", limited, count, err)
	}
	empty, count, err := s.Diagnostics(ctx, DiagnosticQuery{Since: "2999-01-01T00:00:00Z"})
	if err != nil || len(empty) != 0 || count != 0 {
		t.Fatalf("since=%+v total=%d err=%v", empty, count, err)
	}
	for _, err := range []error{
		s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "send", Event: "observe_failed"}),
		s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "send", Code: "invalid code"}),
		s.RecordFailure(ctx, Failure{TaskID: "test", RunID: "bad", Step: "send"}),
	} {
		if err == nil {
			t.Fatal("accepted invalid diagnostic")
		}
	}
}
func TestDiagnosticConcurrentSequenceAndFailureIsolation(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, err := s.CreateTask(ctx, task("test", run(firstRunID, "initial"))); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "observe", Error: errors.New("websocket connection reset")}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	events, total, err := s.Diagnostics(ctx, DiagnosticQuery{})
	if err != nil || total != 16 {
		t.Fatalf("events %d err %v", total, err)
	}
	for i, e := range events {
		if e.Seq != int64(i+1) {
			t.Fatalf("sequence %+v", events)
		}
	}
	if err = s.diagnostics.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "persist", Error: errors.New("disk full")}); err == nil {
		t.Fatal("closed diagnostic db write succeeded")
	}
	got, err := s.GetTask(ctx, "test")
	if err != nil || got.Runs[0].State != Prepared {
		t.Fatalf("diagnostic failure changed run %+v %v", got, err)
	}
}
func TestClassifyError(t *testing.T) {
	for _, x := range []struct{ message, want string }{
		{"COMPOSER_AMBIGUOUS: two controls", "COMPOSER_AMBIGUOUS"},
		{"Error: NEEDS_ATTENTION: login", "NEEDS_ATTENTION"},
		{"Model control unavailable on page", "MODEL_CONTROL_UNAVAILABLE"},
		{"Conversation rename action unavailable", "NAMING_CONTROL_UNAVAILABLE"},
		{"Fresh conversation metadata unavailable", "NAMING_METADATA_UNAVAILABLE"},
		{"Latest selection did not persist", "MODEL_UNVERIFIED"},
		{"Page URL changed; stopping", "PAGE_URL_CHANGED"},
		{"websocket: connection refused", "CDP_UNAVAILABLE"},
		{"sqlite: database is locked", "STATE_PERSIST_FAILED"},
		{"unknown prose", "UNCLASSIFIED"},
	} {
		if got := ClassifyError(errors.New(x.message)); got != x.want {
			t.Errorf("%q: got %s want %s", x.message, got, x.want)
		}
	}
}

func TestDiagnosticsDisabledAndUnavailable(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	s.SetDiagnosticsEnabled(false)
	if err := s.RecordFailure(ctx, Failure{TaskID: "test", RunID: firstRunID, Step: "send", Error: errors.New("failure")}); err != nil {
		t.Fatal(err)
	}
	if err := s.RememberPhase(ctx, "test", firstRunID, Prepared); err != nil {
		t.Fatal(err)
	}
	events, total, err := s.Diagnostics(ctx, DiagnosticQuery{})
	if err != nil || len(events) != 0 || total != 0 {
		t.Fatalf("disabled events %+v %d %v", events, total, err)
	}
	// A foreign diagnostics database must not stop ordinary task persistence.
	dir := t.TempDir()
	db := fixtureDB(t, filepath.Join(dir, "diagnostics.db"), "create table other(data text);")
	db.Close()
	independent, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer independent.Close()
	if _, err = independent.CreateTask(ctx, task("test", run(firstRunID, "initial"))); err != nil {
		t.Fatal(err)
	}
	if _, _, err = independent.Diagnostics(ctx, DiagnosticQuery{}); err == nil {
		t.Fatal("foreign diagnostic db was accepted")
	}
}
