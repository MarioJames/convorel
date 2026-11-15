package workspace

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	historyInventoryLimit = 10000
	historyTreeLimit      = 30000
	historyTextBudget     = 20 * 1024
	historyMaxOutput      = 56 * 1024
	historyCommitBudget   = 48 * 1024
	historyReadBudget     = 48 * 1024
)

type historyAccess struct {
	root      string
	id        string
	normalize func(string) (string, error)
	allowed   func(string, bool) (bool, error)
	ready     func() error
	git       func([]string) ([]byte, error)
}

type treeEntry struct {
	mode string
	oid  string
	size int
}

type observation struct {
	access      historyAccess
	started     time.Time
	commands    int
	policyBytes int
	trees       map[string]map[string]treeEntry
	policies    map[string]*ignoreMatcher
	empty       *ignoreMatcher
}

var (
	commitIdentity = regexp.MustCompile(`^[a-z]+ (.*) <([^<>]*)> (-?\d+) [+-]\d{4}$`)
	treeLine       = regexp.MustCompile(`^(\d{6}) (blob|commit) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$`)
	historyDiff    = regexp.MustCompile(`^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$`)
	numstatLine    = regexp.MustCompile(`^(\d+|-)\t(\d+|-)\t([\s\S]*)$`)
	historyRef     = regexp.MustCompile(`[\s\x00-\x1f\x7f:\\]`)
)

// History is the entry point for git_log/git_show/git_compare/git_read_file.
type History struct {
	access historyAccess
}

// Commit is bounded commit metadata.
type Commit struct {
	SHA         string       `json:"sha"`
	Parents     []string     `json:"parents"`
	Author      CommitPerson `json:"author"`
	AuthoredAt  string       `json:"authoredAt"`
	CommittedAt string       `json:"committedAt"`
	Subject     string       `json:"subject"`
}

// CommitPerson is an author identity.
type CommitPerson struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type historyFile struct {
	Path      string  `json:"path"`
	OldPath   *string `json:"oldPath"`
	Status    string  `json:"status"`
	Additions int     `json:"additions"`
	Deletions int     `json:"deletions"`
}

type historyChange struct {
	historyFile
	oldOID string
	newOID string
}

type page struct {
	offset      int
	limit       int
	patchFile   *string
	patchOffset int
}

// LogOptions are git_log arguments.
type LogOptions struct {
	Ref    string
	Offset int
	Limit  int
}

// ShowOptions are git_show arguments.
type ShowOptions struct {
	Ref           string
	Parent        int
	MessageOffset int
	Offset        int
	Limit         int
	PatchFile     *string
	PatchOffset   int
}

// CompareOptions are git_compare arguments.
type CompareOptions struct {
	Base        string
	Head        string
	Mode        string
	Offset      int
	Limit       int
	PatchFile   *string
	PatchOffset int
}

// ReadOptions are git_read_file arguments.
type ReadOptions struct {
	Ref       string
	FilePath  string
	StartLine int
	MaxLines  int
}

func validRef(ref string) bool {
	return ref != "" && len(ref) <= 1024 && !strings.HasPrefix(ref, "-") && !historyRef.MatchString(ref)
}

func validFilePath(path string) bool {
	if path == "" || len(path) > 4096 || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") || strings.ContainsRune(path, 0) {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

func newObservation(access historyAccess) *observation {
	return &observation{
		access:   access,
		started:  time.Now(),
		trees:    map[string]map[string]treeEntry{},
		policies: map[string]*ignoreMatcher{},
		empty:    parseIgnore(""),
	}
}

func (o *observation) checkBudget() error {
	if time.Since(o.started) > 8*time.Second {
		return Fail("GIT_HISTORY_SCAN_LIMIT")
	}
	return nil
}

func (o *observation) git(args []string) ([]byte, error) {
	if err := o.checkBudget(); err != nil {
		return nil, err
	}
	o.commands++
	if o.commands > 512 {
		return nil, Fail("GIT_HISTORY_SCAN_LIMIT")
	}
	result, err := o.access.git(args)
	if err != nil {
		return nil, err
	}
	if err := o.checkBudget(); err != nil {
		return nil, err
	}
	return result, nil
}

func (o *observation) resolve(ref string) (string, error) {
	raw, err := o.git([]string{"rev-parse", "--verify", "--end-of-options", ref + "^{commit}"})
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(decodeGit(raw))
	if !shaPattern.MatchString(value) {
		return "", Fail("GIT_INVALID_REVISION")
	}
	return value, nil
}

func (o *observation) meta() (map[string]any, error) {
	raw, err := o.git([]string{"rev-parse", "--is-shallow-repository"})
	if err != nil {
		return nil, err
	}
	shallow := strings.TrimSpace(decodeGit(raw))
	if shallow != "true" && shallow != "false" {
		return nil, Fail("GIT_INVALID_OUTPUT")
	}
	return map[string]any{
		"workspaceId": o.access.id,
		"observedAt":  nowISO(),
		"shallow":     shallow == "true",
	}, nil
}

func (o *observation) commit(sha string) (Commit, error) {
	raw, err := o.git([]string{"cat-file", "commit", sha})
	if err != nil {
		return Commit{}, err
	}
	if len(raw) > MaxFile {
		return Commit{}, Fail("GIT_COMMIT_TOO_LARGE")
	}
	text, err := decodeGitStrict(raw)
	if err != nil {
		return Commit{}, err
	}
	split := strings.Index(text, "\n\n")
	if split < 0 {
		return Commit{}, Fail("GIT_INVALID_COMMIT")
	}
	headers := strings.Split(text[:split], "\n")
	parents := make([]string, 0, 1)
	for _, line := range headers {
		if strings.HasPrefix(line, "parent ") {
			parents = append(parents, line[7:])
		}
	}
	if len(parents) > 100 {
		return Commit{}, Fail("GIT_INVALID_COMMIT")
	}
	for _, parent := range parents {
		if !shaPattern.MatchString(parent) {
			return Commit{}, Fail("GIT_INVALID_COMMIT")
		}
	}
	identity := func(kind string) (CommitPerson, string, error) {
		for _, line := range headers {
			if !strings.HasPrefix(line, kind+" ") {
				continue
			}
			match := commitIdentity.FindStringSubmatch(line)
			if match == nil {
				return CommitPerson{}, "", Fail("GIT_INVALID_COMMIT")
			}
			seconds, err := strconv.ParseInt(match[3], 10, 64)
			if err != nil {
				return CommitPerson{}, "", Fail("GIT_INVALID_COMMIT")
			}
			return CommitPerson{Name: match[1], Email: match[2]}, time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05.000Z"), nil
		}
		return CommitPerson{}, "", Fail("GIT_INVALID_COMMIT")
	}
	author, authoredAt, err := identity("author")
	if err != nil {
		return Commit{}, err
	}
	if _, _, err = identity("committer"); err != nil {
		return Commit{}, err
	}
	committedAtRaw, err := o.committerAt(headers)
	if err != nil {
		return Commit{}, err
	}
	subject := strings.SplitN(text[split+2:], "\n", 2)[0]
	result := Commit{SHA: sha, Parents: parents, Author: author, AuthoredAt: authoredAt, CommittedAt: committedAtRaw, Subject: subject}
	if jsonBytes(result) > 8192 {
		return Commit{}, Fail("GIT_COMMIT_METADATA_LIMIT")
	}
	return result, nil
}

func (o *observation) committerAt(headers []string) (string, error) {
	for _, line := range headers {
		if !strings.HasPrefix(line, "committer ") {
			continue
		}
		match := commitIdentity.FindStringSubmatch(line)
		if match == nil {
			return "", Fail("GIT_INVALID_COMMIT")
		}
		seconds, err := strconv.ParseInt(match[3], 10, 64)
		if err != nil {
			return "", Fail("GIT_INVALID_COMMIT")
		}
		return time.Unix(seconds, 0).UTC().Format("2006-01-02T15:04:05.000Z"), nil
	}
	return "", Fail("GIT_INVALID_COMMIT")
}

func (o *observation) message(sha string) (string, string, error) {
	raw, err := o.git([]string{"cat-file", "commit", sha})
	if err != nil {
		return "", "", err
	}
	if len(raw) > MaxFile {
		return "", "", Fail("GIT_COMMIT_TOO_LARGE")
	}
	boundary := bytes.Index(raw, []byte("\n\n"))
	if boundary < 0 {
		return "", "", Fail("GIT_INVALID_COMMIT")
	}
	body := raw[boundary+2:]
	text, err := decodeGitStrict(body)
	if err != nil {
		return "", "", err
	}
	return text, sha256Hex(body), nil
}

func (o *observation) tree(sha string) (map[string]treeEntry, error) {
	if cached, ok := o.trees[sha]; ok {
		return cached, nil
	}
	raw, err := o.git([]string{"ls-tree", "-r", "-z", "-l", "--full-tree", sha})
	if err != nil {
		return nil, err
	}
	tokens := strings.Split(string(raw), "\x00")
	if len(tokens) > historyTreeLimit+1 {
		return nil, Fail("GIT_HISTORY_TREE_LIMIT")
	}
	tree := make(map[string]treeEntry, len(tokens))
	for _, token := range tokens {
		if token == "" {
			continue
		}
		match := treeLine.FindStringSubmatch(token)
		if match == nil || !shaPattern.MatchString(match[3]) {
			return nil, Fail("GIT_INVALID_TREE")
		}
		path := match[5]
		normalized, err := o.access.normalize(path)
		if err != nil || normalized != path {
			return nil, Fail("GIT_INVALID_PATH")
		}
		size := int64(-1)
		if match[4] != "-" {
			size, err = strconv.ParseInt(match[4], 10, 64)
			if err != nil {
				return nil, Fail("GIT_INVALID_TREE")
			}
		}
		tree[path] = treeEntry{mode: match[1], oid: match[3], size: int(size)}
	}
	o.trees[sha] = tree
	return tree, nil
}

func (o *observation) policy(sha, path string) (*ignoreMatcher, error) {
	key := sha + ":" + path
	if cached, ok := o.policies[key]; ok {
		return cached, nil
	}
	tree, err := o.tree(sha)
	if err != nil {
		return nil, err
	}
	entry, ok := tree[path]
	if !ok {
		return o.empty, nil
	}
	if len(o.policies) >= 128 {
		return nil, Fail("GIT_HISTORY_POLICY_LIMIT")
	}
	if !regularModes.MatchString(entry.mode) || entry.size < 0 || entry.size > 65536 {
		return nil, Fail("POLICY_UNREADABLE")
	}
	raw, err := o.git([]string{"cat-file", "blob", entry.oid})
	if err != nil {
		return nil, Fail("POLICY_UNREADABLE")
	}
	if len(raw) != entry.size {
		return nil, Fail("POLICY_UNREADABLE")
	}
	o.policyBytes += len(raw)
	if o.policyBytes > MaxFile {
		return nil, Fail("POLICY_UNREADABLE")
	}
	text, err := PolicyText(raw)
	if err != nil {
		return nil, Fail("POLICY_UNREADABLE")
	}
	matcher := parseIgnore(text)
	o.policies[key] = matcher
	return matcher, nil
}

func (o *observation) allowed(path string, snapshots []string) (bool, error) {
	if err := o.checkBudget(); err != nil {
		return false, err
	}
	normalized, err := o.access.normalize(path)
	if err != nil || normalized != path || path == "" {
		return false, nil
	}
	ok, err := o.access.allowed(path, false)
	if err != nil || !ok {
		return false, err
	}
	parts := strings.Split(path, "/")
	if len(parts) > 32 {
		return false, Fail("GIT_HISTORY_PATH_DEPTH_LIMIT")
	}
	for _, sha := range snapshots {
		tree, err := o.tree(sha)
		if err != nil {
			return false, err
		}
		for i := 0; i < len(parts); i++ {
			base := strings.Join(parts[:i], "/")
			if base != "" {
				if entry, ok := tree[base]; ok && (entry.mode == "120000" || entry.mode == "160000") {
					return false, nil
				}
			}
			sub := strings.Join(parts[i:], "/")
			for _, name := range []string{".gitignore", ".convorelignore"} {
				policyPath := name
				if base != "" {
					policyPath = base + "/" + name
				}
				matcher, err := o.policy(sha, policyPath)
				if err != nil {
					return false, err
				}
				if matcher.ignored(sub, false) {
					return false, nil
				}
			}
		}
	}
	return true, nil
}

func (o *observation) blob(entry treeEntry) ([]byte, string, error) {
	if !regularModes.MatchString(entry.mode) {
		return nil, "", Fail("GIT_NOT_REGULAR_FILE")
	}
	if entry.size < 0 || entry.size > MaxFile {
		return nil, "", Fail("FILE_TOO_LARGE")
	}
	raw, err := o.git([]string{"cat-file", "blob", entry.oid})
	if err != nil {
		return nil, "", err
	}
	if len(raw) != entry.size {
		return nil, "", Fail("GIT_INVALID_BLOB")
	}
	text, err := textBlob(raw)
	if err != nil {
		return nil, "", err
	}
	return raw, text, nil
}

func historyDiffArgs(base *string, head string, format []string) []string {
	args := []string{
		"diff-tree",
		"--no-commit-id",
		"-r",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-relative",
		"--no-abbrev",
		"--find-renames=1%",
		"-l10000",
		"--diff-algorithm=myers",
		"--ignore-submodules=all",
		"--output-indicator-new=+",
		"--output-indicator-old=-",
		"--output-indicator-context= ",
	}
	args = append(args, format...)
	if base != nil {
		args = append(args, *base, head)
	} else {
		args = append(args, "--root", head)
	}
	return args
}

func (o *observation) changes(base *string, head string, snapshots []string) ([]historyChange, int, error) {
	rawArgs := append(historyDiffArgs(base, head, []string{"--raw", "-z"}), "--")
	rawBytes, err := o.git(rawArgs)
	if err != nil {
		return nil, 0, err
	}
	raw := strings.Split(string(rawBytes), "\x00")
	all := []historyChange{}
	modes := map[string][]string{}
	for i := 0; i < len(raw) && raw[i] != ""; {
		meta := historyDiff.FindStringSubmatch(raw[i])
		i++
		if meta == nil {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		if i >= len(raw) {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		first := raw[i]
		i++
		renamed := meta[5] == "R" || meta[5] == "C"
		path := first
		if renamed {
			if i >= len(raw) {
				return nil, 0, Fail("GIT_INVALID_DIFF")
			}
			path = raw[i]
			i++
		}
		if path == "" || first == "" || !shaPattern.MatchString(meta[3]) || !shaPattern.MatchString(meta[4]) {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		if len(all) >= historyInventoryLimit {
			return nil, 0, Fail("GIT_HISTORY_DIFF_LIMIT")
		}
		modes[path] = []string{meta[1], meta[2]}
		change := historyChange{
			historyFile: historyFile{Path: path, Status: meta[5]},
			oldOID:      meta[3],
			newOID:      meta[4],
		}
		if renamed {
			previous := first
			change.OldPath = &previous
		}
		all = append(all, change)
	}
	numArgs := append(historyDiffArgs(base, head, []string{"--numstat", "-z"}), "--")
	numBytes, err := o.git(numArgs)
	if err != nil {
		return nil, 0, err
	}
	nums := strings.Split(string(numBytes), "\x00")
	type stat struct {
		add     int
		del     int
		binary  bool
		oldPath *string
	}
	stats := map[string]stat{}
	for i := 0; i < len(nums) && nums[i] != ""; {
		match := numstatLine.FindStringSubmatch(nums[i])
		i++
		if match == nil {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		renamed := match[3] == ""
		var oldPath *string
		path := match[3]
		if renamed {
			if i+1 >= len(nums) {
				return nil, 0, Fail("GIT_INVALID_DIFF")
			}
			value := nums[i]
			oldPath = &value
			i++
			path = nums[i]
			i++
		}
		if path == "" {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		add, del := 0, 0
		binary := match[1] == "-" || match[2] == "-"
		if !binary {
			add, err = strconv.Atoi(match[1])
			if err != nil {
				return nil, 0, Fail("GIT_INVALID_DIFF")
			}
			del, err = strconv.Atoi(match[2])
			if err != nil {
				return nil, 0, Fail("GIT_INVALID_DIFF")
			}
		}
		stats[path] = stat{add: add, del: del, binary: binary, oldPath: oldPath}
	}
	hidden := 0
	visible := []historyChange{}
	for _, change := range all {
		if err := o.checkBudget(); err != nil {
			return nil, 0, err
		}
		entry, ok := stats[change.Path]
		if !ok || !sameOptional(entry.oldPath, change.OldPath) {
			return nil, 0, Fail("GIT_INVALID_DIFF")
		}
		paths := []string{change.Path}
		if change.OldPath != nil {
			paths = append(paths, *change.OldPath)
		}
		unsafeMode := false
		for _, mode := range modes[change.Path] {
			if mode != "000000" && mode != "100644" && mode != "100755" {
				unsafeMode = true
			}
		}
		oversized := false
		for _, sha := range snapshots {
			tree, err := o.tree(sha)
			if err != nil {
				return nil, 0, err
			}
			for _, p := range paths {
				if value, ok := tree[p]; ok && value.size > MaxFile {
					oversized = true
				}
			}
		}
		allowed := true
		for _, p := range paths {
			ok, err := o.allowed(p, snapshots)
			if err != nil {
				return nil, 0, err
			}
			if !ok {
				allowed = false
			}
		}
		if unsafeMode || oversized || entry.binary || !allowed {
			hidden++
			continue
		}
		change.Additions = entry.add
		change.Deletions = entry.del
		visible = append(visible, change)
	}
	return visible, hidden, nil
}

func sameOptional(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (o *observation) comparison(base, head, effectiveBase *string, mode string, mergeBases []string, page page) (map[string]any, error) {
	seen := map[string]bool{}
	snapshots := []string{}
	for _, value := range []*string{base, head, effectiveBase} {
		if value == nil || seen[*value] {
			continue
		}
		seen[*value] = true
		snapshots = append(snapshots, *value)
	}
	visible, hidden, err := o.changes(effectiveBase, *head, snapshots)
	if err != nil {
		return nil, err
	}
	files := []historyFile{}
	end := page.offset + page.limit
	if end > len(visible) {
		end = len(visible)
	}
	if page.offset < len(visible) {
		for _, change := range visible[page.offset:end] {
			candidate := append(append([]historyFile{}, files...), change.historyFile)
			if jsonBytes(candidate) > historyTextBudget {
				break
			}
			files = append(files, change.historyFile)
		}
	}
	if len(files) == 0 && page.offset < len(visible) {
		return nil, Fail("GIT_HISTORY_RESPONSE_LIMIT")
	}
	var next any
	if page.offset+len(files) < len(visible) {
		next = page.offset + len(files)
	}
	var patch any
	patchMore := false
	selected := (*historyChange)(nil)
	if page.patchFile != nil {
		requested, err := o.access.normalize(*page.patchFile)
		if err != nil {
			return nil, err
		}
		for i := range visible {
			if visible[i].Path == requested {
				selected = &visible[i]
				break
			}
		}
		if selected == nil {
			return nil, Fail("ACCESS_DENIED")
		}
	} else if page.offset < len(visible) {
		selected = &visible[page.offset]
	}
	if selected != nil {
		paths := []string{selected.Path}
		oldPath := selected.Path
		if selected.OldPath != nil {
			paths = append(paths, *selected.OldPath)
			oldPath = *selected.OldPath
		}
		for _, pair := range []struct {
			sha  *string
			path string
		}{{effectiveBase, oldPath}, {head, selected.Path}} {
			if pair.sha == nil {
				continue
			}
			tree, err := o.tree(*pair.sha)
			if err != nil {
				return nil, err
			}
			if entry, ok := tree[pair.path]; ok {
				if _, _, err := o.blob(entry); err != nil {
					return nil, err
				}
			}
		}
		args := append(historyDiffArgs(effectiveBase, *head, []string{
			"--raw", "-z", "-p", "--full-index", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/",
		}), "--")
		args = append(args, paths...)
		combined, err := o.git(args)
		if err != nil {
			return nil, err
		}
		selection := patchSelection{path: selected.Path, oldOID: selected.oldOID, newOID: selected.newOID, status: selected.Status[:1], oldPath: selected.OldPath}
		raw, err := selectGitPatch(combined, selection)
		if err != nil {
			return nil, err
		}
		full, err := decodeGitStrict(raw)
		if err != nil {
			return nil, err
		}
		text, nextOffset, err := chunkHistory(full, page.patchOffset, historyTextBudget)
		if err != nil {
			return nil, err
		}
		patchMore = nextOffset != nil
		patch = map[string]any{
			"filePath":    selected.Path,
			"text":        text,
			"offset":      page.patchOffset,
			"nextOffset":  optionalInt(nextOffset),
			"totalLength": UTF16Length(full),
			"sha256":      sha256Hex(raw),
			"hashScope":   "whole-patch",
		}
	} else if page.patchOffset != 0 {
		return nil, Fail("INVALID_PATCH_OFFSET")
	}
	meta, err := o.meta()
	if err != nil {
		return nil, err
	}
	summary := map[string]any{"visibleFiles": len(visible), "hiddenFiles": hidden, "additions": 0, "deletions": 0}
	additions, deletions := 0, 0
	for _, file := range visible {
		additions += file.Additions
		deletions += file.Deletions
	}
	summary["additions"] = additions
	summary["deletions"] = deletions
	return map[string]any{
		"workspaceId":   meta["workspaceId"],
		"observedAt":    meta["observedAt"],
		"shallow":       meta["shallow"],
		"base":          optionalString(base),
		"head":          *head,
		"effectiveBase": optionalString(effectiveBase),
		"mode":          mode,
		"mergeBases":    mergeBases,
		"files":         files,
		"offset":        page.offset,
		"nextOffset":    next,
		"truncated":     next != nil || patchMore,
		"summary":       summary,
		"patch":         patch,
		"note":          "Immutable commit comparison; statistics cover visible regular text files only. Current and historical ignore policies apply to both rename names. Binary, non-regular and oversized files are hidden. Pin SHAs and policy state when paginating; no claim of linear ancestry. Patch fragments may split lines; offsets count UTF-16 code units.",
	}, nil
}

func optionalInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func chunkHistory(text string, offset, budget int) (string, *int, error) {
	fragment, next, err := TextChunk(text, offset, budget)
	if err != nil {
		if HasCode(err, "INVALID_OFFSET") || HasCode(err, "INVALID_RANGE") {
			return "", nil, Fail("INVALID_PATCH_OFFSET")
		}
		return "", nil, Fail("GIT_HISTORY_RESPONSE_LIMIT")
	}
	return fragment, next, nil
}

func finishHistory(value map[string]any) (map[string]any, error) {
	if jsonBytes(value) > historyMaxOutput {
		return nil, Fail("GIT_HISTORY_RESPONSE_LIMIT")
	}
	return value, nil
}

// Log returns a page of commit history.
func (h *History) Log(options LogOptions) (map[string]any, error) {
	if err := h.access.ready(); err != nil {
		return nil, err
	}
	ref := options.Ref
	if ref == "" {
		ref = "HEAD"
	}
	if !validRef(ref) {
		return nil, Invalid("invalid ref")
	}
	limit := options.Limit
	if limit == 0 {
		limit = 20
	}
	if _, err := Integer(options.Offset, 0, 1<<31-1); err != nil {
		return nil, Invalid("invalid offset")
	}
	if _, err := Integer(limit, 1, 100); err != nil {
		return nil, Invalid("invalid limit")
	}
	o := newObservation(h.access)
	resolved, err := o.resolve(ref)
	if err != nil {
		return nil, err
	}
	raw, err := o.git([]string{"rev-list", fmt.Sprintf("--skip=%d", options.Offset), fmt.Sprintf("--max-count=%d", limit+1), resolved, "--"})
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, line := range strings.Split(strings.TrimSpace(decodeGit(raw)), "\n") {
		if line != "" {
			ids = append(ids, line)
		}
	}
	for _, id := range ids {
		if !shaPattern.MatchString(id) {
			return nil, Fail("GIT_INVALID_OUTPUT")
		}
	}
	commits := []Commit{}
	for _, sha := range ids {
		if len(commits) >= limit {
			break
		}
		commit, err := o.commit(sha)
		if err != nil {
			return nil, err
		}
		candidate := append(append([]Commit{}, commits...), commit)
		if jsonBytes(candidate) > historyCommitBudget {
			break
		}
		commits = append(commits, commit)
	}
	truncated := len(ids) > len(commits)
	var next any
	if truncated {
		next = options.Offset + len(commits)
	}
	meta, err := o.meta()
	if err != nil {
		return nil, err
	}
	return finishHistory(map[string]any{
		"workspaceId": meta["workspaceId"],
		"observedAt":  meta["observedAt"],
		"shallow":     meta["shallow"],
		"resolvedRef": resolved,
		"commits":     commits,
		"offset":      options.Offset,
		"nextOffset":  next,
		"truncated":   truncated,
	})
}

// Show compares one commit to its selected parent.
func (h *History) Show(options ShowOptions) (map[string]any, error) {
	if err := h.access.ready(); err != nil {
		return nil, err
	}
	ref := options.Ref
	if ref == "" {
		ref = "HEAD"
	}
	if !validRef(ref) {
		return nil, Invalid("invalid ref")
	}
	parentIndex := options.Parent
	if parentIndex == 0 {
		parentIndex = 1
	}
	if _, err := Integer(parentIndex, 1, 100); err != nil {
		return nil, Invalid("invalid parent")
	}
	limit := options.Limit
	if limit == 0 {
		limit = 20
	}
	if _, err := Integer(options.Offset, 0, 10000); err != nil {
		return nil, Invalid("invalid offset")
	}
	if _, err := Integer(limit, 1, 100); err != nil {
		return nil, Invalid("invalid limit")
	}
	if _, err := Integer(options.PatchOffset, 0, 16*1024*1024); err != nil {
		return nil, Invalid("invalid patchOffset")
	}
	if _, err := Integer(options.MessageOffset, 0, 1024*1024); err != nil {
		return nil, Invalid("invalid messageOffset")
	}
	if options.PatchFile != nil && !validFilePath(*options.PatchFile) {
		return nil, Invalid("invalid patchFile")
	}
	o := newObservation(h.access)
	head, err := o.resolve(ref)
	if err != nil {
		return nil, err
	}
	commit, err := o.commit(head)
	if err != nil {
		return nil, err
	}
	maximum := len(commit.Parents)
	if maximum < 1 {
		maximum = 1
	}
	if parentIndex > maximum {
		return nil, Fail("GIT_INVALID_PARENT")
	}
	var base *string
	if parentIndex <= len(commit.Parents) {
		value := commit.Parents[parentIndex-1]
		base = &value
	}
	if base != nil {
		if _, err := o.resolve(*base); err != nil {
			return nil, err
		}
	}
	comparison, err := o.comparison(base, &head, base, "direct", []string{}, page{
		offset: options.Offset, limit: limit, patchFile: options.PatchFile, patchOffset: options.PatchOffset,
	})
	if err != nil {
		return nil, err
	}
	comparison["commit"] = commit
	comparison["parent"] = parentIndex
	message, messageSHA, err := o.message(head)
	if err != nil {
		return nil, err
	}
	budget := historyMaxOutput - jsonBytes(comparison) - 1024
	if budget > 8192 {
		budget = 8192
	}
	text, next, err := TextChunk(message, options.MessageOffset, budget)
	if err != nil {
		if HasCode(err, "INVALID_OFFSET") || HasCode(err, "INVALID_RANGE") {
			return nil, Fail("INVALID_MESSAGE_OFFSET")
		}
		return nil, Fail("GIT_HISTORY_RESPONSE_LIMIT")
	}
	comparison["message"] = map[string]any{
		"text":        text,
		"offset":      options.MessageOffset,
		"nextOffset":  optionalInt(next),
		"totalLength": UTF16Length(message),
		"sha256":      messageSHA,
	}
	comparison["truncated"] = comparison["truncated"] == true || next != nil
	return finishHistory(comparison)
}

// Compare compares two immutable commits.
func (h *History) Compare(options CompareOptions) (map[string]any, error) {
	if err := h.access.ready(); err != nil {
		return nil, err
	}
	if !validRef(options.Base) {
		return nil, Invalid("invalid base")
	}
	headRef := options.Head
	if headRef == "" {
		headRef = "HEAD"
	}
	if !validRef(headRef) {
		return nil, Invalid("invalid head")
	}
	mode := options.Mode
	if mode == "" {
		mode = "direct"
	}
	if mode != "direct" && mode != "merge-base" {
		return nil, Invalid("invalid mode")
	}
	limit := options.Limit
	if limit == 0 {
		limit = 20
	}
	if _, err := Integer(options.Offset, 0, 10000); err != nil {
		return nil, Invalid("invalid offset")
	}
	if _, err := Integer(limit, 1, 100); err != nil {
		return nil, Invalid("invalid limit")
	}
	if _, err := Integer(options.PatchOffset, 0, 16*1024*1024); err != nil {
		return nil, Invalid("invalid patchOffset")
	}
	if options.PatchFile != nil && !validFilePath(*options.PatchFile) {
		return nil, Invalid("invalid patchFile")
	}
	o := newObservation(h.access)
	base, err := o.resolve(options.Base)
	if err != nil {
		return nil, err
	}
	head, err := o.resolve(headRef)
	if err != nil {
		return nil, err
	}
	effectiveBase := base
	mergeBases := []string{}
	if mode == "merge-base" {
		raw, err := o.git([]string{"merge-base", "--all", base, head})
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if line != "" {
				mergeBases = append(mergeBases, line)
			}
		}
		if len(mergeBases) != 1 || !shaPattern.MatchString(mergeBases[0]) {
			return nil, Fail("GIT_AMBIGUOUS_OR_MISSING_MERGE_BASE")
		}
		effectiveBase = mergeBases[0]
	}
	result, err := o.comparison(&base, &head, &effectiveBase, mode, mergeBases, page{
		offset: options.Offset, limit: limit, patchFile: options.PatchFile, patchOffset: options.PatchOffset,
	})
	if err != nil {
		return nil, err
	}
	return finishHistory(result)
}

// Read reads a UTF-8 file at an immutable revision.
func (h *History) Read(options ReadOptions) (map[string]any, error) {
	if err := h.access.ready(); err != nil {
		return nil, err
	}
	ref := options.Ref
	if ref == "" {
		ref = "HEAD"
	}
	if !validRef(ref) {
		return nil, Invalid("invalid ref")
	}
	if !validFilePath(options.FilePath) {
		return nil, Invalid("invalid filePath")
	}
	startLine := options.StartLine
	if startLine == 0 {
		startLine = 1
	}
	if _, err := Integer(startLine, 1, 10_000_000); err != nil {
		return nil, Invalid("invalid startLine")
	}
	maxLines := options.MaxLines
	if maxLines == 0 {
		maxLines = 200
	}
	if _, err := Integer(maxLines, 1, 1000); err != nil {
		return nil, Invalid("invalid maxLines")
	}
	o := newObservation(h.access)
	commit, err := o.resolve(ref)
	if err != nil {
		return nil, err
	}
	filePath, err := h.access.normalize(options.FilePath)
	if err != nil {
		return nil, err
	}
	allowed, err := o.allowed(filePath, []string{commit})
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, Fail("ACCESS_DENIED")
	}
	tree, err := o.tree(commit)
	if err != nil {
		return nil, err
	}
	entry, ok := tree[filePath]
	if !ok {
		return nil, Fail("GIT_FILE_NOT_FOUND")
	}
	raw, text, err := o.blob(entry)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	starting := startLine - 1
	if starting > len(lines) {
		starting = len(lines)
	}
	ending := starting + maxLines
	if ending > len(lines) {
		ending = len(lines)
	}
	selected := []string{}
	for _, line := range lines[starting:ending] {
		candidate := append(append([]string{}, selected...), line)
		if jsonBytes(strings.Join(candidate, "\n")) > historyReadBudget {
			if len(selected) == 0 {
				return nil, Fail("LINE_TOO_LONG")
			}
			break
		}
		selected = append(selected, line)
	}
	endLine := startLine + len(selected) - 1
	truncated := endLine < len(lines)
	var next any
	if truncated {
		next = endLine + 1
	}
	meta, err := o.meta()
	if err != nil {
		return nil, err
	}
	return finishHistory(map[string]any{
		"workspaceId":   meta["workspaceId"],
		"observedAt":    meta["observedAt"],
		"shallow":       meta["shallow"],
		"commit":        commit,
		"blob":          entry.oid,
		"filePath":      filePath,
		"content":       strings.Join(selected, "\n"),
		"startLine":     startLine,
		"endLine":       endLine,
		"totalLines":    len(lines),
		"nextStartLine": next,
		"truncated":     truncated,
		"sizeBytes":     len(raw),
		"sha256":        sha256Hex(raw),
		"hashScope":     "whole-blob",
	})
}

func decodeGit(raw []byte) string { return string(raw) }

func decodeGitStrict(raw []byte) (string, error) {
	if !utf8.Valid(raw) {
		return "", Fail("GIT_INVALID_UTF8")
	}
	return string(raw), nil
}

func textBlob(raw []byte) (string, error) {
	if bytes.IndexByte(raw, 0) >= 0 {
		return "", Fail("BINARY_FILE")
	}
	text, err := decodeGitStrict(raw)
	if err != nil {
		return "", err
	}
	for _, r := range text {
		if (r >= 0x01 && r <= 0x08) || r == 0x0b || r == 0x0c || (r >= 0x0e && r <= 0x1f) || r == 0x7f {
			return "", Fail("BINARY_FILE")
		}
	}
	return text, nil
}
