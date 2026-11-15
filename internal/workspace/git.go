package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Git runs live Git observations inside one workspace.
type Git struct {
	Root         string
	ID           string
	check        func() error
	normalize    func(string) (string, error)
	allowed      func(string, bool) (bool, error)
	storageCheck func(string) bool
}

// DiffOptions mirrors git_diff pagination.
type DiffOptions struct {
	Offset      int
	Limit       int
	PatchFile   *string
	PatchOffset int
}

var shaPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var regularModes = regexp.MustCompile(`^(?:100644|100755)$`)
var diffModePattern = regexp.MustCompile(`^:?(?:100\d{3}|000000)$`)

type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if l.buf.Len()+len(p) > l.limit {
		l.over = true
		return 0, errors.New("GIT_OUTPUT_LIMIT")
	}
	return l.buf.Write(p)
}

func childEnv() []string {
	keys := []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"}
	env := make([]string, 0, len(keys)+8)
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func (g *Git) git(args []string, acceptMissing bool) ([]byte, error) {
	if err := g.check(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	full := append([]string{
		"--no-pager",
		"--no-replace-objects",
		"--no-optional-locks",
		"--no-lazy-fetch",
		"--literal-pathspecs",
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "diff.external=",
		"-c", "core.pager=cat",
		"-C", g.Root,
	}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(childEnv(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_NO_LAZY_FETCH=1",
		"GIT_OPTIONAL_LOCKS=0",
	)
	stdout := &limitedBuffer{limit: 4 * MaxFile}
	stderr := &limitedBuffer{limit: 64 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	if ctx.Err() != nil || stdout.over || stderr.over {
		return nil, Fail("GIT_LIMIT_OR_PROCESS_ERROR")
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			if acceptMissing && exit.ExitCode() == 1 {
				return nil, nil
			}
			return nil, Fail("GIT_FAILED")
		}
		return nil, Fail("GIT_LIMIT_OR_PROCESS_ERROR")
	}
	return stdout.buf.Bytes(), nil
}

func (g *Git) text(args []string, acceptMissing bool) (string, error) {
	value, err := g.git(args, acceptMissing)
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func (g *Git) ready() error {
	gitDir, err := g.text([]string{"rev-parse", "--absolute-git-dir"}, false)
	if err != nil {
		return err
	}
	common, err := g.text([]string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, false)
	if err != nil {
		return err
	}
	gitDir = strings.TrimSpace(gitDir)
	common = strings.TrimSpace(common)
	storageAllowed := g.storageCheck
	if storageAllowed == nil {
		storageAllowed = func(path string) bool {
			rel, err := filepath.Rel(g.Root, path)
			if err != nil {
				return false
			}
			if rel != "." && (rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel)) {
				return false
			}
			real, err := filepath.EvalSymlinks(path)
			return err == nil && real == path
		}
	}
	for _, path := range []string{gitDir, common, filepath.Join(common, "objects")} {
		if !storageAllowed(path) {
			return Fail("GIT_STORAGE_OUTSIDE_ROOTS")
		}
	}
	for _, name := range []string{"alternates", "http-alternates"} {
		if _, err := os.Lstat(filepath.Join(common, "objects", "info", name)); err == nil {
			return Fail("GIT_ALTERNATES_UNSUPPORTED")
		}
	}
	if err := checkGitObjects(filepath.Join(common, "objects")); err != nil {
		return err
	}
	toplevel, err := g.text([]string{"rev-parse", "--show-toplevel"}, false)
	if err != nil {
		return err
	}
	if strings.TrimSpace(toplevel) != g.Root {
		return Fail("GIT_ROOT_REQUIRED")
	}
	filters, err := g.text([]string{"config", "--get-regexp", `^filter\..*\.(clean|process)$`}, true)
	if err != nil {
		return err
	}
	if filters != "" {
		return Fail("GIT_FILTER_UNSUPPORTED")
	}
	return nil
}

func (g *Git) head() *string {
	value, err := g.text([]string{"rev-parse", "--verify", "HEAD"}, false)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(value)
	return &trimmed
}

// Info returns live workspace metadata, with Git failures reported rather than
// treated as an absent repository.
func (g *Git) Info() (map[string]any, error) {
	var gitHead, gitBranch, gitError any
	if err := g.ready(); err != nil {
		code := Code(err)
		if code == "" {
			code = "GIT_UNAVAILABLE"
		}
		gitError = code
	} else {
		if head := g.head(); head != nil {
			gitHead = *head
		}
		branch, err := g.text([]string{"symbolic-ref", "--quiet", "--short", "HEAD"}, true)
		if err == nil && strings.TrimSpace(branch) != "" {
			gitBranch = strings.TrimSpace(branch)
		}
	}
	name := filepath.Base(g.Root)
	return map[string]any{
		"workspaceId": g.ID,
		"name":        name,
		"gitHead":     gitHead,
		"gitBranch":   gitBranch,
		"gitError":    gitError,
		"mode":        "live-read-only",
		"observedAt":  nowISO(),
		"limits": map[string]any{
			"maxFileBytes":            MaxFile,
			"maxResponseContentBytes": MaxOut,
		},
		"policy": policyTextValue,
	}, nil
}

type statusEntry struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// Status returns one page of filtered porcelain status.
func (g *Git) Status(offset, limit int) (map[string]any, error) {
	if _, err := Integer(offset, 0, 1_000_000); err != nil {
		return nil, err
	}
	if _, err := Integer(limit, 1, 500); err != nil {
		return nil, err
	}
	if err := g.ready(); err != nil {
		return nil, err
	}
	raw, err := g.git([]string{"status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all", "--", "."}, false)
	if err != nil {
		return nil, err
	}
	entries := []statusEntry{}
	hidden := 0
	for _, row := range bytes.Split(raw, []byte{0}) {
		if len(row) < 3 {
			continue
		}
		path := string(row[3:])
		ok, err := g.allowed(path, false)
		if err != nil {
			return nil, err
		}
		if !ok {
			hidden++
			continue
		}
		entries = append(entries, statusEntry{Path: path, Change: string(row[:2])})
	}
	start := offset
	if start > len(entries) {
		start = len(entries)
	}
	end := start + limit
	if end > len(entries) {
		end = len(entries)
	}
	selected := append([]statusEntry{}, entries[start:end]...)
	for len(selected) > 0 && jsonBytes(selected) > ContentBudget {
		selected = selected[:len(selected)-1]
	}
	var next any
	if offset+len(selected) < len(entries) {
		next = offset + len(selected)
	}
	return map[string]any{
		"head":        optionalString(g.head()),
		"entries":     selected,
		"hidden":      hidden,
		"truncated":   offset+len(selected) < len(entries),
		"offset":      offset,
		"limit":       limit,
		"nextOffset":  next,
		"dirty":       len(raw) > 0,
		"workspaceId": g.ID,
		"observedAt":  nowISO(),
	}, nil
}

// DiffFile is one filtered changed path in a live diff page.
type DiffFile struct {
	Path         string  `json:"path"`
	PreviousPath *string `json:"previousPath"`
	Change       string  `json:"change"`
}

type diffGroup struct {
	paths  []string
	change string
	oldOID string
	newOID string
}

// Diff returns a filtered live diff page with a resumable single-file patch.
func (g *Git) Diff(mode string, options DiffOptions) (map[string]any, error) {
	offset := options.Offset
	limit := options.Limit
	if limit == 0 {
		limit = 100
	}
	patchOffset := options.PatchOffset
	if _, err := Integer(offset, 0, 1_000_000); err != nil {
		return nil, err
	}
	if _, err := Integer(limit, 1, 500); err != nil {
		return nil, err
	}
	if _, err := Integer(patchOffset, 0, 10_000_000); err != nil {
		return nil, err
	}
	if mode != "unstaged" && mode != "staged" && mode != "head" {
		return nil, Fail("INVALID_DIFF_MODE")
	}
	if err := g.ready(); err != nil {
		return nil, err
	}
	extra := []string{}
	if mode == "staged" {
		extra = append(extra, "--cached")
	} else if mode == "head" {
		extra = append(extra, "HEAD")
	}
	flags := []string{
		"--no-relative",
		"--output-indicator-new=+",
		"--output-indicator-old=-",
		"--output-indicator-context= ",
		"--no-ext-diff",
		"--no-textconv",
		"--ignore-submodules=all",
		"--find-renames=1%",
	}
	rawArgs := append([]string{"diff", "--raw", "-z", "--no-abbrev"}, flags...)
	rawArgs = append(rawArgs, extra...)
	rawArgs = append(rawArgs, "--", ".")
	raw, err := g.text(rawArgs, false)
	if err != nil {
		return nil, err
	}
	tokens := strings.Split(raw, "\x00")
	groups := []diffGroup{}
	hidden := 0
	for i := 0; i < len(tokens) && tokens[i] != ""; {
		meta := strings.Split(tokens[i], " ")
		i++
		if i >= len(tokens) {
			return nil, Fail("GIT_FAILED")
		}
		path := tokens[i]
		i++
		paths := []string{path}
		if len(meta) >= 5 && (strings.HasPrefix(meta[4], "R") || strings.HasPrefix(meta[4], "C")) {
			if i >= len(tokens) {
				return nil, Fail("GIT_FAILED")
			}
			paths = []string{path, tokens[i]}
			i++
		}
		unsafe := false
		for _, p := range paths {
			if p == "" {
				unsafe = true
				break
			}
			ok, err := g.allowed(p, false)
			if err != nil {
				return nil, err
			}
			if !ok {
				unsafe = true
			}
		}
		if len(meta) < 5 {
			unsafe = true
		} else {
			for _, value := range meta[:2] {
				if !diffModePattern.MatchString(value) {
					unsafe = true
				}
			}
		}
		if unsafe {
			hidden++
			continue
		}
		groups = append(groups, diffGroup{paths: paths, change: meta[4], oldOID: meta[2], newOID: meta[3]})
	}
	conflicts := map[string]bool{}
	for _, group := range groups {
		if group.change == "U" {
			conflicts[group.paths[0]] = true
		}
	}
	changes := make([]diffGroup, 0, len(groups))
	for _, group := range groups {
		if group.change != "U" {
			skip := false
			for _, p := range group.paths {
				if conflicts[p] {
					skip = true
				}
			}
			if skip {
				continue
			}
		}
		changes = append(changes, group)
	}
	files := []DiffFile{}
	end := offset + limit
	if end > len(changes) {
		end = len(changes)
	}
	if offset < len(changes) {
		for _, group := range changes[offset:end] {
			var previous *string
			if len(group.paths) == 2 {
				value := group.paths[0]
				previous = &value
			}
			files = append(files, DiffFile{Path: group.paths[len(group.paths)-1], PreviousPath: previous, Change: group.change})
		}
	}
	for len(files) > 0 && jsonBytes(files) > 16*1024 {
		files = files[:len(files)-1]
	}
	requested := ""
	if options.PatchFile != nil {
		normalized, err := g.normalize(*options.PatchFile)
		if err != nil {
			return nil, err
		}
		requested = normalized
	} else if len(files) > 0 {
		requested = files[0].Path
	}
	var selected *diffGroup
	for i := range changes {
		if changes[i].paths[len(changes[i].paths)-1] == requested {
			selected = &changes[i]
			break
		}
	}
	if options.PatchFile != nil && selected == nil {
		return nil, Fail("DIFF_FILE_UNAVAILABLE")
	}
	patch := ""
	if selected != nil {
		if selected.change == "" {
			return nil, Fail("GIT_FAILED")
		}
		if selected.change == "U" {
			patch, err = g.conflictEvidence(selected.paths[0])
			if err != nil {
				return nil, err
			}
		} else {
			patchArgs := append([]string{"diff", "--raw", "-z", "-p", "--no-abbrev", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"}, flags...)
			patchArgs = append(patchArgs, extra...)
			patchArgs = append(patchArgs, "--")
			patchArgs = append(patchArgs, selected.paths...)
			combined, err := g.git(patchArgs, false)
			if err != nil {
				return nil, err
			}
			selection := patchSelection{
				path:    selected.paths[len(selected.paths)-1],
				oldOID:  selected.oldOID,
				newOID:  selected.newOID,
				status:  selected.change[:1],
				oldPath: nil,
			}
			if len(selected.paths) == 2 {
				value := selected.paths[0]
				selection.oldPath = &value
			}
			chosen, err := selectGitPatch(combined, selection)
			if err != nil {
				return nil, err
			}
			patch = string(chosen)
		}
	}
	diffFragment, nextPatchOffset, err := TextChunk(patch, patchOffset, 32*1024)
	if err != nil {
		return nil, err
	}
	var next any
	if offset+len(files) < len(changes) {
		next = offset + len(files)
	}
	truncated := next != nil || nextPatchOffset != nil
	var patchFile any
	if selected != nil {
		patchFile = selected.paths[len(selected.paths)-1]
	}
	return map[string]any{
		"mode":             mode,
		"files":            files,
		"offset":           offset,
		"limit":            limit,
		"nextOffset":       next,
		"patchFile":        patchFile,
		"patchOffset":      patchOffset,
		"nextPatchOffset":  optionalInt(nextPatchOffset),
		"totalPatchLength": UTF16Length(patch),
		"patchSha256":      sha256Hex([]byte(patch)),
		"diff":             diffFragment,
		"hidden":           hidden,
		"truncated":        truncated,
		"sha256":           sha256Hex([]byte(diffFragment)),
		"hashScope":        "returned-diff",
		"head":             optionalString(g.head()),
		"workspaceId":      g.ID,
		"observedAt":       nowISO(),
		"note":             "Live Git observation; files are paginated and diff is a fragment for patchFile (defaults to the first file on this page). Unmerged files have change U and index stage evidence instead of a combined patch; use read_file for current conflict text. Follow nextOffset for files and nextPatchOffset for that patch; offsets are UTF-16 code units. Recheck patchSha256 on continuation. Untracked contents are excluded. A clean worktree says nothing about recent commits; use git_log/git_show. Not an immutable snapshot.",
	}, nil
}

func (g *Git) conflictEvidence(path string) (string, error) {
	raw, err := g.text([]string{"ls-files", "--unmerged", "-z", "--", path}, false)
	if err != nil {
		return "", err
	}
	rows := []string{}
	for _, row := range strings.Split(raw, "\x00") {
		if row != "" {
			rows = append(rows, row)
		}
	}
	labels := map[string]string{"1": "base", "2": "ours", "3": "theirs"}
	pattern := regexp.MustCompile(`^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$`)
	stages := []string{}
	for _, row := range rows {
		match := pattern.FindStringSubmatch(row)
		if match == nil {
			return "", Fail("GIT_INVALID_CONFLICT")
		}
		if match[4] != path {
			continue
		}
		if !regularModes.MatchString(match[1]) {
			return "", Fail("GIT_NOT_REGULAR_FILE")
		}
		stages = append(stages, fmt.Sprintf("%s (stage %s): %s %s", labels[match[3]], match[3], match[1], match[2]))
	}
	if len(stages) == 0 {
		return "", Fail("GIT_PATCH_SELECTION_CHANGED")
	}
	quoted, _ := json.Marshal(path)
	return fmt.Sprintf("Unmerged path %s\nIndex stages (missing stages are absent):\n%s\nUse read_file for current worktree conflict text; this is not a combined patch.\n", quoted, strings.Join(stages, "\n")), nil
}

// History exposes commit history through one access point.
func (g *Git) History() *History {
	return &History{access: historyAccess{
		root:      g.Root,
		id:        g.ID,
		normalize: g.normalize,
		allowed:   g.allowed,
		ready:     g.ready,
		git: func(args []string) ([]byte, error) {
			return g.git(args, false)
		},
	}}
}
