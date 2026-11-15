// Package archive projects conversation content into conversations.db.
//
// The task documents in tasks.db remain operational truth: they decide delivery,
// completion, retry authorization and tab ownership. This package only records
// what was asked and answered, keeps immutable content versions addressable, and
// indexes the selected prompt and best reply body for search. No archive outcome
// may change run state; the engine therefore reports PublishNotice (or Failure)
// separately from delivery results.
//
// The 0.9 conversations.db is opened in place: schema version 1, its FTS5 trigram
// index, its immutable-version rows and its run selections are all reused. A new
// archive is created from the same DDL so both generations read identically.
package archive

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	// dialectName is the database/sql driver registered by modernc.org/sqlite.
	dialectName = "sqlite"
	// busyTimeoutMS bounds contention with any external process that still holds
	// the 0.9 database during a cutover. The daemon itself serializes writes.
	busyTimeoutMS = 5000
)

var archiveReadOnly = errors.New("ARCHIVE_READONLY")

// Archive is one private connection to conversations.db. The daemon is the single
// writer, so an in-process lock replaces 0.9's cross-process archive locks.
type Archive struct {
	db       *sql.DB
	path     string
	writable bool
	mu       sync.RWMutex
}

// Open opens or creates <stateDir>/conversations.db for the daemon. The directory
// is made private; an existing v1 file is verified, not rewritten.
func Open(stateDir string) (*Archive, error) {
	return openAt(Path(stateDir), true)
}

// OpenExisting reads an exact archive file, including an exported snapshot or a
// copy of the legacy store, without creating or migrating anything. The handle is
// read-only: Publish, Reindex and ExportSnapshot return ARCHIVE_READONLY.
func OpenExisting(path string) (*Archive, error) {
	return openAt(path, false)
}

// Available reports whether a live archive file exists for stateDir. It does not
// open or verify the file.
func Available(stateDir string) bool {
	st, err := os.Stat(Path(stateDir))
	return err == nil && st.Mode().IsRegular()
}

func openAt(path string, writable bool) (*Archive, error) {
	if !writable {
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("ARCHIVE_MISSING")
		} else if err != nil {
			return nil, err
		}
	}
	if err := checkPrivate(path); err != nil {
		return nil, err
	}
	if writable {
		dir := filepath.Dir(path)
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open(dialectName, dataSourceName(path, !writable))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx := context.Background()
	closeOnError := func(err error) (*Archive, error) {
		_ = db.Close()
		return nil, err
	}
	if err = db.PingContext(ctx); err != nil {
		return closeOnError(err)
	}
	for _, pragma := range []string{
		fmt.Sprintf("pragma busy_timeout = %d", busyTimeoutMS),
		"pragma foreign_keys = on",
		"pragma temp_store = memory",
	} {
		if _, err = db.ExecContext(ctx, pragma); err != nil {
			return closeOnError(err)
		}
	}
	a := &Archive{db: db, path: path, writable: writable}
	if writable {
		// Archived content cannot be recovered from the remote service, so
		// durability outranks throughput and has no override.
		if _, err = db.ExecContext(ctx, "pragma synchronous = full"); err != nil {
			return closeOnError(err)
		}
		var mode string
		if err = db.QueryRowContext(ctx, "pragma journal_mode = wal").Scan(&mode); err != nil {
			return closeOnError(err)
		}
		if err = a.harden(); err != nil {
			return closeOnError(err)
		}
		if err = migrate(ctx, db); err != nil {
			return closeOnError(err)
		}
	} else if err = verify(ctx, db); err != nil {
		return closeOnError(err)
	}
	return a, nil
}

// dataSourceName keeps the exact file path (including spaces) addressable and
// selects read-only mode without a separate driver.
func dataSourceName(path string, readOnly bool) string {
	u := url.URL{Scheme: "file", Path: path}
	if readOnly {
		u.RawQuery = "mode=ro"
	}
	return u.String()
}

// checkPrivate refuses links and non-regular files for the database and both WAL
// sidecars: a link could redirect archived content outside the private directory.
func checkPrivate(path string) error {
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		st, err := os.Lstat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 || !st.Mode().IsRegular() {
			return fmt.Errorf("ARCHIVE_PATH_UNSAFE: %s", candidate)
		}
	}
	return nil
}

// harden covers the WAL sidecars as well as the main file. The 0700 directory is
// the primary control; 0600 keeps a looser parent from exposing archived content.
func (a *Archive) harden() error {
	if !a.writable {
		return nil
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		err := os.Chmod(a.path+suffix, 0600)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Path is the database file this handle reads or writes.
func (a *Archive) Path() string { return a.path }

// Close releases the connection. It does not delete or compact the archive.
func (a *Archive) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.db.Close()
}

// Stats describes the stored projection for doctor output and archive notices.
type Stats struct {
	Path             string `json:"path"`
	ArchiveVersion   int    `json:"archiveVersion"`
	Conversations    int64  `json:"conversations"`
	Tasks            int64  `json:"tasks"`
	Runs             int64  `json:"runs"`
	Versions         int64  `json:"versions"`
	MarkdownVersions int64  `json:"markdownVersions"`
	Bytes            int64  `json:"bytes"`
	JournalMode      string `json:"journalMode"`
}

// Stats counts archived objects. It is a reporting call and never a run outcome.
func (a *Archive) Stats(ctx context.Context) (Stats, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	s := Stats{Path: a.path, ArchiveVersion: Version}
	counts := []struct {
		query string
		dst   *int64
	}{
		{"select count(*) from conversation", &s.Conversations},
		{"select count(*) from task", &s.Tasks},
		{"select count(*) from run", &s.Runs},
		{"select count(*) from content_version", &s.Versions},
		{"select count(*) from content_version where format = 'markdown'", &s.MarkdownVersions},
	}
	for _, c := range counts {
		if err := a.db.QueryRowContext(ctx, c.query).Scan(c.dst); err != nil {
			return Stats{}, err
		}
	}
	var pages, pageSize int64
	if err := a.db.QueryRowContext(ctx, "pragma page_count").Scan(&pages); err != nil {
		return Stats{}, err
	}
	if err := a.db.QueryRowContext(ctx, "pragma page_size").Scan(&pageSize); err != nil {
		return Stats{}, err
	}
	s.Bytes = pages * pageSize
	if err := a.db.QueryRowContext(ctx, "pragma journal_mode").Scan(&s.JournalMode); err != nil {
		return Stats{}, err
	}
	return s, nil
}

// Integrity is a two-part health report: the SQLite file and the derived FTS
// index. A failed FTS check is reported, not repaired implicitly.
type Integrity struct {
	IntegrityCheck    string `json:"integrityCheck"`
	FTSIntegrityCheck string `json:"ftsIntegrityCheck"`
}

// Integrity runs SQLite's checks without changing archived content. FTS5's
// integrity-check command requires write access even though it is read-only in
// effect, so a handle opened with OpenExisting reports that restriction instead of
// claiming a healthy index; the daemon's writable handle returns "ok".
func (a *Archive) Integrity(ctx context.Context) Integrity {
	a.mu.RLock()
	defer a.mu.RUnlock()
	report := Integrity{}
	if err := a.db.QueryRowContext(ctx, "pragma integrity_check").Scan(&report.IntegrityCheck); err != nil {
		report.IntegrityCheck = err.Error()
	}
	if _, err := a.db.ExecContext(ctx,
		`insert into content_fts (content_fts, rank) values ('integrity-check', 1)`); err != nil {
		report.FTSIntegrityCheck = err.Error()
	} else {
		report.FTSIntegrityCheck = "ok"
	}
	return report
}

// Reindex rebuilds only the derived FTS index. Content versions are never
// regenerated, so citations stay stable across a repair.
func (a *Archive) Reindex(ctx context.Context) error {
	if !a.writable {
		return archiveReadOnly
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := a.db.ExecContext(ctx,
		`insert into content_fts (content_fts) values ('rebuild')`); err != nil {
		return err
	}
	_, err := a.db.ExecContext(ctx,
		`insert into content_fts (content_fts, rank) values ('integrity-check', 1)`)
	return err
}

// write runs work under BEGIN IMMEDIATE on one connection. A read-then-write
// projection needs write access from the first statement, or two importers could
// each read the pre-image and one commit would lose.
func (a *Archive) write(ctx context.Context, work func(queryer) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	conn, err := a.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "begin immediate"); err != nil {
		return err
	}
	if err = work(conn); err != nil {
		_, _ = conn.ExecContext(context.Background(), "rollback")
		return err
	}
	if _, err = conn.ExecContext(ctx, "commit"); err != nil {
		_, _ = conn.ExecContext(context.Background(), "rollback")
		return err
	}
	return nil
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func shaHex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// newUUID returns a v4 UUID without a dependency. Version IDs are opaque, but the
// 0.9 archive already holds RFC 4122 UUIDs and callers validate that shape.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// nullString stores an absent optional value as SQL NULL; 0.9 used `?? null`.
func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func stringPtr(ns sql.NullString) *string {
	if !ns.Valid {
		return nil
	}
	value := ns.String
	return &value
}

func int64Ptr(ns sql.NullInt64) *int64 {
	if !ns.Valid {
		return nil
	}
	value := ns.Int64
	return &value
}

func float64Ptr(ns sql.NullFloat64) *float64 {
	if !ns.Valid {
		return nil
	}
	value := ns.Float64
	return &value
}

// truncateNotice bounds an error echoed in a notice. It keeps the first 200 runes
// so the result stays valid UTF-8 and the notice cannot grow with a driver dump.
func truncateNotice(text string) string {
	runes := []rune(text)
	if len(runes) <= 200 {
		return text
	}
	return string(runes[:200])
}
