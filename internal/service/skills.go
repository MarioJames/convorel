package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// InstallSkill installs an absent skill tree, never overwriting personal changes or following links.
// target is the destination skill directory, not its parent.
func InstallSkill(target string) (any, error) {
	if target == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		target = filepath.Join(home, ".agents", "skills", "chatgpt-review")
	}
	target, e := filepath.Abs(target)
	if e != nil {
		return nil, e
	}
	if _, e = os.Lstat(target); e == nil {
		return nil, errors.New("SKILL_ALREADY_EXISTS")
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	files := skillFiles
	if len(files) == 0 {
		files = map[string]string{}
		source := filepath.Join("skills", "chatgpt-review")
		e = filepath.WalkDir(source, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if !d.Type().IsRegular() {
				return errors.New("SKILL_UNSAFE_ENTRY")
			}
			b, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			rel, e := filepath.Rel(source, path)
			if e != nil {
				return e
			}
			files[filepath.ToSlash(rel)] = string(b)
			return nil
		})
		if e != nil {
			return nil, e
		}
	}
	if _, ok := files["SKILL.md"]; !ok {
		return nil, errors.New("SKILL_BUNDLE_INCOMPLETE")
	}
	parent := filepath.Dir(target)
	if e = os.MkdirAll(parent, 0755); e != nil {
		return nil, e
	}
	stage, e := os.MkdirTemp(parent, ".convorel-skill-*")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(stage)
	hashes := map[string]string{}
	for name, body := range files {
		if !safeRelative(name) {
			return nil, errors.New("SKILL_UNSAFE_ENTRY")
		}
		dest := filepath.Join(stage, filepath.FromSlash(name))
		if e = os.MkdirAll(filepath.Dir(dest), 0755); e != nil {
			return nil, e
		}
		if e = os.WriteFile(dest, []byte(body), 0644); e != nil {
			return nil, e
		}
		hash := sha256.Sum256([]byte(body))
		hashes[name] = hex.EncodeToString(hash[:])
	}
	manifest, _ := json.Marshal(map[string]any{"version": 1, "skill": "chatgpt-review", "bundleVersion": Version, "files": hashes})
	if e = os.WriteFile(filepath.Join(stage, ".convorel-skill.json"), manifest, 0644); e != nil {
		return nil, e
	}
	// mkdir reserves the target without replacing an installation created concurrently.
	if e = os.Mkdir(target, 0755); e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(stage)
	if e != nil {
		os.Remove(target)
		return nil, e
	}
	for _, entry := range entries {
		if e = os.Rename(filepath.Join(stage, entry.Name()), filepath.Join(target, entry.Name())); e != nil {
			os.RemoveAll(target)
			return nil, e
		}
	}
	return map[string]any{"installed": true, "path": target}, nil
}
func safeRelative(s string) bool {
	if s == "" || strings.ContainsAny(s, "\\\x00\r\n") || filepath.IsAbs(s) {
		return false
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
