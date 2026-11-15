package mcp

import (
	"regexp"
	"strings"

	"github.com/MarioJames/convorel/internal/workspace"
)

var commandKey = regexp.MustCompile(`^--[a-zA-Z][a-zA-Z0-9]*$`)

// commandTokens parses one bounded command. There is no shell, expansion,
// pipeline or subprocess lookup; quoting is honored so paths may contain spaces.
func commandTokens(command string) ([]string, error) {
	if strings.TrimSpace(command) == "" || len(command) > 8192 || strings.ContainsAny(command, "\r\n\x00`") {
		return nil, workspace.Fail("COMMAND_DENIED")
	}
	tokens := []string{}
	var current strings.Builder
	started := false
	flush := func() {
		if started {
			tokens = append(tokens, current.String())
			current.Reset()
			started = false
		}
	}
	runes := []rune(command)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch r {
		case ' ', '\t':
			flush()
		case '\'':
			started = true
			end := i + 1
			for end < len(runes) && runes[end] != '\'' {
				end++
			}
			if end >= len(runes) {
				return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
			}
			current.WriteString(string(runes[i+1 : end]))
			i = end
		case '"':
			started = true
			end := i + 1
			closed := false
			for end < len(runes) {
				ch := runes[end]
				if ch == '"' {
					closed = true
					break
				}
				if ch == '`' {
					return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
				}
				if ch == '$' {
					return nil, workspace.Fail("EXPANSION_DENIED")
				}
				if ch == '\\' {
					if end+1 >= len(runes) {
						return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
					}
					next := runes[end+1]
					if next == '"' || next == '\\' || next == '$' || next == '`' {
						current.WriteRune(next)
						end += 2
						continue
					}
					current.WriteRune('\\')
					end++
					continue
				}
				current.WriteRune(ch)
				end++
			}
			if !closed {
				return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
			}
			i = end
		case '\\':
			if i+1 >= len(runes) {
				return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
			}
			started = true
			i++
			current.WriteRune(runes[i])
		case '$':
			return nil, workspace.Fail("EXPANSION_DENIED")
		case '|', '&', ';', '<', '>', '(', ')':
			return nil, workspace.Fail("SHELL_SYNTAX_DENIED")
		default:
			started = true
			current.WriteRune(r)
		}
	}
	flush()
	return tokens, nil
}

// parseCommand splits one dispatched command into an operation name and its
// --option value pairs.
func parseCommand(command string) (string, map[string]string, error) {
	argv, err := commandTokens(command)
	if err != nil {
		return "", nil, err
	}
	if len(argv) == 0 {
		return "", nil, workspace.Fail("COMMAND_DENIED")
	}
	name := argv[0]
	argv = argv[1:]
	if name == "git" {
		sub := ""
		if len(argv) > 0 {
			sub = argv[0]
			argv = argv[1:]
		}
		name = "git_" + sub
	}
	args := map[string]string{}
	for i := 0; i < len(argv); i += 2 {
		key := argv[i]
		if !commandKey.MatchString(key) || i+1 >= len(argv) {
			return "", nil, workspace.Fail("COMMAND_ARGUMENTS_INVALID")
		}
		name := strings.TrimPrefix(key, "--")
		if _, exists := args[name]; exists {
			return "", nil, workspace.Fail("DUPLICATE_ARGUMENT")
		}
		args[name] = argv[i+1]
	}
	return name, args, nil
}
