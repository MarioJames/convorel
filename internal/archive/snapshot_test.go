package archive_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
)

func TestExportSnapshotStandsAlone(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	if _, err := a.Publish(ctx, taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "backup")
	snapshot, err := a.ExportSnapshot(ctx, backup)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Bytes <= 0 || snapshot.JournalMode != "delete" || snapshot.Permissions != "0600" {
		t.Fatalf("snapshot: %+v", snapshot)
	}
	if filepath.Base(snapshot.Path) != "conversations.db" {
		t.Fatalf("snapshot path: %s", snapshot.Path)
	}
	if st, err := os.Stat(snapshot.Path); err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("snapshot mode: %v %v", st, err)
	}
	// Only the snapshot stays behind: the staging directory is this call's scratch.
	entries, err := os.ReadDir(backup)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(entryNames(entries), []string{"conversations.db"}) {
		t.Fatalf("export directory: %v", entryNames(entries))
	}
	bytes, err := os.ReadFile(snapshot.Path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bytes)
	if snapshot.SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("snapshot checksum: %s", snapshot.SHA256)
	}
	raw := rawDB(t, snapshot.Path)
	var journal string
	if err := raw.QueryRow("pragma journal_mode").Scan(&journal); err != nil || journal != "delete" {
		t.Fatalf("snapshot journal mode: %q %v", journal, err)
	}
	raw.Close()

	if _, err := a.ExportSnapshot(ctx, backup); err == nil || err.Error() != "EXPORT_EXISTS" {
		t.Fatalf("overwrite: %v", err)
	}

	reopened := openExisting(t, snapshot.Path)
	hits, err := reopened.Search(ctx, archive.SearchInput{Query: "防枚举"})
	if err != nil || hits.Total != 1 {
		t.Fatalf("snapshot search: %+v %v", hits, err)
	}
	history, err := reopened.History(ctx, "review", archive.HistoryOptions{})
	if err != nil || len(history.Turns) != 1 {
		t.Fatalf("snapshot history: %+v %v", history, err)
	}
	if _, err := reopened.ExportSnapshot(ctx, filepath.Join(t.TempDir(), "again")); err == nil || err.Error() != "ARCHIVE_READONLY" {
		t.Fatalf("read-only export: %v", err)
	}
}

func entryNames(entries []os.DirEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}
