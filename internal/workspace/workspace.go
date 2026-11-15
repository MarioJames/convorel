package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	// MaxFile is the largest single file returned by any tool.
	MaxFile = 1024 * 1024
	// MaxOut is the structured JSON response ceiling.
	MaxOut = 64 * 1024
	// ContentBudget leaves room for paths, provenance and the MCP envelope.
	ContentBudget = 56 * 1024
)

const policyTextValue = "No symlinks, hardlinks, special files, credentials or ignored files. All authorized connector clients share this root."

// FullPath resolves an absolute tool path. It mirrors paths.ts: no relative
// paths, no traversal segments, no NUL and no backslashes.
func FullPath(path string) (string, error) {
	if path == "" || strings.Contains(path, "\\") || strings.ContainsRune(path, 0) {
		return "", Fail("ACCESS_DENIED")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return "", Fail("ACCESS_DENIED")
		}
	}
	expanded := path
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		expanded = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(expanded) {
		return "", Fail("ABSOLUTE_PATH_REQUIRED")
	}
	return filepath.Clean(expanded), nil
}

func statIdentity(stat os.FileInfo) string {
	if sys, ok := stat.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", sys.Dev, sys.Ino)
	}
	return fmt.Sprintf("%d:%d", stat.ModTime().UnixNano(), stat.Size())
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func jsonBytes(value any) int { return JSONSize(value) }

// ParseRoots parses the JSON array used by --roots and mcp.roots.
func ParseRoots(value string) ([]string, error) {
	var roots []string
	if err := json.Unmarshal([]byte(value), &roots); err != nil {
		return nil, Fail("INVALID_MCP_ROOTS")
	}
	if len(roots) < 1 || len(roots) > 16 {
		return nil, Fail("INVALID_MCP_ROOTS")
	}
	return roots, nil
}

// ParseMemoryRoots parses mcp.memoryRoots and canonicalizes each URI.
func ParseMemoryRoots(value string) ([]string, error) {
	if value == "" {
		return nil, nil
	}
	var roots []string
	if err := json.Unmarshal([]byte(value), &roots); err != nil || len(roots) < 1 || len(roots) > 16 {
		return nil, Fail("INVALID_MEMORY_ROOTS")
	}
	out := make([]string, 0, len(roots))
	for _, root := range roots {
		uri, err := MemoryURI(root)
		if err != nil {
			return nil, Fail("INVALID_MEMORY_ROOTS")
		}
		out = append(out, uri)
	}
	return out, nil
}

// MemoryURI canonicalizes a viking:// subtree URI.
func MemoryURI(value string) (string, error) {
	if !strings.HasPrefix(value, "viking://") || strings.ContainsAny(value, "%?#\\\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f") {
		return "", Fail("MEMORY_URI_INVALID")
	}
	parts := strings.Split(strings.TrimSuffix(value[9:], "/"), "/")
	if len(parts) < 3 {
		return "", Fail("MEMORY_URI_INVALID")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || part == "~" {
			return "", Fail("MEMORY_URI_INVALID")
		}
	}
	return "viking://" + strings.Join(parts, "/"), nil
}

// PolicyText rejects lossy or binary policy parsing instead of weakening a
// deny boundary. A UTF-8 BOM is retained, matching TextDecoder ignoreBOM.
func PolicyText(bytes []byte) (string, error) {
	if !utf8.Valid(bytes) {
		return "", Fail("POLICY_UNREADABLE")
	}
	text := string(bytes)
	for _, r := range text {
		if (r >= 0x00 && r <= 0x08) || r == 0x0b || r == 0x0c || (r >= 0x0e && r <= 0x1f) || r == 0x7f {
			return "", Fail("POLICY_UNREADABLE")
		}
	}
	return text, nil
}

func hardMatcher() *ignoreMatcher {
	return parseIgnore(strings.Join([]string{
		".env",
		".env.*",
		"*.pem",
		"*.key",
		"*.p12",
		"*.pfx",
		"*.jks",
		"*.keystore",
		"id_rsa*",
		"id_ed25519*",
		"id_ecdsa*",
		"id_dsa*",
		".ssh/",
		".aws/",
		".gnupg/",
		".npmrc",
		".netrc",
		"_netrc",
		".git-credentials",
		"*.keychain*",
		".cloudflared/",
		"credentials.json",
		"service-account*.json",
		"secrets.json",
		"cookies.sqlite",
		"Cookies",
		".git",
		".git/",
		"node_modules/",
		"dist/",
		"build/",
		".next/",
		".cache/",
		".venv/",
		"venv/",
		"coverage/",
		"target/",
		".convorel/",
	}, "\n"))
}

var hard = hardMatcher()

// Workspace is one allowed root or a selected subdirectory of one.
type Workspace struct {
	Root            string
	ID              string
	rootIdentity    string
	parent          *Workspace
	parentPath      string
	gitStorageCheck func(string) bool
}

// NewWorkspace resolves and verifies a single workspace root.
func NewWorkspace(root string) (*Workspace, error) {
	absolute, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	if real != absolute {
		return nil, Fail("SYMLINK_ROOT_DENIED")
	}
	stat, err := os.Stat(real)
	if err != nil {
		return nil, err
	}
	if !stat.IsDir() {
		return nil, Fail("WORKSPACE_NOT_DIRECTORY")
	}
	identity := statIdentity(stat)
	return &Workspace{Root: real, ID: sha256Hex([]byte(real))[:20], rootIdentity: identity}, nil
}

// Subdirectory selects a permitted child directory.
func (w *Workspace) Subdirectory(path string) (*Workspace, error) {
	if err := w.CheckRoot(); err != nil {
		return nil, err
	}
	rel, err := w.Normalize(path)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		return w, nil
	}
	ok, err := w.Allowed(rel, true)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, Fail("ACCESS_DENIED")
	}
	child, err := NewWorkspace(filepath.Join(w.Root, filepath.FromSlash(rel)))
	if err != nil {
		return nil, Fail("ACCESS_DENIED")
	}
	if child.Root != filepath.Join(w.Root, filepath.FromSlash(rel)) {
		return nil, Fail("ACCESS_DENIED")
	}
	child.parent = w
	child.parentPath = rel
	child.gitStorageCheck = w.gitStorageCheck
	return child, nil
}

// CheckRoot refuses a root that disappeared, was replaced or whose parent
// policy no longer admits it.
func (w *Workspace) CheckRoot() error {
	if w.parent != nil {
		if err := w.parent.CheckRoot(); err != nil {
			return err
		}
		ok, err := w.parent.Allowed(w.parentPath, true)
		if err != nil {
			return err
		}
		if !ok {
			return Fail("ACCESS_DENIED")
		}
	}
	stat, err := os.Stat(w.Root)
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(w.Root)
	if err != nil {
		return err
	}
	if real != w.Root || statIdentity(stat) != w.rootIdentity {
		return Fail("WORKSPACE_REPLACED")
	}
	return nil
}

// Normalize validates a workspace-relative path and returns its clean form.
// The empty string means the workspace root.
func (w *Workspace) Normalize(p string) (string, error) {
	if p == "" || filepath.IsAbs(p) || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) {
		return "", Fail("ACCESS_DENIED")
	}
	for _, segment := range strings.Split(p, "/") {
		if segment == ".." {
			return "", Fail("ACCESS_DENIED")
		}
	}
	absolute := filepath.Join(w.Root, filepath.FromSlash(p))
	rel, err := filepath.Rel(w.Root, absolute)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) {
		return "", Fail("ACCESS_DENIED")
	}
	if rel == "." {
		return "", nil
	}
	return filepath.ToSlash(rel), nil
}

// policy reads one ignore file inside the workspace. Every failure other than
// absence fails closed as POLICY_UNREADABLE.
func (w *Workspace) policy(file string) (string, error) {
	bytes, err := w.readBytes(file, true)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", Fail("POLICY_UNREADABLE")
	}
	text, err := PolicyText(bytes)
	if err != nil {
		return "", Fail("POLICY_UNREADABLE")
	}
	return text, nil
}

// Allowed applies the hard exclusions, every ancestor policy and the
// symlink/hardlink/special-file policy.
func (w *Workspace) Allowed(p string, isDir bool) (bool, error) {
	rel, err := w.Normalize(p)
	if err != nil {
		return false, nil
	}
	if w.parent != nil {
		parentPath := w.parentPath
		if rel != "" {
			parentPath = w.parentPath + "/" + rel
		}
		ok, err := w.parent.Allowed(parentPath, isDir)
		if err != nil || !ok {
			return false, err
		}
	}
	if rel == "" {
		return true, nil
	}
	if hard.ignored(rel, isDir) || hard.ignored(rel, true) {
		return false, nil
	}
	parts := strings.Split(rel, "/")
	for i := 0; i < len(parts); i++ {
		base := strings.Join(parts[:i], "/")
		sub := strings.Join(parts[i:], "/")
		for _, name := range []string{".gitignore", ".convorelignore"} {
			file := name
			if base != "" {
				file = base + "/" + name
			}
			text, err := w.policy(file)
			if err != nil {
				return false, err
			}
			if parseIgnore(text).ignored(sub, isDir) {
				return false, nil
			}
		}
	}
	absolute := w.Root
	for _, part := range parts {
		absolute = filepath.Join(absolute, part)
		stat, err := os.Lstat(absolute)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				break
			}
			return false, err
		}
		if stat.Mode()&os.ModeSymlink != 0 || (!stat.IsDir() && !stat.Mode().IsRegular()) {
			return false, nil
		}
		if stat.Mode().IsRegular() {
			if sys, ok := stat.Sys().(*syscall.Stat_t); ok && sys.Nlink > 1 {
				return false, nil
			}
		}
	}
	return true, nil
}

// readBytes is the shared bounded descriptor read. It refuses symlinks,
// hardlinks, special files, oversized files and files whose identity changes
// while they are read.
func (w *Workspace) readBytes(p string, policy bool) ([]byte, error) {
	if err := w.CheckRoot(); err != nil {
		return nil, err
	}
	rel, err := w.Normalize(p)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		return nil, Fail("NOT_A_FILE")
	}
	absolute := w.Root
	for _, part := range strings.Split(rel, "/") {
		absolute = filepath.Join(absolute, part)
		stat, err := os.Lstat(absolute)
		if err != nil {
			return nil, err
		}
		if stat.Mode()&os.ModeSymlink != 0 {
			return nil, Fail("ACCESS_DENIED")
		}
	}
	limit := MaxFile
	if policy {
		limit = MaxOut
	}
	f, err := os.OpenFile(absolute, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, Fail("NOT_REGULAR_FILE")
	}
	sys, _ := before.Sys().(*syscall.Stat_t)
	if sys != nil && sys.Nlink > 1 {
		return nil, Fail("HARDLINK_NOT_SUPPORTED")
	}
	if before.Size() > int64(limit) {
		return nil, Fail("FILE_TOO_LARGE")
	}
	if real, err := filepath.EvalSymlinks(fmt.Sprintf("/proc/self/fd/%d", f.Fd())); err == nil {
		if real != absolute {
			return nil, Fail("FILE_CHANGED")
		}
	}
	buf := make([]byte, 0, int(before.Size())+1)
	chunk := make([]byte, 32*1024)
	for len(buf) <= limit {
		n, readErr := f.Read(chunk)
		if n > 0 {
			buf = append(buf, chunk[:n]...)
		}
		if readErr != nil {
			break
		}
		if n == 0 {
			break
		}
	}
	if len(buf) > limit {
		return nil, Fail("FILE_TOO_LARGE")
	}
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	atPath, err := os.Lstat(absolute)
	if err != nil {
		return nil, err
	}
	if atPath.Mode()&os.ModeSymlink != 0 {
		return nil, Fail("FILE_CHANGED")
	}
	atSys, _ := atPath.Sys().(*syscall.Stat_t)
	afterSys, _ := after.Sys().(*syscall.Stat_t)
	if atSys != nil && afterSys != nil && (atPath.Mode()&os.ModeSymlink != 0 || atSys.Dev != afterSys.Dev || atSys.Ino != afterSys.Ino) {
		return nil, Fail("FILE_CHANGED")
	}
	if real, err := filepath.EvalSymlinks(absolute); err != nil || real != absolute {
		return nil, Fail("FILE_CHANGED")
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, Fail("FILE_CHANGED")
	}
	return buf, nil
}

// TextPage converts a bounded file into the line page used by read_file.
func TextPage(bytes []byte, startLine, maxLines int) (map[string]any, error) {
	if _, err := Integer(startLine, 1, 10_000_000); err != nil {
		return nil, err
	}
	if _, err := Integer(maxLines, 1, 1000); err != nil {
		return nil, err
	}
	for _, b := range bytes {
		if b == 0 {
			return nil, Fail("BINARY_FILE")
		}
	}
	if !utf8.Valid(bytes) {
		return nil, Fail("INVALID_UTF8")
	}
	lines := strings.Split(string(bytes), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	selected := make([]string, 0, maxLines)
	bytesUsed := 0
	start := startLine - 1
	if start > len(lines) {
		start = len(lines)
	}
	end := start + maxLines
	if end > len(lines) {
		end = len(lines)
	}
	for _, line := range lines[start:end] {
		size := jsonBytes(line) + 2
		if bytesUsed+size > ContentBudget {
			if len(selected) == 0 {
				return nil, Fail("LINE_TOO_LONG")
			}
			break
		}
		selected = append(selected, line)
		bytesUsed += size
	}
	endLine := startLine + len(selected) - 1
	truncated := endLine < len(lines)
	var next any
	if truncated {
		next = endLine + 1
	}
	return map[string]any{
		"content":       strings.Join(selected, "\n"),
		"startLine":     startLine,
		"endLine":       endLine,
		"totalLines":    len(lines),
		"truncated":     truncated,
		"nextStartLine": next,
	}, nil
}

// Read returns a bounded UTF-8 line page plus a whole-file hash.
func (w *Workspace) Read(p string, startLine, maxLines int) (map[string]any, error) {
	if _, err := Integer(startLine, 1, 10_000_000); err != nil {
		return nil, err
	}
	if _, err := Integer(maxLines, 1, 1000); err != nil {
		return nil, err
	}
	ok, err := w.Allowed(p, false)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, Fail("ACCESS_DENIED")
	}
	bytes, err := w.readBytes(p, false)
	if err != nil {
		return nil, err
	}
	page, err := TextPage(bytes, startLine, maxLines)
	if err != nil {
		return nil, err
	}
	rel, _ := w.Normalize(p)
	page["path"] = rel
	page["sha256"] = sha256Hex(bytes)
	page["hashScope"] = "whole-file"
	page["sizeBytes"] = len(bytes)
	page["observedAt"] = nowISO()
	page["workspaceId"] = w.ID
	return page, nil
}

// Entry is a directory entry reported by tree/find_files.
type Entry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type inventory struct {
	entries      []Entry
	scanned      int
	truncated    bool
	depthLimited bool
}

func (w *Workspace) inventory(p string, depth int) (inventory, error) {
	if err := w.CheckRoot(); err != nil {
		return inventory{}, err
	}
	rel, err := w.Normalize(p)
	if err != nil {
		return inventory{}, err
	}
	ok, err := w.Allowed(p, true)
	if err != nil {
		return inventory{}, err
	}
	if !ok {
		return inventory{}, Fail("ACCESS_DENIED")
	}
	result := inventory{}
	start := time.Now()
	var walk func(base string, level int) error
	walk = func(base string, level int) error {
		dir := w.Root
		if base != "" {
			dir = filepath.Join(w.Root, filepath.FromSlash(base))
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			result.scanned++
			if result.scanned > 10000 || time.Since(start) > 3*time.Second {
				result.truncated = true
				return nil
			}
			path := entry.Name()
			if base != "" {
				path = base + "/" + path
			}
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			isDir := entry.IsDir()
			if !isDir && !entry.Type().IsRegular() {
				continue
			}
			allowed, err := w.Allowed(path, isDir)
			if err != nil {
				return err
			}
			if !allowed {
				continue
			}
			kind := "file"
			if isDir {
				kind = "directory"
			}
			result.entries = append(result.entries, Entry{Path: path, Type: kind})
			if isDir {
				if level < depth {
					if err := walk(path, level+1); err != nil {
						return err
					}
				} else {
					result.depthLimited = true
				}
			}
			if result.truncated {
				return nil
			}
		}
		return nil
	}
	if err := walk(rel, 1); err != nil {
		return inventory{}, err
	}
	sort.Slice(result.entries, func(i, j int) bool { return result.entries[i].Path < result.entries[j].Path })
	return result, nil
}

// List returns one bounded page of the directory hierarchy.
func (w *Workspace) List(p string, depth, offset, limit int) (map[string]any, error) {
	if _, err := Integer(depth, 1, 4); err != nil {
		return nil, err
	}
	if _, err := Integer(offset, 0, 10000); err != nil {
		return nil, err
	}
	if _, err := Integer(limit, 1, 500); err != nil {
		return nil, err
	}
	all, err := w.inventory(p, depth)
	if err != nil {
		return nil, err
	}
	start := offset
	if start > len(all.entries) {
		start = len(all.entries)
	}
	end := start + limit
	if end > len(all.entries) {
		end = len(all.entries)
	}
	entries := append([]Entry{}, all.entries[start:end]...)
	for len(entries) > 0 && jsonBytes(entries) > MaxOut {
		entries = entries[:len(entries)-1]
	}
	var next any
	if offset+len(entries) < len(all.entries) {
		next = offset + len(entries)
	}
	rel, _ := w.Normalize(p)
	if rel == "" {
		rel = "."
	}
	return map[string]any{
		"path":          rel,
		"entries":       entries,
		"nextOffset":    next,
		"truncated":     all.truncated || offset+len(entries) < len(all.entries),
		"depthLimited":  all.depthLimited,
		"scanTruncated": all.truncated,
	}, nil
}

// Find returns files matching a glob within the policy-filtered inventory.
func (w *Workspace) Find(pattern string, depth, offset, limit int) (map[string]any, error) {
	if _, err := Integer(depth, 1, 32); err != nil {
		return nil, err
	}
	if _, err := Integer(offset, 0, 10000); err != nil {
		return nil, err
	}
	if _, err := Integer(limit, 1, 500); err != nil {
		return nil, err
	}
	match, err := PathMatcher(pattern)
	if err != nil {
		return nil, err
	}
	inv, err := w.inventory(".", depth)
	if err != nil {
		return nil, err
	}
	files := make([]Entry, 0, len(inv.entries))
	for _, entry := range inv.entries {
		if entry.Type == "file" && match(entry.Path) {
			files = append(files, entry)
		}
	}
	start := offset
	if start > len(files) {
		start = len(files)
	}
	end := start + limit
	if end > len(files) {
		end = len(files)
	}
	entries := append([]Entry{}, files[start:end]...)
	for len(entries) > 0 && jsonBytes(entries) > ContentBudget {
		entries = entries[:len(entries)-1]
	}
	var next any
	if offset+len(entries) < len(files) {
		next = offset + len(entries)
	}
	return map[string]any{
		"pattern":        pattern,
		"entries":        entries,
		"offset":         offset,
		"limit":          limit,
		"depth":          depth,
		"nextOffset":     next,
		"truncated":      inv.truncated || inv.depthLimited || offset+len(entries) < len(files),
		"scanTruncated":  inv.truncated,
		"depthLimited":   inv.depthLimited,
		"scannedEntries": inv.scanned,
		"workspaceId":    w.ID,
		"observedAt":     nowISO(),
		"note":           "Live, sorted relative paths. Pagination covers only the scanned inventory; narrow path or increase depth if scan/depth limited. Patterns without '/' match basenames.",
	}, nil
}

// SearchOptions mirrors the search_workspace arguments.
type SearchOptions struct {
	Pattern      string
	Depth        int
	Offset       int
	Limit        int
	ContextLines int
}

// SearchMatch is one matching line with bounded context.
type SearchMatch struct {
	Path          string   `json:"path"`
	Line          int      `json:"line"`
	Text          string   `json:"text"`
	SHA256        string   `json:"sha256"`
	ContextBefore []string `json:"contextBefore"`
	ContextAfter  []string `json:"contextAfter"`
	TextTruncated bool     `json:"textTruncated"`
}

// Search finds literal, case-sensitive matching lines in UTF-8 files.
func (w *Workspace) Search(query string, options SearchOptions) (map[string]any, error) {
	if query == "" || len(query) > 200 || strings.ContainsAny(query, "\n\x00") {
		return nil, Fail("INVALID_QUERY")
	}
	pattern := options.Pattern
	if pattern == "" {
		pattern = "*"
	}
	depth := options.Depth
	if depth == 0 {
		depth = 12
	}
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	contextLines := options.ContextLines
	offset := options.Offset
	if _, err := Integer(depth, 1, 32); err != nil {
		return nil, err
	}
	if _, err := Integer(offset, 0, 1_000_000); err != nil {
		return nil, err
	}
	if _, err := Integer(limit, 1, 50); err != nil {
		return nil, err
	}
	if _, err := Integer(contextLines, 0, 5); err != nil {
		return nil, err
	}
	match, err := PathMatcher(pattern)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	inv, err := w.inventory(".", depth)
	if err != nil {
		return nil, err
	}
	matches := []SearchMatch{}
	scannedBytes := 0
	skippedFiles := 0
	skippedMatches := 0
	pageMore := false
	scanTruncated := inv.truncated
	outputBytes := 0
scan:
	for _, file := range inv.entries {
		if file.Type != "file" || !match(file.Path) {
			continue
		}
		if scannedBytes >= 16*MaxFile || time.Since(start) > 5*time.Second {
			scanTruncated = true
			break
		}
		content, err := w.readBytes(file.Path, false)
		if err != nil {
			skippedFiles++
			continue
		}
		scannedBytes += len(content)
		if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
			skippedFiles++
			continue
		}
		text := string(content)
		hash := sha256Hex(content)
		lines := strings.Split(text, "\n")
		for index, line := range lines {
			at := strings.Index(line, query)
			if at < 0 {
				continue
			}
			if skippedMatches < offset {
				skippedMatches++
				continue
			}
			skippedMatches++
			if len(matches) == limit {
				pageMore = true
				break scan
			}
			atUnits := UTF16Length(line[:at])
			begin := atUnits - 500
			if begin < 0 {
				begin = 0
			}
			snippet, snippetTruncated := SliceUTF16(line, begin, 2000)
			beforeStart := index - contextLines
			if beforeStart < 0 {
				beforeStart = 0
			}
			afterEnd := index + 1 + contextLines
			if afterEnd > len(lines) {
				afterEnd = len(lines)
			}
			before := make([]string, 0, contextLines)
			truncatedLine := false
			for _, value := range lines[beforeStart:index] {
				var truncated bool
				value, truncated = SliceUTF16(value, 0, 1000)
				truncatedLine = truncatedLine || truncated
				before = append(before, value)
			}
			after := make([]string, 0, contextLines)
			for _, value := range lines[index+1 : afterEnd] {
				var truncated bool
				value, truncated = SliceUTF16(value, 0, 1000)
				truncatedLine = truncatedLine || truncated
				after = append(after, value)
			}
			entry := SearchMatch{
				Path:          file.Path,
				Line:          index + 1,
				Text:          snippet,
				SHA256:        hash,
				ContextBefore: before,
				ContextAfter:  after,
				TextTruncated: begin > 0 || snippetTruncated || truncatedLine,
			}
			size := jsonBytes(entry) + 1
			if outputBytes+size > ContentBudget {
				if len(matches) == 0 {
					return nil, Fail("SEARCH_ENTRY_TOO_LARGE")
				}
				pageMore = true
				break scan
			}
			matches = append(matches, entry)
			outputBytes += size
		}
	}
	var next any
	if pageMore {
		next = offset + len(matches)
	}
	return map[string]any{
		"query":         query,
		"pattern":       pattern,
		"depth":         depth,
		"offset":        offset,
		"limit":         limit,
		"contextLines":  contextLines,
		"matches":       matches,
		"nextOffset":    next,
		"truncated":     pageMore || scanTruncated || inv.depthLimited,
		"scanTruncated": scanTruncated,
		"depthLimited":  inv.depthLimited,
		"skippedFiles":  skippedFiles,
		"scannedBytes":  scannedBytes,
		"workspaceId":   w.ID,
		"observedAt":    nowISO(),
		"note":          "Literal, case-sensitive search of live UTF-8 files, one result per matching line. nextOffset continues matches within the scanned range; scan/depth limits require a narrower path or greater depth. skippedFiles are not searched. textTruncated excerpts can be read with read_file; hashes detect changes between calls.",
	}, nil
}

// Image returns supported raster bytes through the same file policy.
func (w *Workspace) Image(p string) (map[string]any, error) {
	ok, err := w.Allowed(p, false)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, Fail("ACCESS_DENIED")
	}
	bytes, err := w.readBytes(p, false)
	if err != nil {
		return nil, err
	}
	mime := ""
	switch {
	case len(bytes) >= 8 && string(bytes[:8]) == "\x89PNG\r\n\x1a\n":
		mime = "image/png"
	case len(bytes) >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255:
		mime = "image/jpeg"
	case len(bytes) >= 12 && string(bytes[:4]) == "RIFF" && string(bytes[8:12]) == "WEBP":
		mime = "image/webp"
	}
	if mime == "" {
		return nil, Fail("UNSUPPORTED_IMAGE")
	}
	rel, _ := w.Normalize(p)
	return map[string]any{
		"path":        rel,
		"mimeType":    mime,
		"sizeBytes":   len(bytes),
		"sha256":      sha256Hex(bytes),
		"hashScope":   "whole-file",
		"workspaceId": w.ID,
		"observedAt":  nowISO(),
		"imageData":   base64.StdEncoding.EncodeToString(bytes),
		"note":        "Image bytes observed at this path, not proof of when or against which revision the screenshot was produced. Maximum image size: 1 MiB.",
	}, nil
}

// ExecutionFile is one policy-filtered file in the isolated input snapshot.
type ExecutionFile struct {
	Path  string
	Bytes []byte
	Mode  uint32
}

// ExecutionFiles builds the bounded input snapshot used by isolated builds.
func (w *Workspace) ExecutionFiles() ([]ExecutionFile, error) {
	inv, err := w.inventory(".", 32)
	if err != nil {
		return nil, err
	}
	if inv.truncated || inv.depthLimited {
		return nil, Fail("EXEC_INPUT_SCAN_LIMIT")
	}
	files := make([]ExecutionFile, 0, len(inv.entries))
	size := 0
	for _, entry := range inv.entries {
		if entry.Type != "file" {
			continue
		}
		ok, err := w.Allowed(entry.Path, false)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, Fail("ACCESS_DENIED")
		}
		bytes, err := w.readBytes(entry.Path, false)
		if err != nil {
			return nil, err
		}
		size += len(bytes)
		if size > 32*1024*1024 {
			return nil, Fail("EXEC_INPUT_SIZE_LIMIT")
		}
		var mode uint32 = 0o600
		if stat, err := os.Lstat(filepath.Join(w.Root, filepath.FromSlash(entry.Path))); err == nil {
			mode |= uint32(stat.Mode().Perm()) & 0o111
		}
		files = append(files, ExecutionFile{Path: entry.Path, Bytes: bytes, Mode: mode})
	}
	return files, nil
}

// Info returns the workspace metadata used by capabilities/workspace_info.
func (w *Workspace) Info() (map[string]any, error) {
	return w.gitAccess().Info()
}

// Status returns filtered live Git status.
func (w *Workspace) Status(offset, limit int) (map[string]any, error) {
	return w.gitAccess().Status(offset, limit)
}

// Diff returns a filtered live Git diff page.
func (w *Workspace) Diff(mode string, options DiffOptions) (map[string]any, error) {
	return w.gitAccess().Diff(mode, options)
}

// History exposes the historical Git tools.
func (w *Workspace) History() *History { return w.gitAccess().History() }

func (w *Workspace) gitAccess() *Git {
	return &Git{
		Root:         w.Root,
		ID:           w.ID,
		check:        w.CheckRoot,
		normalize:    w.Normalize,
		allowed:      w.Allowed,
		storageCheck: w.gitStorageCheck,
	}
}

// Access is the fixed allowed-root list shared by all tool calls.
type Access struct {
	Roots []*Workspace
}

// NewAccess validates and constructs the allowed roots.
func NewAccess(rootPaths []string) (*Access, error) {
	if len(rootPaths) < 1 || len(rootPaths) > 16 {
		return nil, Fail("INVALID_MCP_ROOTS")
	}
	access := &Access{}
	for _, path := range rootPaths {
		absolute, err := FullPath(path)
		if err != nil {
			return nil, err
		}
		real, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			return nil, err
		}
		if real != absolute {
			return nil, Fail("SYMLINK_ROOT_DENIED")
		}
		root, err := NewWorkspace(absolute)
		if err != nil {
			return nil, err
		}
		access.Roots = append(access.Roots, root)
	}
	for i := 0; i < len(access.Roots); i++ {
		for j := i + 1; j < len(access.Roots); j++ {
			if within(access.Roots[i].Root, access.Roots[j].Root) || within(access.Roots[j].Root, access.Roots[i].Root) {
				return nil, Fail("OVERLAPPING_ROOTS")
			}
		}
	}
	for _, root := range access.Roots {
		root.gitStorageCheck = access.storageAllowed
	}
	return access, nil
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel))
}

// File selects the owning workspace and the workspace-relative path.
func (a *Access) File(path string) (*Workspace, string, error) {
	absolute, err := FullPath(path)
	if err != nil {
		return nil, "", err
	}
	var selected *Workspace
	for _, root := range a.Roots {
		if within(root.Root, absolute) {
			selected = root
			break
		}
	}
	if selected == nil {
		return nil, "", Fail("ACCESS_DENIED")
	}
	if err := selected.CheckRoot(); err != nil {
		return nil, "", err
	}
	rel, err := filepath.Rel(selected.Root, absolute)
	if err != nil {
		return nil, "", Fail("ACCESS_DENIED")
	}
	if rel == "." {
		rel = ""
	}
	return selected, filepath.ToSlash(rel), nil
}

// Directory selects a permitted subdirectory workspace.
func (a *Access) Directory(path string) (*Workspace, error) {
	workspace, rel, err := a.File(path)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		return workspace, nil
	}
	return workspace.Subdirectory(rel)
}

// Identity is the stable project identity exposed by every content tool.
type Identity struct {
	RootID        string `json:"rootId"`
	WorkspaceID   string `json:"workspaceId"`
	WorkspacePath string `json:"workspacePath"`
}

// Identity finds the nearest Git checkout marker without leaving the root.
func (a *Access) Identity(path string) (Identity, error) {
	absolute, err := FullPath(path)
	if err != nil {
		return Identity{}, err
	}
	root, rel, err := a.File(absolute)
	if err != nil {
		return Identity{}, err
	}
	checkRel := rel
	if checkRel == "" {
		checkRel = "."
	}
	ok, err := root.Allowed(checkRel, false)
	if err != nil {
		return Identity{}, err
	}
	if !ok {
		return Identity{}, Fail("ACCESS_DENIED")
	}
	stat, err := os.Lstat(absolute)
	if err != nil {
		return Identity{}, err
	}
	if stat.IsDir() {
		ok, err = root.Allowed(checkRel, true)
		if err != nil {
			return Identity{}, err
		}
		if !ok {
			return Identity{}, Fail("ACCESS_DENIED")
		}
	}
	candidate := absolute
	if !stat.IsDir() {
		candidate = filepath.Dir(absolute)
	}
	workspacePath := root.Root
	for {
		if _, err := os.Lstat(filepath.Join(candidate, ".git")); err == nil {
			workspacePath = candidate
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return Identity{}, err
		}
		if candidate == root.Root {
			break
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
		candidate = parent
	}
	projectRel, err := filepath.Rel(root.Root, workspacePath)
	if err != nil {
		return Identity{}, Fail("ACCESS_DENIED")
	}
	if projectRel == "." {
		projectRel = ""
	}
	projectPath := filepath.ToSlash(projectRel)
	if projectPath == "" {
		projectPath = "."
	}
	project, err := root.Subdirectory(projectPath)
	if err != nil {
		return Identity{}, err
	}
	return Identity{RootID: root.ID, WorkspaceID: project.ID, WorkspacePath: workspacePath}, nil
}

// Info lists roots, and with a path returns the selected project metadata.
func (a *Access) Info(path string) (map[string]any, error) {
	for _, root := range a.Roots {
		if err := root.CheckRoot(); err != nil {
			return nil, err
		}
	}
	roots := make([]map[string]any, 0, len(a.Roots))
	for _, root := range a.Roots {
		roots = append(roots, map[string]any{"path": root.Root, "rootId": root.ID})
	}
	if path == "" {
		return map[string]any{"roots": roots, "mode": "live-read-only"}, nil
	}
	if _, err := a.Directory(path); err != nil {
		return nil, err
	}
	identity, err := a.Identity(path)
	if err != nil {
		return nil, err
	}
	project, err := a.Directory(identity.WorkspacePath)
	if err != nil {
		return nil, err
	}
	info, err := project.Info()
	if err != nil {
		return nil, err
	}
	info["rootId"] = identity.RootID
	info["workspaceId"] = identity.WorkspaceID
	info["workspacePath"] = identity.WorkspacePath
	absolute, _ := FullPath(path)
	info["path"] = absolute
	info["roots"] = roots
	return info, nil
}

// AssertPrivate refuses a private path that overlaps an allowed root in either
// direction, including through a symlink alias.
func (a *Access) AssertPrivate(path string) error {
	absolute, err := FullPath(path)
	if err != nil {
		return err
	}
	existing := absolute
	suffix := []string{}
	var canonical string
	for {
		real, err := filepath.EvalSymlinks(existing)
		if err == nil {
			canonical = filepath.Join(append([]string{real}, suffix...)...)
			break
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		suffix = append([]string{filepath.Base(existing)}, suffix...)
		parent := filepath.Dir(existing)
		if parent == existing {
			canonical = absolute
			break
		}
		existing = parent
	}
	for _, root := range a.Roots {
		if within(root.Root, absolute) || within(absolute, root.Root) || within(root.Root, canonical) || within(canonical, root.Root) {
			return Fail("STATE_INSIDE_WORKSPACE")
		}
	}
	return nil
}

func (a *Access) storageAllowed(path string) bool {
	absolute, err := FullPath(path)
	if err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil || real != absolute {
		return false
	}
	workspace, rel, err := a.File(absolute)
	if err != nil {
		return false
	}
	segments := strings.Split(rel, "/")
	git := -1
	for i, segment := range segments {
		if segment == ".git" {
			git = i
			break
		}
	}
	base := rel
	if git >= 0 {
		base = strings.Join(segments[:git], "/")
	}
	if base == "" {
		base = "."
	}
	ok, err := workspace.Allowed(base, true)
	return err == nil && ok
}
