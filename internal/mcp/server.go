package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/rpc"
	"github.com/MarioJames/convorel/internal/workspace"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Options configures one stdio MCP process.
type Options struct {
	Roots            []string
	MemoryRoots      []string
	MemoryExecutable string
	DependencyRoots  []string
	StateDir         string
	ConfigDir        string
	Version          string
}

// CallResult is the in-process result of one tool call. Code is a stable error
// code; Data is the structured payload when Code is empty.
type CallResult struct {
	Data     map[string]any
	Image    []byte
	MIMEType string
	Code     string
}

// Server owns the guarded workspace surface and its MCP registration.
type Server struct {
	access    *workspace.Access
	ops       []*operation
	memory    *Memory
	execution *Execution
	version   string
	sdk       *mcp.Server
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// New validates the allowed roots and builds the MCP server.
func New(options Options) (*Server, error) {
	access, err := workspace.NewAccess(options.Roots)
	if err != nil {
		return nil, err
	}
	for _, private := range []string{options.StateDir, options.ConfigDir} {
		if private == "" {
			continue
		}
		if err := access.AssertPrivate(private); err != nil {
			return nil, err
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if err := access.AssertPrivate(filepath.Join(home, ".local/share/convorel-tunnels")); err != nil {
			return nil, err
		}
	}
	version := options.Version
	if version == "" {
		version = rpc.Version
	}
	memoryRoots := make([]string, 0, len(options.MemoryRoots))
	for _, root := range options.MemoryRoots {
		canonical, err := workspace.MemoryURI(root)
		if err != nil {
			return nil, err
		}
		memoryRoots = append(memoryRoots, canonical)
	}
	server := &Server{
		access:  access,
		memory:  &Memory{Roots: memoryRoots, Executable: options.MemoryExecutable},
		version: version,
	}
	server.execution = &Execution{access: access, dependencyRoots: options.DependencyRoots, stateDir: options.StateDir}
	server.ops = server.operations()
	server.sdk = mcp.NewServer(&mcp.Implementation{Name: "convorel", Version: version}, nil)

	optionalPath := []param{{Name: "path", Type: "string"}}
	server.registerTool("capabilities",
		"Discover permitted roots, project identity, command syntax, memory sharing and artifact limits. Memory configured does not mean healthy. Call before reading evidence.",
		inputSchema(optionalPath), capabilitiesOutputSchema(),
		true, true, false,
		func(ctx context.Context, raw json.RawMessage) CallResult { return server.callCapabilities(raw) })
	execParams := []param{
		{Name: "command", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(8192), Required: true},
		{Name: "cwd", Type: "string"},
		intParam("timeoutSeconds", 1, 120, 30, false),
	}
	server.registerTool("exec",
		"Execute one permitted command string, including isolated Bun build/test scripts. Discover commands/options with capabilities. Example: git status --path '/repo'. Commands dispatch through the existing workspace policy; this is not an OS shell. Results preserve version/hash and pagination evidence.",
		inputSchema(execParams), execOutputSchema(),
		false, false, false,
		func(ctx context.Context, raw json.RawMessage) CallResult { return server.callExec(ctx, raw) })
	artifactParams := []param{
		{Name: "kind", Type: "string", Enum: []string{"text", "image"}, Required: true},
		{Name: "path", Type: "string", Required: true},
		{Name: "startLine", Type: "integer", Min: intPtr(1), Max: intPtr(10000000)},
		{Name: "maxLines", Type: "integer", Min: intPtr(1), Max: intPtr(1000)},
	}
	server.registerTool("artifact",
		"Read a permitted text report/log fragment or PNG/JPEG/WebP image. Uses the same file policy as exec, including ignored/credential paths. No uploads or arbitrary binary downloads. A hash is not proof of test execution or producing revision.",
		inputSchema(artifactParams), artifactOutputSchema(),
		true, true, false,
		func(ctx context.Context, raw json.RawMessage) CallResult { return server.callArtifact(raw) })
	memoryParams := []param{
		{Name: "action", Type: "string", Enum: []string{"search", "read"}, Required: true},
		{Name: "uri", Type: "string", MaxLen: intPtr(4096), Required: true},
		{Name: "query", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1000)},
		intParam("limit", 1, 20, 5, false),
	}
	server.registerTool("memory",
		"Search or read explicitly shared OpenViking URI subtrees through the locally configured ov CLI. No writes, deletes, configuration changes or unscoped search. Requires a canonical URI from capabilities.memory.roots. Memory is historical context, not proof of current implementation.",
		inputSchema(memoryParams), memoryOutputSchema(),
		true, true, true,
		func(ctx context.Context, raw json.RawMessage) CallResult { return server.callMemory(ctx, raw) })
	return server, nil
}

func (s *Server) registerTool(name, description string, input, output map[string]any, readOnly, idempotent, openWorld bool, call func(context.Context, json.RawMessage) CallResult) {
	destructive := false
	s.sdk.AddTool(&mcp.Tool{
		Name:         name,
		Description:  description,
		InputSchema:  input,
		OutputSchema: output,
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    readOnly,
			DestructiveHint: &destructive,
			IdempotentHint:  idempotent,
			OpenWorldHint:   &openWorld,
		},
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var raw json.RawMessage
		if req.Params != nil {
			raw = req.Params.Arguments
		}
		result := call(ctx, raw)
		if result.Code != "" {
			return &mcp.CallToolResult{
				IsError: true,
				Content: []mcp.Content{&mcp.TextContent{Text: result.Code}},
			}, nil
		}
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(result.Data); err != nil {
			return errorResult("TOOL_FAILED"), nil
		}
		encoded := bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
		if len(encoded) > workspace.MaxOut {
			return errorResult("RESPONSE_TOO_LARGE"), nil
		}
		content := []mcp.Content{&mcp.TextContent{Text: string(encoded)}}
		if len(result.Image) > 0 {
			content = append(content, &mcp.ImageContent{MIMEType: result.MIMEType, Data: result.Image})
		}
		return &mcp.CallToolResult{Content: content, StructuredContent: json.RawMessage(encoded)}, nil
	})
}

func errorResult(code string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: code}}}
}

// ToolNames lists the exact public function set (acceptance A12).
func (s *Server) ToolNames() []string {
	return []string{"capabilities", "exec", "artifact", "memory"}
}

// Run serves MCP over stdio until the client closes the pipe or ctx ends.
func (s *Server) Run(ctx context.Context) error {
	err := s.sdk.Run(ctx, &mcp.StdioTransport{})
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
}

// Call is the in-process entry point used by tests and doctor-style checks.
func (s *Server) Call(ctx context.Context, name string, arguments json.RawMessage) CallResult {
	switch name {
	case "capabilities":
		return s.callCapabilities(arguments)
	case "exec":
		return s.callExec(ctx, arguments)
	case "artifact":
		return s.callArtifact(arguments)
	case "memory":
		return s.callMemory(ctx, arguments)
	}
	// Internal operations stay available in-process for tests and doctor-style
	// checks, mirroring the 0.9 helper that dispatches through exec.
	if op, ok := s.operation(name); ok {
		args, err := parseObject(arguments, op.params)
		if err != nil {
			return CallResult{Code: errorCode(err)}
		}
		data, err := s.runOperation(name, args)
		if err != nil {
			return CallResult{Code: errorCode(err)}
		}
		return CallResult{Data: data}
	}
	return CallResult{Code: "TOOL_FAILED"}
}

func (s *Server) callCapabilities(raw json.RawMessage) CallResult {
	args, err := parseObject(raw, []param{{Name: "path", Type: "string"}})
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	data, err := s.capabilities(args)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	return CallResult{Data: data}
}

func (s *Server) capabilities(args map[string]any) (map[string]any, error) {
	info, err := s.workspaceInfo(args)
	if err != nil {
		return nil, err
	}
	info["mode"] = "guarded"
	commands := []map[string]any{}
	for _, name := range s.commandNames() {
		op, _ := s.operation(name)
		names := make([]string, 0, len(op.params))
		for _, p := range op.params {
			names = append(names, p.Name)
		}
		commands = append(commands, map[string]any{
			"name":        op.name,
			"description": op.description,
			"arguments":   names,
			"inputSchema": schemaJSON(op.params),
		})
	}
	dependencies := s.execution.dependencyRoots
	if dependencies == nil {
		dependencies = []string{}
	}
	info["execution"] = map[string]any{
		"mode":            "guarded-execution",
		"shell":           false,
		"buildsAndTests":  s.execution.Available(),
		"dependencyRoots": dependencies,
		"runtime":         "bun",
		"network":         false,
		"commands":        commands,
		"syntax":          "One command: NAME --option value. Quote values containing spaces or glob syntax. Options retain their schema names (e.g. startLine). git status/log/show/diff/compare/read_file are aliases for git_* commands. No pipes, redirects or substitutions. Build/test commands: bun test; bun run build/test/check/typecheck/dist (also colon-suffixed scripts). Supply cwd. Build/test execution is available on Linux with a Bubblewrap sandbox and explicit dependency grants; it is unavailable on macOS. Example: read_file --path '/repo/file.ts' --startLine 1 --maxLines 100. Use returned pagination fields to continue.",
	}
	actions := []string{}
	if len(s.memory.Roots) > 0 {
		actions = []string{"search", "read"}
	}
	roots := s.memory.Roots
	if roots == nil {
		roots = []string{}
	}
	info["memory"] = map[string]any{
		"configured": len(s.memory.Roots) > 0,
		"roots":      roots,
		"actions":    actions,
		"status":     "not-probed",
	}
	info["artifacts"] = map[string]any{
		"kinds":   []string{"text", "image"},
		"uploads": false,
	}
	return info, nil
}

func (s *Server) callExec(ctx context.Context, raw json.RawMessage) CallResult {
	params := []param{
		{Name: "command", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(8192), Required: true},
		{Name: "cwd", Type: "string"},
		intParam("timeoutSeconds", 1, 120, 30, false),
	}
	args, err := parseObject(raw, params)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	data, err := s.exec(ctx, args)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	return CallResult{Data: data}
}

func (s *Server) exec(ctx context.Context, args map[string]any) (map[string]any, error) {
	command := args["command"].(string)
	tokens, err := commandTokens(command)
	if err != nil {
		return nil, err
	}
	if len(tokens) == 0 {
		return nil, workspace.Fail("COMMAND_DENIED")
	}
	if tokens[0] == "bun" {
		cwd, _ := args["cwd"].(string)
		if cwd == "" {
			return nil, workspace.Fail("EXEC_CWD_REQUIRED")
		}
		result, err := s.execution.Run(ctx, command, tokens, cwd, args["timeoutSeconds"].(int))
		if err != nil {
			return nil, err
		}
		return map[string]any{"execution": map[string]any{"operation": "run", "result": result}}, nil
	}
	name, commandArgsMap, err := parseCommand(command)
	if err != nil {
		return nil, err
	}
	if cwd, ok := args["cwd"].(string); ok && cwd != "" {
		if existing, ok := commandArgsMap["path"]; ok && existing != "" && existing != cwd {
			return nil, workspace.Fail("EXEC_PATH_CONFLICT")
		}
		commandArgsMap["path"] = cwd
	}
	allowed := false
	for _, candidate := range s.commandNames() {
		if candidate == name {
			allowed = true
		}
	}
	if !allowed {
		return nil, workspace.Fail("COMMAND_DENIED")
	}
	op, _ := s.operation(name)
	values, err := commandArgs(op.params, commandArgsMap)
	if err != nil {
		return nil, err
	}
	result, err := s.runOperation(name, values)
	if err != nil {
		return nil, err
	}
	return map[string]any{"execution": map[string]any{"operation": name, "result": result}}, nil
}

func (s *Server) callArtifact(raw json.RawMessage) CallResult {
	params := []param{
		{Name: "kind", Type: "string", Enum: []string{"text", "image"}, Required: true},
		{Name: "path", Type: "string", Required: true},
		{Name: "startLine", Type: "integer", Min: intPtr(1), Max: intPtr(10000000)},
		{Name: "maxLines", Type: "integer", Min: intPtr(1), Max: intPtr(1000)},
	}
	args, err := parseObject(raw, params)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	kind := args["kind"].(string)
	_, hasStart := args["startLine"]
	_, hasMax := args["maxLines"]
	if kind == "image" && (hasStart || hasMax) {
		return CallResult{Code: "INVALID_ARGUMENTS"}
	}
	target := "read_file"
	if kind == "image" {
		target = "read_image"
	}
	op, _ := s.operation(target)
	values := map[string]any{}
	for key, value := range args {
		if key == "kind" {
			continue
		}
		values[key] = value
	}
	values = applyDefaults(op.params, values)
	data, err := s.runOperation(target, values)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	result := CallResult{Data: map[string]any{"artifact": map[string]any{"kind": kind, "result": data}}}
	if kind == "image" {
		encoded, _ := data["imageData"].(string)
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return CallResult{Code: "TOOL_FAILED"}
		}
		result.Image = decoded
		result.MIMEType, _ = data["mimeType"].(string)
		delete(data, "imageData")
	}
	return result
}

func applyDefaults(params []param, values map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range values {
		out[key] = value
	}
	for _, p := range params {
		if _, ok := out[p.Name]; !ok && p.Default != nil {
			out[p.Name] = p.Default
		}
	}
	return out
}

func (s *Server) callMemory(ctx context.Context, raw json.RawMessage) CallResult {
	params := []param{
		{Name: "action", Type: "string", Enum: []string{"search", "read"}, Required: true},
		{Name: "uri", Type: "string", MaxLen: intPtr(4096), Required: true},
		{Name: "query", Type: "string", MinLen: intPtr(1), MaxLen: intPtr(1000)},
		intParam("limit", 1, 20, 5, false),
	}
	args, err := parseObject(raw, params)
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	query, _ := args["query"].(string)
	data, err := s.memory.Call(ctx, args["action"].(string), args["uri"].(string), query, args["limit"].(int))
	if err != nil {
		return CallResult{Code: errorCode(err)}
	}
	return CallResult{Data: data}
}

// Serve resolves allowed roots and preferences, then runs the stdio session.
func Serve(ctx context.Context, paths config.Paths, rootsFlag string) error {
	preferences, err := config.ReadPreferences(paths)
	if err != nil {
		return err
	}
	rootsJSON := rootsFlag
	if rootsJSON == "" {
		rootsJSON = preferences.Values["mcp.roots"]
	}
	var roots []string
	if rootsJSON != "" {
		roots, err = workspace.ParseRoots(rootsJSON)
		if err != nil {
			return err
		}
	} else {
		// Without an explicit allowlist only the workspace saved by setup/init is
		// permitted, matching the documented single-root fallback.
		state, configErr := config.Load(paths)
		if configErr != nil {
			if errors.Is(configErr, fs.ErrNotExist) {
				return workspace.Fail("MCP_ROOTS_REQUIRED")
			}
			return configErr
		}
		if state.Workspace == "" {
			return workspace.Fail("MCP_ROOTS_REQUIRED")
		}
		roots = []string{state.Workspace}
	}
	memoryRoots, err := workspace.ParseMemoryRoots(preferences.Values["mcp.memoryRoots"])
	if err != nil {
		return err
	}
	dependencies := []string{}
	if raw := preferences.Values["mcp.execDependencyRoots"]; raw != "" {
		dependencies, err = workspace.ParseRoots(raw)
		if err != nil {
			return err
		}
		for i, path := range dependencies {
			absolute, err := config.FullPath(path)
			if err != nil {
				return err
			}
			dependencies[i] = absolute
		}
	}
	server, err := New(Options{
		Roots:            roots,
		MemoryRoots:      memoryRoots,
		MemoryExecutable: preferences.Values["mcp.memoryExecutable"],
		DependencyRoots:  dependencies,
		StateDir:         paths.StateDir,
		ConfigDir:        paths.ConfigDir,
		Version:          rpc.Version,
	})
	if err != nil {
		return err
	}
	return server.Run(ctx)
}
