package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Verbatim 0.9 CREATE statements from src/storage/task-store.ts and
// src/storage/diagnostics.ts. Fixtures must not depend on the Go schema.
const legacyTasksDDL = `
create table task_document (
  id text primary key,
  document text not null check (json_valid(document)),
  legacy_hash text
);
pragma application_id = 1129600050;
pragma user_version = 1;
`
const legacyDiagnosticsDDL = `
create table diagnostic_event (
  task_id text not null,
  seq integer not null,
  run_id text,
  recorded_at text not null,
  event text not null,
  step text,
  code text not null,
  retryable integer,
  pid integer not null,
  invocation text not null,
  primary key (task_id, seq),
  check (length(task_id) between 1 and 80),
  check (run_id is null or length(run_id) = 36),
  check (event in ('phase', 'observe_failed', 'operation_result')),
  check (step is null or step in ('model', 'fill', 'send', 'observe', 'persist', 'naming', 'release')),
  check (length(code) between 1 and 64),
  check (retryable is null or retryable in (0, 1))
);
pragma application_id = 1129600051;
pragma user_version = 1;
`
const firstRunID = "12345678-1234-1234-1234-123456789abc"

func fixtureDB(t *testing.T, path, ddl string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec(ddl); err != nil {
		t.Fatal(err)
	}
	return db
}
func newStore(t *testing.T) *SQLiteStore {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestLegacyMigrationPreservesHistory(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db := fixtureDB(t, filepath.Join(dir, "tasks.db"), legacyTasksDDL)
	legacy := `{"version":1,"id":"old-task","workspaceId":"ws","config":{"version":1,"workspace":"/missing/old-project","legacyOption":{"keep":true}},"currentRun":"current","attemptId":"attempt","detachedBindings":[{"target":"old-target"}],"naming":{"type":"DES","topic":"old title"},"organization":{"verified":true,"title":"verified title"},"runs":[
 {"id":"a","requestId":"initial","inputHash":"a","state":"prepared","prompt":"原始输入","branch":["p"]},
 {"id":"b","requestId":"submitting-key","inputHash":"b","state":"submitting","sendRecoveries":[{"evidence":{"status":403}}]},
 {"id":"c","requestId":"waiting-key","inputHash":"c","state":"waiting","userMessageId":"user-c","observationError":{"message":"retained","retryable":true}},
 {"id":"d","requestId":"unconfirmed-key","inputHash":"d","state":"waiting"},
 {"id":"e","requestId":"complete-key","inputHash":"e","state":"complete","reply":{"id":"reply-e","markdown":"OK","legacyReply":17}},
 {"id":"f","requestId":"blocked-key","inputHash":"f","state":"blocked","userMessageId":"user-f"},
 {"id":"g","requestId":"lost-key","inputHash":"g","state":"lost","lost":{"at":"then"}},
 {"id":"current","requestId":"superseded-key","inputHash":"h","state":"superseded"}]}`
	if _, err := db.Exec("insert into task_document values(?,?,?)", "old-task", legacy, "original-file-hash"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	diag := fixtureDB(t, filepath.Join(dir, "diagnostics.db"), legacyDiagnosticsDDL)
	if _, err := diag.Exec(`insert into diagnostic_event values('old-task',1,?,'2025-01-01T00:00:00.000Z','observe_failed','observe','UNCLASSIFIED',1,123,'old-invocation')`, firstRunID); err != nil {
		t.Fatal(err)
	}
	diag.Close()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tasks, err := s.List(ctx)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("list=%+v err=%v", tasks, err)
	}
	if tasks[0].NamingState == nil || tasks[0].NamingState.State != "verified" || tasks[0].NamingState.Title != "verified title" {
		t.Fatalf("legacy naming %+v", tasks[0].NamingState)
	}
	history, err := s.History(ctx, "old-task")
	if err != nil {
		t.Fatal(err)
	}
	want := []Phase{Prepared, DeliveryUnknown, Delivered, DeliveryUnknown, Complete, Blocked, Lost, Superseded}
	for i, phase := range want {
		if history[i].State != phase {
			t.Fatalf("run %d: %s want %s", i, history[i].State, phase)
		}
	}
	if history[0].Prompt != "原始输入" || history[4].Reply.Markdown != "OK" || history[2].Delivery.UserMessageID != "user-c" {
		t.Fatalf("lost content: %+v", history)
	}
	var untouched string
	if err := s.tasks.QueryRow("select document from task_document").Scan(&untouched); err != nil || untouched != legacy {
		t.Fatal("opening/listing legacy data rewrote the original document", err)
	}
	// Exercise a typed write after migration, not merely unchanged SQL bytes.
	next := history[2]
	next.LastObservedAt = "now"
	if err = s.Transition(ctx, "old-task", "c", Delivered, next); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateTask(ctx, "old-task", func(t *Task) error { t.NamingState = &NamingState{State: "pending"}; return nil }); err != nil {
		t.Fatal(err)
	}
	var body, hash string
	if err = s.tasks.QueryRow("select document,legacy_hash from task_document").Scan(&body, &hash); err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{`"legacyOption":{"keep":true}`, `"detachedBindings":[{"target":"old-target"}]`, `"branch":["p"]`, `"legacyReply":17`, `"observationError":{"message":"retained","retryable":true}`, `"sendRecoveries"`, `"legacyState":"waiting"`} {
		if !strings.Contains(body, fragment) {
			t.Errorf("lost %s in %s", fragment, body)
		}
	}
	if hash != "original-file-hash" {
		t.Fatal("legacy hash changed")
	}
	events, total, err := s.Diagnostics(ctx, DiagnosticQuery{TaskID: "old-task"})
	if err != nil || total != 1 || events[0].Code != "UNCLASSIFIED" || events[0].Excerpt != "" || events[0].Retryable == nil || !*events[0].Retryable {
		t.Fatalf("legacy diagnostics %+v total=%d err=%v", events, total, err)
	}
	s.Close()
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var reopened string
	if err = s.tasks.QueryRow("select document from task_document").Scan(&reopened); err != nil {
		t.Fatal(err)
	}
	if reopened != body {
		t.Fatal("second migration rewrote document")
	}
	events, total, err = s.Diagnostics(ctx, DiagnosticQuery{})
	if err != nil || total != 1 {
		t.Fatalf("second open diagnostics %+v %d %v", events, total, err)
	}
}

func TestMigrationRollback(t *testing.T) {
	dir := t.TempDir()
	db := fixtureDB(t, filepath.Join(dir, "tasks.db"), legacyTasksDDL)
	for _, x := range []struct{ id, doc string }{{"a", `{"id":"a","runs":[{"state":"waiting"}]}`}, {"b", `{"id":"b","runs":"invalid"}`}} {
		if _, err := db.Exec("insert into task_document values(?,?,null)", x.id, x.doc); err != nil {
			t.Fatal(err)
		}
	}
	if s, err := Open(dir); err == nil {
		s.Close()
		t.Fatal("accepted malformed task")
	}
	var version int
	var body string
	if err := db.QueryRow("pragma user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 1 {
		t.Fatalf("failed migration advanced version %d", version)
	}
	if err := db.QueryRow("select document from task_document where id='a'").Scan(&body); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body, "delivery_unknown") {
		t.Fatal("partial migration committed")
	}
}

func TestLegacyDatabaseCopy(t *testing.T) {
	source := os.Getenv("CONVOREL_LEGACY_DB")
	if source == "" {
		t.Skip("set CONVOREL_LEGACY_DB to a disposable legacy tasks.db copy for A11")
	}
	dir := t.TempDir()
	// Never open the supplied path with SQLite. Include committed WAL bytes from
	// the supplied quiescent copy; SQLite rebuilds SHM only in our TempDir.
	for _, suffix := range []string{"", "-wal"} {
		b, err := os.ReadFile(source + suffix)
		if suffix != "" && errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "tasks.db")+suffix, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tasks, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("A11 copied legacy database lists %d tasks", len(tasks))
	for _, task := range tasks {
		runs, err := s.History(context.Background(), task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) != len(task.Runs) {
			t.Fatal("history differs")
		}
		for _, r := range runs {
			if !validPhase(r.State) {
				t.Fatalf("unmigrated state %s", r.State)
			}
		}
	}
}
func TestUnknownFieldsRoundTrip(t *testing.T) {
	var task Task
	if err := json.Unmarshal([]byte(`{"id":"test","config":{"custom":12,"browser":{"future":17}},"future":42,"runs":[{"futureRun":43,"reply":{"futureReply":44}}]}`), &task); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{`"future":42`, `"futureRun":43`, `"futureReply":44`, `"custom":12`, `"future":17`} {
		if !strings.Contains(string(data), v) {
			t.Fatalf("lost %s in %s", v, data)
		}
	}
}
