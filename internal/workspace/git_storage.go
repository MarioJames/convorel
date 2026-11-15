package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// checkGitObjects validates object storage metadata once per observation.
// Packed repositories stay cheap; links, special files and runaway depth are
// refused rather than followed.
func checkGitObjects(objects string) error {
	started := time.Now()
	entries := 0
	var visit func(path string, depth int) error
	visit = func(path string, depth int) error {
		entries++
		if entries > 200_000 || depth > 8 || time.Since(started) > 2*time.Second {
			return Fail("GIT_STORAGE_SCAN_LIMIT")
		}
		stat, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if stat.Mode()&os.ModeSymlink != 0 {
			return Fail("GIT_STORAGE_LINK_DENIED")
		}
		if stat.Mode().IsRegular() {
			if sys, ok := stat.Sys().(*syscall.Stat_t); ok && sys.Nlink > 1 {
				return Fail("GIT_STORAGE_LINK_DENIED")
			}
			return nil
		}
		if !stat.IsDir() {
			return Fail("GIT_STORAGE_NOT_REGULAR")
		}
		list, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, entry := range list {
			if err := visit(filepath.Join(path, entry.Name()), depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(objects, 0); err != nil {
		if Code(err) != "" {
			return err
		}
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
			return Fail("GIT_STORAGE_UNREADABLE")
		}
		return Fail("GIT_STORAGE_UNREADABLE")
	}
	return nil
}
