package archive_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
)

func TestOpenCreatesPrivateVersionOneSchema(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	a := openArchive(t, dir)
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != 0700 {
		t.Fatalf("state dir mode: %v %v", st, err)
	}
	if st, err := os.Stat(archive.Path(dir)); err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("archive mode: %v %v", st, err)
	}
	stats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ArchiveVersion != 1 || stats.JournalMode != "wal" || stats.Versions != 0 {
		t.Fatalf("stats: %+v", stats)
	}

	raw := rawDB(t, archive.Path(dir))
	var version int
	if err := raw.QueryRow("pragma user_version").Scan(&version); err != nil || version != 1 {
		t.Fatalf("user_version: %d %v", version, err)
	}
	var kind string
	if err := raw.QueryRow("select value from meta where key = 'dbKind'").Scan(&kind); err != nil || kind != archive.DBKind {
		t.Fatalf("dbKind: %q %v", kind, err)
	}
	var ddl string
	if err := raw.QueryRow("select sql from sqlite_master where name = 'content_fts'").Scan(&ddl); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ddl, "trigram case_sensitive 0") || !strings.Contains(ddl, "content_rowid='id'") {
		t.Fatalf("FTS DDL: %s", ddl)
	}
	if err := a.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	report := a.Integrity(ctx)
	if report.IntegrityCheck != "ok" || report.FTSIntegrityCheck != "ok" {
		t.Fatalf("integrity: %+v", report)
	}
	if _, err := a.Publish(ctx, taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "防枚举"})
	if err != nil || len(hits.Hits) != 1 {
		t.Fatalf("search after reindex: %+v %v", hits, err)
	}
}

func TestForeignAndUnsupportedDatabasesAreRefused(t *testing.T) {
	t.Run("foreign file", func(t *testing.T) {
		dir := t.TempDir()
		path := archive.Path(dir)
		raw := rawDB(t, path)
		mustExec(t, raw, "create table something(a)")
		raw.Close()
		_, err := archive.Open(dir)
		if err == nil || !strings.Contains(err.Error(), "NOT_A_CONVOREL_ARCHIVE: database already holds other objects") {
			t.Fatalf("open foreign: %v", err)
		}
		_, err = archive.OpenExisting(path)
		if err == nil || !strings.Contains(err.Error(), "NOT_A_CONVOREL_ARCHIVE") {
			t.Fatalf("read foreign: %v", err)
		}
	})

	t.Run("wrong db kind", func(t *testing.T) {
		dir := t.TempDir()
		path := archive.Path(dir)
		raw := rawDB(t, path)
		mustExec(t, raw, "create table meta (key text primary key, value text not null)")
		mustExec(t, raw, "insert into meta (key, value) values ('dbKind', 'other-app-db')")
		raw.Close()
		_, err := archive.OpenExisting(path)
		if err == nil || err.Error() != `NOT_A_CONVOREL_ARCHIVE: dbKind is "other-app-db"` {
			t.Fatalf("wrong kind: %v", err)
		}
		_, err = archive.Open(dir)
		if err == nil || !strings.Contains(err.Error(), "already holds other objects") {
			t.Fatalf("writable wrong kind: %v", err)
		}
	})

	t.Run("unsupported version", func(t *testing.T) {
		dir := t.TempDir()
		a := openArchive(t, dir)
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		raw := rawDB(t, archive.Path(dir))
		mustExec(t, raw, "pragma user_version = 2")
		raw.Close()
		for name, open := range map[string]func() (*archive.Archive, error){
			"write": func() (*archive.Archive, error) { return archive.Open(dir) },
			"read":  func() (*archive.Archive, error) { return archive.OpenExisting(archive.Path(dir)) },
		} {
			_, err := open()
			if err == nil || !strings.Contains(err.Error(), "ARCHIVE_VERSION_UNSUPPORTED: found 2") {
				t.Fatalf("%s: %v", name, err)
			}
		}
	})

	t.Run("missing", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "conversations.db")
		if _, err := archive.OpenExisting(path); err == nil || err.Error() != "ARCHIVE_MISSING" {
			t.Fatalf("missing: %v", err)
		}
		if archive.Available(filepath.Dir(path)) {
			t.Fatal("missing archive reported available")
		}
	})

	t.Run("symlink", func(t *testing.T) {
		targetDir := t.TempDir()
		target := archive.Path(targetDir)
		a := openArchive(t, targetDir)
		if _, err := a.Publish(context.Background(), taskDoc(), "fh"); err != nil {
			t.Fatal(err)
		}
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		if err := os.Symlink(target, archive.Path(dir)); err != nil {
			t.Fatal(err)
		}
		_, err := archive.Open(dir)
		if err == nil || !strings.HasPrefix(err.Error(), "ARCHIVE_PATH_UNSAFE") {
			t.Fatalf("symlink write: %v", err)
		}
		_, err = archive.OpenExisting(archive.Path(dir))
		if err == nil || !strings.HasPrefix(err.Error(), "ARCHIVE_PATH_UNSAFE") {
			t.Fatalf("symlink read: %v", err)
		}
	})
}

func TestReadOnlyHandleRefusesWrites(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	a := openArchive(t, dir)
	if _, err := a.Publish(ctx, taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	ro := openExisting(t, archive.Path(dir))
	hits, err := ro.Search(ctx, archive.SearchInput{Query: "防枚举"})
	if err != nil || len(hits.Hits) != 1 {
		t.Fatalf("read-only search: %+v %v", hits, err)
	}
	stats, err := ro.Stats(ctx)
	if err != nil || stats.Versions != 2 {
		t.Fatalf("read-only stats: %+v %v", stats, err)
	}
	report := ro.Integrity(ctx)
	if report.IntegrityCheck != "ok" {
		t.Fatalf("read-only integrity: %+v", report)
	}
	// FTS5's integrity-check command needs write access even though it does not
	// change archived content. A read-only handle reports that restriction rather
	// than claiming a healthy index; the daemon's writable handle returns "ok".
	if !strings.Contains(report.FTSIntegrityCheck, "readonly") {
		t.Fatalf("read-only FTS integrity: %+v", report)
	}
	history, err := ro.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	promptID := history.Turns[0].PromptVersionID
	if promptID == nil {
		t.Fatal("prompt version missing")
	}
	content, err := ro.ContentVersion(ctx, *promptID)
	if err != nil || content.Text == "" {
		t.Fatalf("read-only content: %+v %v", content, err)
	}
	if _, err := ro.Publish(ctx, taskDoc(), "fh-2"); err == nil || err.Error() != "ARCHIVE_READONLY" {
		t.Fatalf("read-only publish: %v", err)
	}
	if err := ro.Reindex(ctx); err == nil || err.Error() != "ARCHIVE_READONLY" {
		t.Fatalf("read-only reindex: %v", err)
	}
	if _, err := ro.ExportSnapshot(ctx, filepath.Join(t.TempDir(), "backup")); err == nil || err.Error() != "ARCHIVE_READONLY" {
		t.Fatalf("read-only export: %v", err)
	}
}

func TestNoticeConversion(t *testing.T) {
	dir := t.TempDir()
	a := openArchive(t, dir)
	if _, err := a.Publish(context.Background(), taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	ro := openExisting(t, archive.Path(dir))
	notice := ro.PublishNotice(context.Background(), taskDoc(), "fh-2")
	if notice.Status != "failed" || !strings.Contains(notice.Error, "ARCHIVE_READONLY") {
		t.Fatalf("read-only notice: %+v", notice)
	}
	if got := archive.Failure(errors.New("boom")); got.Error != "ARCHIVE_FAILED: boom" {
		t.Fatalf("failure notice: %+v", got)
	}
	if got := archive.Unavailable(nil); got.Status != "unavailable" || got.Error != "ARCHIVE_MISSING" {
		t.Fatalf("unavailable notice: %+v", got)
	}
	raw := rawDB(t, filepath.Join(t.TempDir(), "sqlite-error.db"))
	mustExec(t, raw, "create table t(a text unique)")
	mustExec(t, raw, "insert into t values ('x')")
	_, err := raw.Exec("insert into t values ('x')")
	if err == nil {
		t.Fatal("expected a constraint error")
	}
	if got := archive.Failure(err); !strings.HasPrefix(got.Error, "SQLITE: ") {
		t.Fatalf("sqlite failure notice: %+v", got)
	}
}

func TestConcurrentPublishAndSearch(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	if _, err := a.Publish(ctx, taskDoc(), "fh-0"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for reader := 0; reader < 6; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				result, err := a.Search(ctx, archive.SearchInput{Query: "防枚举"})
				if err != nil {
					errs <- err
					return
				}
				if result.Total != 1 {
					errs <- fmt.Errorf("total %d", result.Total)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 1; i <= 20; i++ {
			task := taskDoc()
			task.AttemptID = fmt.Sprintf("a%d", i)
			if _, err := a.Publish(ctx, task, fmt.Sprintf("fh-%d", i)); err != nil {
				errs <- err
				return
			}
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	stats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Runs != 1 || stats.Versions != 2 {
		t.Fatalf("concurrent projection created duplicates: %+v", stats)
	}
}

func TestPublishNoticeStoredAndPartial(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	notice := a.PublishNotice(ctx, taskDoc(), "fh-1")
	if notice.Status != "partial" || notice.Runs != 1 || notice.Versions != 2 || notice.Stats == nil {
		t.Fatalf("partial notice: %+v", notice)
	}
	captured := cloneTask(taskDoc())
	captured.Runs[0].Reply.Markdown = "## 裁定"
	notice = a.PublishNotice(ctx, captured, "fh-2")
	if notice.Status != "stored" || len(notice.Gaps) != 0 {
		t.Fatalf("stored notice: %+v", notice)
	}
}
