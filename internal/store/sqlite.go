package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	_ "modernc.org/sqlite"
)

var (
	ErrTaskNotFound        = errors.New("TASK_NOT_FOUND")
	ErrRunNotFound         = errors.New("RUN_MISSING")
	ErrRequestNotFound     = errors.New("REQUEST_NOT_FOUND")
	ErrRequestConflict     = errors.New("REQUEST_CONFLICT")
	ErrTransitionConflict  = errors.New("TRANSITION_CONFLICT")
	ErrInvalidTransition   = errors.New("INVALID_TRANSITION")
	ErrRetryNotAllowed     = errors.New("RETRY_NOT_ALLOWED")
	ErrPriorRunNotComplete = errors.New("PRIOR_RUN_NOT_COMPLETE")
)

// Task IDs allow "_" so Weaver mission IDs (m_xxx) can prefix them verbatim.
var taskIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)

const taskIDRule = "task id must be 1-80 characters of lowercase letters, digits, '-' or '_', starting with a letter or digit"

// SQLiteStore is owned by one daemon. Its mutex serializes all writes; SQLite
// transactions make each document and its request claims durable together.
type SQLiteStore struct {
	mu                 sync.Mutex
	tasks, diagnostics *sql.DB
	diagnosticsErr     error
	diagnosticsEnabled bool
	directory          string
}

var _ Store = (*SQLiteStore)(nil)

// Open reuses tasks.db and diagnostics.db in place, migrating each to schema 2.
// Diagnostics initialization failure is reported by diagnostic operations and
// does not prevent task access. The caller must quiesce all 0.9 writers first.
func Open(stateDir string) (*SQLiteStore, error) {
	if stateDir == "" {
		return nil, errors.New("STATE_DIR_REQUIRED")
	}
	var err error
	stateDir, err = filepath.Abs(stateDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(stateDir, 0700); err != nil {
		return nil, err
	}
	tasks, err := openDatabase(filepath.Join(stateDir, "tasks.db"), 1129600050)
	if err != nil {
		return nil, err
	}
	s := &SQLiteStore{tasks: tasks, diagnosticsEnabled: true, directory: stateDir}
	if err = s.migrateTasks(context.Background()); err != nil {
		tasks.Close()
		return nil, err
	}
	s.diagnostics, err = openDatabase(filepath.Join(stateDir, "diagnostics.db"), 1129600051)
	if err == nil {
		err = s.migrateDiagnostics(context.Background())
	}
	if err == nil {
		var size int
		err = s.diagnostics.QueryRow("pragma page_size").Scan(&size)
		if err == nil {
			_, err = s.diagnostics.Exec(fmt.Sprintf("pragma max_page_count=%d; pragma journal_size_limit=4194304", 32*1024*1024/size))
		}
	}
	// Diagnostic loss cannot prevent reading or updating operational truth.
	if err != nil {
		s.diagnosticsErr = err
		if s.diagnostics != nil {
			s.diagnostics.Close()
			s.diagnostics = nil
		}
	}

	return s, nil
}
func (s *SQLiteStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var errs []error
	if s.tasks != nil {
		errs = append(errs, s.tasks.Close())
	}
	if s.diagnostics != nil {
		errs = append(errs, s.diagnostics.Close())
	}
	return errors.Join(errs...)
}
func openDatabase(path string, application int) (*sql.DB, error) {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		st, err := os.Lstat(path + suffix)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !st.Mode().IsRegular() {
			return nil, errors.New("DB_PATH_UNSAFE")
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path}
	q := u.Query()
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "synchronous(FULL)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		db.Close()
		return nil, err
	}
	_, err = identity(context.Background(), tx, application)
	tx.Rollback()
	if err != nil {
		db.Close()
		return nil, err
	}
	if _, err = db.Exec("pragma journal_mode=wal"); err != nil {
		db.Close()
		return nil, err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err = os.Chmod(path+suffix, 0600); err != nil && !errors.Is(err, os.ErrNotExist) {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}
func identity(ctx context.Context, tx *sql.Tx, application int) (int, error) {
	var kind, version int
	if err := tx.QueryRowContext(ctx, "pragma application_id").Scan(&kind); err != nil {
		return 0, err
	}
	if err := tx.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return 0, err
	}
	if (kind != application || version < 1 || version > 2) && (kind != 0 || version != 0) {
		return 0, errors.New("DB_VERSION_OR_KIND_UNSUPPORTED")
	}
	if kind == 0 {
		var n int
		if err := tx.QueryRowContext(ctx, "select count(*) from sqlite_master where name not like 'sqlite_%'").Scan(&n); err != nil {
			return 0, err
		}
		if n != 0 {
			return 0, errors.New("DB_VERSION_OR_KIND_UNSUPPORTED")
		}
	}
	return version, nil
}
func (s *SQLiteStore) migrateTasks(ctx context.Context) error {
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	version, err := identity(ctx, tx, 1129600050)
	if err != nil {
		return err
	}
	if version == 2 {
		return tx.Commit()
	}
	if version == 0 {
		if _, err = tx.ExecContext(ctx, `create table task_document (id text primary key, document text not null check(json_valid(document)), legacy_hash text); pragma application_id=1129600050;`); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `create table request_claim (request_key text primary key, task_id text not null, run_id text not null, input_hash text not null);`); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "select id,document from task_document order by id")
	if err != nil {
		return err
	}
	type doc struct{ id, body string }
	var docs []doc
	for rows.Next() {
		var d doc
		if err = rows.Scan(&d.id, &d.body); err != nil {
			rows.Close()
			return err
		}
		docs = append(docs, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, d := range docs {
		body, err := migrateDocument([]byte(d.body))
		if err != nil {
			return fmt.Errorf("task %s: %w", d.id, err)
		}
		var t Task
		if err = json.Unmarshal(body, &t); err != nil {
			return err
		}
		if t.ID != d.id {
			return errors.New("TASK_ID_MISMATCH")
		}
		for _, r := range t.Runs {
			if r.RequestID == "" {
				continue
			}
			if _, err = tx.ExecContext(ctx, "insert or ignore into request_claim values(?,?,?,?)", requestKey(t.ID, r.RequestID), t.ID, r.ID, r.InputHash); err != nil {
				return err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, "pragma user_version=2"); err != nil {
		return err
	}
	return tx.Commit()
}
func migrateDocument(data []byte) ([]byte, error) {
	var t map[string]json.RawMessage
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	var runs []map[string]json.RawMessage
	if err := json.Unmarshal(t["runs"], &runs); err != nil {
		return nil, err
	}
	if runs == nil {
		return nil, errors.New("TASK_RUNS_MISSING")
	}
	for _, r := range runs {
		var state Phase
		var user string
		if err := json.Unmarshal(r["state"], &state); err != nil {
			return nil, err
		}
		if raw := r["userMessageId"]; raw != nil {
			if err := json.Unmarshal(raw, &user); err != nil {
				return nil, err
			}
		}
		old := state
		switch state {
		case "submitting", "waiting":
			if user != "" {
				state = Delivered
			} else {
				state = DeliveryUnknown
			}
		case Prepared:
			if user != "" {
				state = Delivered
			}
		default:
			if !validPhase(state) {
				state = Failed
			}
		}
		if state != old {
			r["legacyState"], _ = json.Marshal(old)
			r["state"], _ = json.Marshal(state)
		}
		var facts map[string]json.RawMessage
		if raw := r["delivery"]; raw != nil {
			if err := json.Unmarshal(raw, &facts); err != nil {
				return nil, err
			}
		}
		if facts == nil {
			facts = map[string]json.RawMessage{}
		}
		if user != "" {
			facts["userMessageId"], _ = json.Marshal(user)
		}
		if state == Delivered || state == DeliveryUnknown || user != "" {
			facts["requestSent"] = json.RawMessage("true")
		}
		if len(facts) > 0 {
			r["delivery"], _ = json.Marshal(facts)
		}
	}
	// Legacy title verification is independent of reply completion. Never
	// silently restart an interrupted legacy rename while mapping run phases.
	if _, exists := t["namingState"]; !exists {
		naming := NamingState{State: "not_requested"}
		if raw := t["naming"]; len(raw) > 0 && string(raw) != "null" {
			naming.State = "pending"
			if raw := t["organization"]; len(raw) > 0 && string(raw) != "null" {
				var org struct {
					Verified bool   `json:"verified"`
					Title    string `json:"title"`
					Error    string `json:"error"`
					Rename   struct {
						Title string `json:"title"`
					} `json:"rename"`
				}
				if err := json.Unmarshal(raw, &org); err != nil {
					return nil, err
				}
				naming.Title = org.Title
				if naming.Title == "" {
					naming.Title = org.Rename.Title
				}
				naming.Verified = org.Verified
				naming.Error = org.Error
				if org.Verified {
					naming.State = "verified"
				} else {
					naming.State = "failed"
					if naming.Error == "" {
						naming.Error = "LEGACY_NAMING_REQUIRES_VERIFICATION"
					}
				}
			}
		}
		t["namingState"], _ = json.Marshal(naming)
	}
	var err error
	t["runs"], err = json.Marshal(runs)
	if err != nil {
		return nil, err
	}
	return json.Marshal(t)
}
func validPhase(p Phase) bool {
	switch p {
	case Prepared, Rejected, Delivered, DeliveryUnknown, Complete, Failed, Blocked, Superseded, Lost:
		return true
	}
	return false
}
func requestKey(task, request string) string {
	if request == "initial" {
		return "task:" + task + ":initial"
	}
	return "global:" + request
}
func readTask(ctx context.Context, tx *sql.Tx, id string) (Task, error) {
	var t Task
	var doc string
	err := tx.QueryRowContext(ctx, "select document from task_document where id=?", id).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrTaskNotFound
	}
	if err != nil {
		return t, err
	}
	if err = json.Unmarshal([]byte(doc), &t); err != nil {
		return t, err
	}
	if t.ID != id {
		return t, errors.New("TASK_ID_MISMATCH")
	}
	return t, nil
}
func writeTask(ctx context.Context, tx *sql.Tx, t Task) error {
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "insert into task_document(id,document) values(?,?) on conflict(id) do update set document=excluded.document", t.ID, string(b))
	return err
}
func claim(ctx context.Context, tx *sql.Tx, task string, r Run) error {
	_, err := tx.ExecContext(ctx, "insert into request_claim values(?,?,?,?)", requestKey(task, r.RequestID), task, r.ID, r.InputHash)
	return err
}
func lookup(ctx context.Context, tx *sql.Tx, task, request string) (Task, Run, error) {
	var owner, run string
	err := tx.QueryRowContext(ctx, "select task_id,run_id from request_claim where request_key=?", requestKey(task, request)).Scan(&owner, &run)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, Run{}, ErrRequestNotFound
	}
	if err != nil {
		return Task{}, Run{}, err
	}
	if owner != task {
		return Task{}, Run{}, ErrRequestConflict
	}
	t, err := readTask(ctx, tx, owner)
	if err != nil {
		return t, Run{}, err
	}
	// Imported 0.9 databases may contain a duplicate explicit key in two tasks.
	// Preserve both histories; the first claim still forbids any new duplicate.
	for _, r := range t.Runs {
		if r.ID == run {
			return t, r, nil
		}
	}
	return t, Run{}, ErrRunNotFound
}
func sameInput(a, b Run) bool {
	return a.InputHash == b.InputHash && (a.Input == "" || b.Input == "" || a.Input == b.Input)
}
func validateNewRun(r Run) error {
	if r.ID == "" || r.RequestID == "" || r.InputHash == "" {
		return errors.New("INVALID_RUN")
	}
	if r.State != Prepared || r.Delivery.RequestSent || r.UserMessageID != "" || r.Delivery.UserMessageID != "" || r.Delivery.POSTStatus != 0 {
		return ErrInvalidTransition
	}
	return nil
}
func (s *SQLiteStore) CreateTask(ctx context.Context, t Task) (Task, error) {
	t.RuntimeVersion = 2
	t.Legacy = false
	if t.NamingState == nil {
		t.NamingState = &NamingState{State: "not_requested"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !taskIDPattern.MatchString(t.ID) {
		return Task{}, fmt.Errorf("INVALID_TASK: %s, got %q", taskIDRule, t.ID)
	}
	if len(t.Runs) != 1 || t.CurrentRun != t.Runs[0].ID {
		return Task{}, errors.New("INVALID_TASK: a new task needs exactly one current run")
	}
	r := t.Runs[0]
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	existing, prior, err := lookup(ctx, tx, t.ID, r.RequestID)
	if err == nil {
		if !sameInput(prior, r) {
			return Task{}, ErrRequestConflict
		}
		return existing, nil
	}
	if !errors.Is(err, ErrRequestNotFound) {
		return Task{}, err
	}
	if _, err = readTask(ctx, tx, t.ID); err == nil {
		return Task{}, ErrRequestConflict
	} else if !errors.Is(err, ErrTaskNotFound) {
		return Task{}, err
	}
	if err = validateNewRun(r); err != nil {
		return Task{}, err
	}
	if t.Version == 0 {
		t.Version = 1
	}
	if t.Version != 1 {
		return Task{}, errors.New("STATE_VERSION_UNSUPPORTED")
	}
	if err = claim(ctx, tx, t.ID, r); err != nil {
		return Task{}, err
	}
	if err = writeTask(ctx, tx, t); err != nil {
		return Task{}, err
	}
	if err = tx.Commit(); err != nil {
		return Task{}, err
	}
	return t, nil
}
func (s *SQLiteStore) GetTask(ctx context.Context, id string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	return readTask(ctx, tx, id)
}
func (s *SQLiteStore) ByRequestID(ctx context.Context, task, request string) (Task, Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, Run{}, err
	}
	defer tx.Rollback()
	return lookup(ctx, tx, task, request)
}
func (s *SQLiteStore) AppendRun(ctx context.Context, id string, r Run) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback()
	_, prior, err := lookup(ctx, tx, id, r.RequestID)
	if err == nil {
		if !sameInput(prior, r) {
			return Run{}, ErrRequestConflict
		}
		return prior, nil
	}
	if !errors.Is(err, ErrRequestNotFound) {
		return Run{}, err
	}
	t, err := readTask(ctx, tx, id)
	if err != nil {
		return Run{}, err
	}
	var current *Run
	for i := range t.Runs {
		if t.Runs[i].ID == r.ID {
			return Run{}, ErrRequestConflict
		}
		if t.Runs[i].ID == t.CurrentRun {
			current = &t.Runs[i]
		}
	}
	if current == nil {
		return Run{}, ErrRunNotFound
	}
	if current.State != Complete && current.State != Lost {
		return Run{}, ErrPriorRunNotComplete
	}
	if err = validateNewRun(r); err != nil {
		return Run{}, err
	}
	t.Runs = append(t.Runs, r)
	t.CurrentRun = r.ID
	if err = claim(ctx, tx, id, r); err != nil {
		return Run{}, err
	}
	if err = writeTask(ctx, tx, t); err != nil {
		return Run{}, err
	}
	if err = tx.Commit(); err != nil {
		return Run{}, err
	}
	return r, nil
}
func (s *SQLiteStore) List(ctx context.Context) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.tasks.QueryContext(ctx, "select document from task_document order by id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []Task{}
	for rows.Next() {
		var doc string
		if err = rows.Scan(&doc); err != nil {
			return nil, err
		}
		var t Task
		if err = json.Unmarshal([]byte(doc), &t); err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}
func (s *SQLiteStore) History(ctx context.Context, id string) ([]Run, error) {
	t, err := s.GetTask(ctx, id)
	return t.Runs, err
}
