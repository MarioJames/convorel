package archive

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Snapshot describes a consistent standalone copy of the archive.
type Snapshot struct {
	Path        string `json:"path"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	JournalMode string `json:"journalMode"`
	Permissions string `json:"permissions"`
}

// ExportSnapshot writes a consistent copy into a new directory. Copying the live
// file would miss committed bytes still held in the WAL, so the copy comes from
// VACUUM INTO and is published by hard link, which cannot overwrite a target.
//
// The 1.0 CLI does not expose an export command; this remains a library surface for
// backups and tests, and is refused on a read-only handle.
func (a *Archive) ExportSnapshot(ctx context.Context, directory string) (Snapshot, error) {
	if !a.writable {
		return Snapshot{}, archiveReadOnly
	}
	target := Path(directory)
	if _, err := os.Lstat(target); err == nil {
		return Snapshot{}, errors.New("EXPORT_EXISTS")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return Snapshot{}, err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return Snapshot{}, err
	}
	nonce, err := newUUID()
	if err != nil {
		return Snapshot{}, err
	}
	// VACUUM INTO creates and fills the file itself, so the writing phase stays in
	// a directory only this process can enter. The published file inherits 0600
	// through the link, leaving no readable window under a looser parent.
	staging := filepath.Join(directory, fmt.Sprintf(".convorel-export-%d.%s", os.Getpid(), nonce))
	if err := os.Mkdir(staging, 0700); err != nil {
		return Snapshot{}, err
	}
	temporary := filepath.Join(staging, "conversations.db")
	defer func() {
		_ = os.Remove(temporary)
		_ = os.Remove(staging)
	}()

	a.mu.Lock()
	_, err = a.db.ExecContext(ctx, "vacuum into ?", temporary)
	a.mu.Unlock()
	if err != nil {
		return Snapshot{}, err
	}
	copyDB, err := sql.Open(dialectName, dataSourceName(temporary, false))
	if err != nil {
		return Snapshot{}, err
	}
	copyDB.SetMaxOpenConns(1)
	defer copyDB.Close()
	// A standalone copy should not depend on WAL sidecars to open.
	if _, err = copyDB.ExecContext(ctx, "pragma journal_mode = delete"); err != nil {
		return Snapshot{}, err
	}
	var check string
	if err = copyDB.QueryRowContext(ctx, "pragma integrity_check").Scan(&check); err != nil {
		return Snapshot{}, err
	}
	if check != "ok" {
		return Snapshot{}, fmt.Errorf("EXPORT_CORRUPT: %s", check)
	}
	if err = copyDB.Close(); err != nil {
		return Snapshot{}, err
	}
	if err = os.Chmod(temporary, 0600); err != nil {
		return Snapshot{}, err
	}
	if err = syncFile(temporary); err != nil {
		return Snapshot{}, err
	}
	// rename would replace an existing target; a hard link cannot.
	if err = os.Link(temporary, target); err != nil {
		return Snapshot{}, err
	}
	if err = syncFile(directory); err != nil {
		return Snapshot{}, err
	}
	st, err := os.Stat(target)
	if err != nil {
		return Snapshot{}, err
	}
	digest, err := fileHash(target)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Path:        target,
		Bytes:       st.Size(),
		SHA256:      digest,
		JournalMode: "delete",
		Permissions: "0600",
	}, nil
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// fileHash is the file's own bytes, so an independent sha256sum matches.
func fileHash(path string) (string, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:]), nil
}
