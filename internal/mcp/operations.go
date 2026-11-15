package mcp

import (
	"encoding/json"
	"strings"

	"github.com/MarioJames/convorel/internal/workspace"
)

type operation struct {
	name        string
	description string
	params      []param
	run         func(args map[string]any) (map[string]any, error)
}

func (s *Server) operations() []*operation {
	pathParam := stringParam("path")
	discovery := []param{
		pathParam,
		{Name: "pattern", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(200), Default: "*"},
		intParam("depth", 1, 32, 12, false),
		intParam("offset", 0, 10000, 0, false),
		intParam("limit", 1, 500, 200, false),
	}
	historyPage := func() []param {
		return []param{
			intParam("offset", 0, 10000, 0, false),
			intParam("limit", 1, 100, 20, false),
		}
	}
	diffPage := func() []param {
		return append(historyPage(),
			optionalStringParam("patchFile", 4096),
			intParam("patchOffset", 0, 16*1024*1024, 0, false),
		)
	}
	return []*operation{
		{
			name:        "workspace_info",
			description: "List allowed roots by rootId with workspace=null, or identify the selected directory's project. workspaceId/workspacePath identify the nearest Git checkout inside the allowed root, falling back to that root without Git. path remains the requested scope. IDs are not authentication.",
			params:      []param{{Name: "path", Type: "string"}},
			run:         s.workspaceInfo,
		},
		{
			name:        "tree",
			description: "Show a bounded page of directory hierarchy for structural review, not proof of code dependencies. Returns both structured entries and rendered tree, sorted by relative path. Check depthLimited, scanTruncated, truncated and nextOffset; pages are live observations, not a snapshot.",
			params: []param{
				pathParam,
				intParam("depth", 1, 4, 1, false),
				intParam("offset", 0, 10000, 0, false),
				intParam("limit", 1, 500, 200, false),
			},
			run: s.tree,
		},
		{
			name:        "read_file",
			description: "Read a full file path within allowed roots, returning bounded UTF-8 lines and whole-file SHA-256.",
			params: []param{
				pathParam,
				intParam("startLine", 1, 10000000, 1, false),
				intParam("maxLines", 1, 1000, 400, false),
			},
			run: s.readFile,
		},
		{
			name:        "read_image",
			description: "Read an allowed PNG/JPEG/WebP screenshot or image as native image content, up to 1 MiB. Same file policy as read_file. A screenshot is evidence, not proof of execution time or tested revision; the caller must supply that context.",
			params:      []param{pathParam},
			run:         s.readImage,
		},
		{
			name:        "find_files",
			description: "Locate permitted files by glob, sorted by relative path. Patterns without '/' match basenames at any depth; e.g. '*.ts', '**/migrations/*.sql'. Check scanTruncated, depthLimited and nextOffset; narrowing path avoids scan limits.",
			params:      discovery,
			run:         s.findFiles,
		},
		{
			name:        "search_workspace",
			description: "Search literal case-sensitive text within a full directory path and optional file glob. Returns matching lines, bounded context and file hashes. Follow nextOffset; scanTruncated/depthLimited/skippedFiles mean incomplete coverage, not absence. Use read_file for truncated excerpts.",
			params: []param{
				pathParam,
				{Name: "pattern", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(200), Default: "*"},
				intParam("depth", 1, 32, 12, false),
				intParam("offset", 0, 1_000_000, 0, false),
				intParam("limit", 1, 50, 50, false),
				{Name: "query", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(200), Required: true},
				intParam("contextLines", 0, 5, 2, false),
			},
			run: s.searchWorkspace,
		},
		{
			name:        "git_status",
			description: "Filtered Git status for a full repository path. Requires the exact Git top level. Failures are not a clean tree. A clean worktree does not mean there are no recent commits; use git_log/git_show.",
			params: []param{
				pathParam,
				intParam("offset", 0, 1_000_000, 0, false),
				intParam("limit", 1, 500, 200, false),
			},
			run: s.gitStatus,
		},
		{
			name:        "git_diff",
			description: "Filtered live Git diff; excludes sensitive paths on either rename side, submodules, external drivers and filters. Untracked file contents are excluded. Paginated files plus one patch fragment; select patchFile and follow nextPatchOffset. Use git_show for a commit and git_compare for version differences.",
			params: []param{
				pathParam,
				{Name: "mode", Type: "string", Enum: []string{"unstaged", "staged", "head"}, Default: "unstaged"},
				intParam("offset", 0, 1_000_000, 0, false),
				intParam("limit", 1, 500, 100, false),
				optionalStringParam("patchFile", 4096),
				intParam("patchOffset", 0, 10000000, 0, false),
			},
			run: s.gitDiff,
		},
		{
			name:        "git_log",
			description: "Read paginated commit history. Resolve ref to an immutable SHA and reuse it on later pages. Empty worktree diff is unrelated to this history. Check shallow and truncation.",
			params: []param{
				pathParam,
				{Name: "ref", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1024), Default: "HEAD"},
				{Name: "offset", Type: "integer", Min: intPtr(0), Default: 0},
				intParam("limit", 1, 100, 20, false),
			},
			run: s.gitLog,
		},
		{
			name:        "git_show",
			description: "Inspect a commit with metadata, parent comparison, filtered file statistics and a resumable patch. Root commits compare to empty; merge commits select parent explicitly. Follow top-level nextOffset for files and patch.nextOffset with patchFile.",
			params: append([]param{
				pathParam,
				{Name: "ref", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1024), Default: "HEAD"},
				intParam("parent", 1, 100, 1, false),
				intParam("messageOffset", 0, 1024*1024, 0, false),
			}, diffPage()...),
			run: s.gitShow,
		},
		{
			name:        "git_compare",
			description: "Compare immutable versions: direct endpoint difference or merge-base change. Returns resolved SHAs, filtered file statistics and a resumable single-file patch. Pin returned SHAs for continuation.",
			params: append([]param{
				pathParam,
				stringParam("base"),
				{Name: "head", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1024), Default: "HEAD"},
				{Name: "mode", Type: "string", Enum: []string{"direct", "merge-base"}, Default: "direct"},
			}, diffPage()...),
			run: s.gitCompare,
		},
		{
			name:        "git_read_file",
			description: "Read UTF-8 filePath relative to the repository root at ref, including deleted historical files. Enforces current and historical ignore policies. Returns commit/blob identity, whole-file SHA-256 and line continuation.",
			params: []param{
				pathParam,
				{Name: "ref", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1024), Default: "HEAD"},
				{Name: "filePath", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(4096), Required: true},
				intParam("startLine", 1, 10000000, 1, false),
				intParam("maxLines", 1, 1000, 200, false),
			},
			run: s.gitReadFile,
		},
	}
}

func (s *Server) operation(name string) (*operation, bool) {
	for _, op := range s.ops {
		if op.name == name {
			return op, true
		}
	}
	return nil, false
}

func (s *Server) commandNames() []string {
	names := []string{}
	for _, op := range s.ops {
		if op.name == "workspace_info" || op.name == "read_image" {
			continue
		}
		names = append(names, op.name)
	}
	return names
}

// runOperation adds the project identity every content operation reports.
func (s *Server) runOperation(name string, args map[string]any) (map[string]any, error) {
	op, ok := s.operation(name)
	if !ok {
		return nil, workspace.Fail("COMMAND_DENIED")
	}
	if name == "workspace_info" {
		return op.run(args)
	}
	path, _ := args["path"].(string)
	identity, err := s.access.Identity(path)
	if err != nil {
		return nil, err
	}
	data, err := op.run(args)
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = map[string]any{}
	}
	data["rootId"] = identity.RootID
	data["workspaceId"] = identity.WorkspaceID
	data["workspacePath"] = identity.WorkspacePath
	return data, nil
}

func (s *Server) workspaceInfo(args map[string]any) (map[string]any, error) {
	path, _ := args["path"].(string)
	info, err := s.access.Info(path)
	if err != nil {
		return nil, err
	}
	roots := info["roots"]
	mode := info["mode"]
	var selected any
	if path != "" {
		workspaceInfo := map[string]any{}
		for key, value := range info {
			if key == "roots" || key == "mode" {
				continue
			}
			workspaceInfo[key] = value
		}
		selected = workspaceInfo
	}
	return map[string]any{
		"roots":     roots,
		"mode":      mode,
		"workspace": selected,
		"server": map[string]any{
			"name":                       "convorel",
			"version":                    s.version,
			"capabilityVersion":          "functions-v1",
			"tools":                      []string{"exec", "memory", "artifact", "capabilities"},
			"maxStructuredResponseBytes": workspace.MaxOut,
			"maxImageBytes":              1024 * 1024,
		},
	}, nil
}

type treeEntry struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Depth      int    `json:"depth"`
	ParentPath string `json:"parentPath"`
}

const treeNote = "Directory layout only, not dependency analysis. This page may omit parents returned on earlier pages. Depth-limited directories are not necessarily empty. Live pages may shift when files change; scanTruncated means unscanned entries cannot be recovered by nextOffset."

func (s *Server) tree(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	depth := args["depth"].(int)
	offset := args["offset"].(int)
	limit := args["limit"].(int)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	listing, err := selected.List(".", depth, offset, limit)
	if err != nil {
		return nil, err
	}
	entries := []treeEntry{}
	for _, entry := range listing["entries"].([]workspace.Entry) {
		parts := strings.Split(entry.Path, "/")
		parent := "."
		if len(parts) > 1 {
			parent = strings.Join(parts[:len(parts)-1], "/")
		}
		entries = append(entries, treeEntry{Path: entry.Path, Type: entry.Type, Depth: len(parts), ParentPath: parent})
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	data := map[string]any{
		"path":          absolute,
		"entries":       entries,
		"nextOffset":    listing["nextOffset"],
		"truncated":     listing["truncated"],
		"depthLimited":  listing["depthLimited"],
		"scanTruncated": listing["scanTruncated"],
		"depth":         depth,
		"offset":        offset,
		"limit":         limit,
		"tree":          "",
		"observedAt":    now(),
		"note":          treeNote,
	}
	render := func() string {
		lines := make([]string, 0, len(entries))
		for _, entry := range entries {
			suffix := ""
			if entry.Type == "directory" {
				suffix = "/"
			}
			lines = append(lines, strings.Repeat("  ", entry.Depth-1)+jsonQuote(entry.Path)+suffix)
		}
		return strings.Join(lines, "\n")
	}
	data["tree"] = render()
	for workspace.JSONSize(data) > workspace.MaxOut-2048 {
		if len(entries) == 0 {
			return nil, workspace.Fail("TREE_RESPONSE_TOO_LARGE")
		}
		entries = entries[:len(entries)-1]
		data["entries"] = entries
		data["tree"] = render()
		data["truncated"] = true
		data["nextOffset"] = offset + len(entries)
	}
	return data, nil
}

func (s *Server) readFile(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, rel, err := s.access.File(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.Read(rel, args["startLine"].(int), args["maxLines"].(int))
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) readImage(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, rel, err := s.access.File(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.Image(rel)
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) findFiles(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.Find(args["pattern"].(string), args["depth"].(int), args["offset"].(int), args["limit"].(int))
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) searchWorkspace(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.Search(args["query"].(string), workspace.SearchOptions{
		Pattern:      args["pattern"].(string),
		Depth:        args["depth"].(int),
		Offset:       args["offset"].(int),
		Limit:        args["limit"].(int),
		ContextLines: args["contextLines"].(int),
	})
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) gitStatus(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.Status(args["offset"].(int), args["limit"].(int))
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) gitDiff(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	options := workspace.DiffOptions{
		Offset:      args["offset"].(int),
		Limit:       args["limit"].(int),
		PatchOffset: args["patchOffset"].(int),
	}
	if value, ok := args["patchFile"].(string); ok {
		options.PatchFile = &value
	}
	result, err := selected.Diff(args["mode"].(string), options)
	if err != nil {
		return nil, err
	}
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}

func (s *Server) gitLog(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.History().Log(workspace.LogOptions{
		Ref:    args["ref"].(string),
		Offset: args["offset"].(int),
		Limit:  args["limit"].(int),
	})
	if err != nil {
		return nil, err
	}
	return withFullPath(result, path)
}

func (s *Server) gitShow(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	options := workspace.ShowOptions{
		Ref:           args["ref"].(string),
		Parent:        args["parent"].(int),
		MessageOffset: args["messageOffset"].(int),
		Offset:        args["offset"].(int),
		Limit:         args["limit"].(int),
		PatchOffset:   args["patchOffset"].(int),
	}
	if value, ok := args["patchFile"].(string); ok {
		options.PatchFile = &value
	}
	result, err := selected.History().Show(options)
	if err != nil {
		return nil, err
	}
	return withFullPath(result, path)
}

func (s *Server) gitCompare(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	options := workspace.CompareOptions{
		Base:        args["base"].(string),
		Head:        args["head"].(string),
		Mode:        args["mode"].(string),
		Offset:      args["offset"].(int),
		Limit:       args["limit"].(int),
		PatchOffset: args["patchOffset"].(int),
	}
	if value, ok := args["patchFile"].(string); ok {
		options.PatchFile = &value
	}
	result, err := selected.History().Compare(options)
	if err != nil {
		return nil, err
	}
	return withFullPath(result, path)
}

func (s *Server) gitReadFile(args map[string]any) (map[string]any, error) {
	path := args["path"].(string)
	selected, err := s.access.Directory(path)
	if err != nil {
		return nil, err
	}
	result, err := selected.History().Read(workspace.ReadOptions{
		Ref:       args["ref"].(string),
		FilePath:  args["filePath"].(string),
		StartLine: args["startLine"].(int),
		MaxLines:  args["maxLines"].(int),
	})
	if err != nil {
		return nil, err
	}
	return withFullPath(result, path)
}

// jsonQuote matches JSON.stringify's non-HTML-escaping string form.
func jsonQuote(value string) string {
	var buffer strings.Builder
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func withFullPath(result map[string]any, path string) (map[string]any, error) {
	absolute, err := workspace.FullPath(path)
	if err != nil {
		return nil, err
	}
	result["path"] = absolute
	return result, nil
}
