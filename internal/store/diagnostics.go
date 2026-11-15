package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const diagnosticSchema = `create table diagnostic_event (
 task_id text not null, seq integer not null, run_id text,
 recorded_at text not null, event text not null, step text, code text not null,
 retryable integer, pid integer not null, invocation text not null,
 primary key(task_id,seq),
 check(length(task_id) between 1 and 80),
 check(run_id is null or length(run_id)=36),
 check(event in ('phase','observe_failed','operation_result')),
 check(step is null or step in ('model','fill','send','observe','persist','naming','release')),
 check(length(code) between 1 and 64),
 check(retryable is null or retryable in (0,1))
);`

// Failure retains a bounded excerpt of the original error; callers must not put
// credentials or full page bodies in errors. Diagnostic writes never alter runs.
type Failure struct {
	TaskID    string
	RunID     string
	Event     string
	Step      string
	Code      string
	Error     error
	Retryable *bool
}
type DiagnosticEvent struct {
	TaskID     string  `json:"taskId"`
	Seq        int64   `json:"seq"`
	RunID      *string `json:"runId"`
	RecordedAt string  `json:"recordedAt"`
	Event      string  `json:"event"`
	Step       *string `json:"step"`
	Code       string  `json:"code"`
	Retryable  *bool   `json:"retryable"`
	PID        int     `json:"pid"`
	Invocation string  `json:"invocation"`
	Excerpt    string  `json:"excerpt,omitempty"`
}
type DiagnosticQuery struct {
	TaskID, RunID, Since string
	Limit                int
}

var codePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{1,63}$`)
var codePrefix = regexp.MustCompile(`^[A-Z][A-Z0-9_]+`)
var runIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var invocation = fmt.Sprintf("%x", randomInvocation())

func randomInvocation() []byte {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return []byte(time.Now().UTC().Format(time.RFC3339Nano))
	}
	return b[:]
}

func (s *SQLiteStore) migrateDiagnostics(ctx context.Context) error {
	tx, err := s.diagnostics.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	version, err := identity(ctx, tx, 1129600051)
	if err != nil {
		return err
	}
	if version == 0 {
		if _, err = tx.ExecContext(ctx, diagnosticSchema+"pragma application_id=1129600051;"); err != nil {
			return err
		}
	}
	if version < 2 {
		if _, err = tx.ExecContext(ctx, "alter table diagnostic_event add column excerpt text not null default ''; pragma user_version=2;"); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ClassifyError accepts explicit stable codes, and classifies common prose from
// browser/CDP/SQLite failures instead of reducing every unrecognized error to one code.
func ClassifyError(err error) string {
	if err == nil {
		return "UNCLASSIFIED"
	}
	text := strings.TrimPrefix(strings.TrimSpace(err.Error()), "Error: ")
	if token := codePrefix.FindString(text); codePattern.MatchString(token) {
		return token
	}
	lower := strings.ToLower(text)
	switch {
	case strings.HasPrefix(text, "Target conversation not visible in sidebar"), strings.HasPrefix(text, "Conversation rename action unavailable"), strings.HasPrefix(text, "Chat title input unavailable"):
		return "NAMING_CONTROL_UNAVAILABLE"
	case strings.HasPrefix(text, "Fresh conversation metadata unavailable"), strings.HasPrefix(text, "Conversation metadata request rejected"):
		return "NAMING_METADATA_UNAVAILABLE"
	case strings.HasPrefix(text, "Page URL changed;"):
		return "PAGE_URL_CHANGED"
	case strings.HasPrefix(text, "Response is generating;"):
		return "PAGE_NOT_IDLE"
	case strings.Contains(lower, "model control unavailable"), strings.Contains(lower, "unrecognized model ui response"):
		return "MODEL_CONTROL_UNAVAILABLE"
	case strings.Contains(lower, "selection did not persist"), strings.Contains(lower, "model control did not confirm"), strings.Contains(lower, "model option disabled"), strings.Contains(lower, "power control did not receive"):
		return "MODEL_UNVERIFIED"
	case strings.Contains(lower, "no accessibility node"), strings.Contains(lower, "selector"), strings.Contains(lower, "ambiguous"), strings.Contains(lower, "not visible"):
		return "UI_UNRECOGNIZED"
	case errors.Is(err, context.DeadlineExceeded), strings.Contains(lower, "timeout"), strings.Contains(lower, "timed out"):
		return "COMMAND_TIMEOUT"
	case errors.Is(err, context.Canceled):
		return "OPERATION_CANCELED"
	case strings.Contains(lower, "websocket"), strings.Contains(lower, "connection refused"), strings.Contains(lower, "connection reset"), strings.Contains(lower, "cdp"):
		return "CDP_UNAVAILABLE"
	case strings.Contains(lower, "sqlite"), strings.Contains(lower, "database"), strings.Contains(lower, "disk"):
		return "STATE_PERSIST_FAILED"
	default:
		return "UNCLASSIFIED"
	}
}
func excerpt(err error) string {
	if err == nil {
		return ""
	}
	s := strings.ToValidUTF8(err.Error(), "�")
	if len(s) <= 2048 {
		return s
	}
	n := 2048
	for !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
func validStep(step string) bool {
	switch step {
	case "model", "fill", "send", "observe", "persist", "naming", "release":
		return true
	}
	return false
}

// SetDiagnosticsEnabled applies the caller's diagnostics.enabled preference.
// Disabled writes are skipped; existing events remain readable.
func (s *SQLiteStore) SetDiagnosticsEnabled(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.diagnosticsEnabled = enabled
}
func (s *SQLiteStore) diagnosticWriteReady() (bool, error) {
	if !s.diagnosticsEnabled {
		return false, nil
	}
	if s.diagnosticsErr != nil {
		return false, s.diagnosticsErr
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(s.directory, &stat); err != nil {
		return false, err
	}
	return stat.Bavail*uint64(stat.Bsize) >= 64*1024*1024, nil
}
func (s *SQLiteStore) RecordFailure(ctx context.Context, f Failure) error {
	if !taskIDPattern.MatchString(f.TaskID) || !runIDPattern.MatchString(f.RunID) || !validStep(f.Step) {
		return errors.New("INVALID_DIAGNOSTIC")
	}
	if f.Event == "" {
		f.Event = "operation_result"
	}
	if f.Event != "operation_result" && (f.Event != "observe_failed" || f.Step != "observe") {
		return errors.New("INVALID_DIAGNOSTIC")
	}
	if f.Code == "" {
		f.Code = ClassifyError(f.Error)
	}
	if !codePattern.MatchString(f.Code) {
		return errors.New("INVALID_DIAGNOSTIC_CODE")
	}
	if f.Event != "observe_failed" {
		f.Retryable = nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ready, err := s.diagnosticWriteReady()
	if err != nil {
		return err
	}
	if !ready {
		return nil
	}
	tx, err := s.diagnostics.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = insertDiagnostic(ctx, tx, f.TaskID, f.RunID, f.Event, f.Step, f.Code, f.Retryable, excerpt(f.Error)); err != nil {
		return err
	}
	return tx.Commit()
}
func insertDiagnostic(ctx context.Context, tx *sql.Tx, task, run, event, step, code string, retryable *bool, excerpt string) error {
	var seq int64
	if err := tx.QueryRowContext(ctx, "select coalesce(max(seq),0)+1 from diagnostic_event where task_id=?", task).Scan(&seq); err != nil {
		return err
	}
	var stepValue any
	if step != "" {
		stepValue = step
	}
	_, err := tx.ExecContext(ctx, `insert into diagnostic_event(task_id,seq,run_id,recorded_at,event,step,code,retryable,pid,invocation,excerpt) values(?,?,?,?,?,?,?,?,?,?,?)`, task, seq, run, time.Now().UTC().Format(time.RFC3339Nano), event, stepValue, code, retryable, os.Getpid(), invocation, excerpt)
	return err
}

// RememberPhase suppresses repeated identical phases for a run.
func (s *SQLiteStore) RememberPhase(ctx context.Context, task, run string, phase Phase) error {
	if !taskIDPattern.MatchString(task) || !runIDPattern.MatchString(run) || !validPhase(phase) {
		return errors.New("INVALID_DIAGNOSTIC")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ready, err := s.diagnosticWriteReady()
	if err != nil {
		return err
	}
	if !ready {
		return nil
	}
	tx, err := s.diagnostics.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var last string
	err = tx.QueryRowContext(ctx, "select code from diagnostic_event where task_id=? and run_id=? and event='phase' order by seq desc limit 1", task, run).Scan(&last)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if last == string(phase) {
		return nil
	}
	if err = insertDiagnostic(ctx, tx, task, run, "phase", "", string(phase), nil, ""); err != nil {
		return err
	}
	return tx.Commit()
}

// Diagnostics returns filtered events and the count before limiting. Legacy
// events retain their original classifications; their excerpt is empty.
func (s *SQLiteStore) Diagnostics(ctx context.Context, q DiagnosticQuery) ([]DiagnosticEvent, int, error) {
	if q.TaskID != "" && !taskIDPattern.MatchString(q.TaskID) || q.RunID != "" && !runIDPattern.MatchString(q.RunID) || q.Limit < 0 {
		return nil, 0, errors.New("INVALID_DIAGNOSTIC_QUERY")
	}
	if q.Since != "" {
		if _, err := time.Parse(time.RFC3339Nano, q.Since); err != nil {
			return nil, 0, errors.New("INVALID_DIAGNOSTIC_QUERY")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.diagnosticsErr != nil {
		return nil, 0, s.diagnosticsErr
	}
	where := ` where (?='' or task_id=?) and (?='' or run_id=?) and (?='' or julianday(recorded_at)>=julianday(?))`
	args := []any{q.TaskID, q.TaskID, q.RunID, q.RunID, q.Since, q.Since}
	var total int
	if err := s.diagnostics.QueryRowContext(ctx, "select count(*) from diagnostic_event"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := q.Limit
	if limit == 0 {
		limit = 1000
	}
	rows, err := s.diagnostics.QueryContext(ctx, `select task_id,seq,run_id,recorded_at,event,step,code,retryable,pid,invocation,excerpt from diagnostic_event`+where+` order by recorded_at,task_id,seq limit ?`, append(args, limit)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	events := []DiagnosticEvent{}
	for rows.Next() {
		var e DiagnosticEvent
		if err = rows.Scan(&e.TaskID, &e.Seq, &e.RunID, &e.RecordedAt, &e.Event, &e.Step, &e.Code, &e.Retryable, &e.PID, &e.Invocation, &e.Excerpt); err != nil {
			return nil, 0, err
		}
		events = append(events, e)
	}
	return events, total, rows.Err()
}
