package archive_test

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
)

// TestLegacyArchiveSearchHook is the real-data compatibility check. It is skipped
// unless CONVOREL_LEGACY_ARCHIVE points at a copy of the 0.9 conversations.db (or
// at an exported directory containing it). Only the main file and committed WAL
// bytes are copied into t.TempDir(); SQLite rebuilds the derived SHM there. The
// source is never opened and the real state directory is never used.
//
// The design evidence records 28 matches for 「多租户」. The owner compares this
// hook's reported total with 0.9; a specific count can be asserted by also setting
// CONVOREL_LEGACY_ARCHIVE_EXPECT.
func TestLegacyArchiveSearchHook(t *testing.T) {
	source := os.Getenv("CONVOREL_LEGACY_ARCHIVE")
	if source == "" {
		t.Skip("set CONVOREL_LEGACY_ARCHIVE to a copy of the 0.9 conversations.db")
	}
	st, err := os.Stat(source)
	if err != nil {
		t.Fatalf("legacy archive source: %v", err)
	}
	database := source
	if st.IsDir() {
		database = filepath.Join(source, "conversations.db")
	}
	dir := t.TempDir()
	copyPath := filepath.Join(dir, "conversations.db")
	copyFile(t, database, copyPath)
	if _, err := os.Stat(database + "-wal"); err == nil {
		copyFile(t, database+"-wal", copyPath+"-wal")
	}

	a, err := archive.Open(dir)
	if err != nil {
		t.Fatalf("open copied legacy archive: %v", err)
	}
	defer a.Close()
	ctx := context.Background()
	result, err := a.Search(ctx, archive.SearchInput{Query: "多租户", Limit: 100})
	if err != nil {
		t.Fatalf("search legacy archive: %v", err)
	}
	t.Logf("legacy archive: 多租户 total=%d hits=%d engine=%s (design evidence: 28)",
		result.Total, len(result.Hits), result.Engine)
	if result.Total == 0 {
		t.Fatal("legacy archive search returned no matches")
	}
	if result.Engine != "trigram" {
		t.Fatalf("legacy search engine: %s", result.Engine)
	}
	wantHits := result.Total
	if wantHits > 100 {
		wantHits = 100
	}
	if len(result.Hits) != wantHits {
		t.Fatalf("hits %d for total %d", len(result.Hits), result.Total)
	}
	if expected := os.Getenv("CONVOREL_LEGACY_ARCHIVE_EXPECT"); expected != "" {
		want, err := strconv.Atoi(expected)
		if err != nil {
			t.Fatalf("CONVOREL_LEGACY_ARCHIVE_EXPECT: %v", err)
		}
		if result.Total != want {
			t.Fatalf("多租户 total %d, 0.9 reported %d", result.Total, want)
		}
	}
	stats, err := a.Stats(ctx)
	if err != nil || stats.Tasks == 0 || stats.Versions == 0 {
		t.Fatalf("legacy archive stats: %+v %v", stats, err)
	}
	report := a.Integrity(ctx)
	if report.IntegrityCheck != "ok" {
		t.Fatalf("legacy integrity: %+v", report)
	}
}

func copyFile(t *testing.T, source, target string) {
	t.Helper()
	in, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
}
