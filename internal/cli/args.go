// Package cli is the thin JSON command-line client.
package cli

import (
	"fmt"
	"github.com/MarioJames/convorel/internal/config"
	"strconv"
	"strings"
)

type Invocation struct {
	Paths   config.Paths
	Command string
	Params  map[string]string
	Help    bool
}
type CommandSpec struct {
	Name     string `json:"name"`
	Flags    string `json:"flags"`
	Required string `json:"required"`
	Result   string `json:"resultFields"`
}

// A trailing ? marks a boolean switch; all other flags require one value.
var Commands = []CommandSpec{
	{"ask", "id request-id workspace prompt prompt-file prompt-stdin? type topic language effort", "id", "id,run,phase,delivery,userMessageId,conversationId"},
	{"followup", "id request-id prompt prompt-file prompt-stdin? effort", "id request-id", "id,run,phase,delivery,userMessageId,conversationId"},
	{"wait", "id run timeout-seconds", "id", "id,run,phase,reply"},
	{"status", "id run", "id", "id,run,phase,delivery,naming,binding"},
	{"result", "id run", "id", "id,run,phase,reply"},
	{"history", "id", "id", "id,runs"},
	{"retry", "id run", "id", "id,run,phase,delivery,userMessageId"},
	{"finish", "id run", "id", "id,run,phase,cleanup,naming"},
	{"list", "workspace limit offset", "", "tasks,total"},
	{"search", "query id role limit offset", "query", "hits,total"},
	{"daemon", "", "", "stopped"},
	{"service install", "", "", "installed,unit"}, {"service uninstall", "", "", "installed,unit"}, {"service status", "", "", "installed,active,unit"},
	{"mcp serve", "roots", "", "MCP stdio protocol"},
	{"doctor", "ui? local?", "", "ok,checks,ui,tools"},
	{"setup", "workspace cdp chrome user-data-dir headless?", "", "configured,config,service"},
	{"login", "", "", "ready,profile,cdp"},
	{"config get", "", "", "key,source,configured,value"}, {"config set", "", "", "action,key,source,configured,value"}, {"config list", "", "", "file,settings"},
	{"skills install", "target", "", "installed,path"},
	{"upgrade", "version", "", "version,previousVersion"}, {"version", "", "", "version"},
	{"diagnostics", "id run limit since", "", "events,total"},
}

func Spec(name string) (CommandSpec, bool) {
	for _, s := range Commands {
		if s.Name == name {
			return s, true
		}
	}
	return CommandSpec{}, false
}
func Parse(args []string) (Invocation, error) {
	p, args, e := config.ConsumeArgs(args)
	v := Invocation{Paths: p, Params: map[string]string{}}
	if e != nil {
		return v, e
	}
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		v.Help = true
		return v, nil
	}
	v.Command = args[0]
	args = args[1:]
	switch v.Command {
	case "config", "service", "skills", "mcp":
		if len(args) == 0 {
			return v, fmt.Errorf("INVALID_ARGUMENT: missing %s subcommand", v.Command)
		}
		v.Command += " " + args[0]
		args = args[1:]
	}
	s, ok := Spec(v.Command)
	if !ok {
		return v, fmt.Errorf("UNKNOWN_COMMAND: %s", v.Command)
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		v.Help = true
		return v, nil
	}
	if strings.HasPrefix(v.Command, "config ") {
		n := 0
		if v.Command == "config get" {
			n = 1
		}
		if v.Command == "config set" {
			n = 2
		}
		if len(args) != n {
			return v, fmt.Errorf("INVALID_ARGUMENT: %s expects %d positional arguments", v.Command, n)
		}
		if n > 0 {
			if !config.KnownKey(args[0]) {
				return v, fmt.Errorf("UNKNOWN_SETTING: %s", args[0])
			}
			v.Params["key"] = args[0]
		}
		if n == 2 {
			v.Params["value"] = args[1]
		}
		return v, nil
	}
	allowed := map[string]bool{}
	for _, f := range strings.Fields(s.Flags) {
		allowed[strings.TrimSuffix(f, "?")] = strings.HasSuffix(f, "?")
	}
	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		if !strings.HasPrefix(arg, "--") {
			return v, fmt.Errorf("INVALID_ARGUMENT: unexpected %s", arg)
		}
		key, val, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		boolean, ok := allowed[key]
		if !ok {
			return v, fmt.Errorf("UNKNOWN_FLAG: --%s", key)
		}
		if _, ok = v.Params[key]; ok {
			return v, fmt.Errorf("INVALID_ARGUMENT: repeated --%s", key)
		}
		if boolean {
			if !inline {
				val = "true"
			}
			if val != "true" && val != "false" {
				return v, fmt.Errorf("INVALID_ARGUMENT: --%s expects boolean", key)
			}
		} else if !inline {
			if len(args) == 0 || strings.HasPrefix(args[0], "--") {
				return v, fmt.Errorf("INVALID_ARGUMENT: missing --%s value", key)
			}
			val = args[0]
			args = args[1:]
		}
		v.Params[key] = val
	}
	for _, key := range strings.Fields(s.Required) {
		if v.Params[key] == "" {
			return v, fmt.Errorf("INVALID_ARGUMENT: missing --%s", key)
		}
	}
	for _, key := range []string{"effort", "limit", "offset", "timeout-seconds"} {
		if val, ok := v.Params[key]; ok {
			n, e := strconv.Atoi(val)
			if e != nil || n < 0 || (key != "offset" && n == 0) || (key == "effort" && n > 5) {
				return v, fmt.Errorf("INVALID_ARGUMENT: --%s out of range", key)
			}
		}
	}

	if v.Params["ui"] == "true" && v.Params["local"] == "true" {
		return v, fmt.Errorf("INVALID_ARGUMENT: --ui and --local cannot be combined")
	}
	if lang := v.Params["language"]; lang != "" && lang != "en" && lang != "zh" {
		return v, fmt.Errorf("INVALID_ARGUMENT: --language expects en or zh")
	}
	if role := v.Params["role"]; role != "" && role != "user" && role != "assistant" {
		return v, fmt.Errorf("INVALID_ARGUMENT: --role expects user or assistant")
	}
	if v.Params["language"] != "" && v.Params["type"] == "" {
		return v, fmt.Errorf("INVALID_ARGUMENT: --language requires --type and --topic")
	}
	if v.Command == "ask" || v.Command == "followup" {
		n := 0
		for _, key := range []string{"prompt", "prompt-file", "prompt-stdin"} {
			if val, ok := v.Params[key]; ok && !(key == "prompt-stdin" && val == "false") {
				n++
			}
		}
		if n != 1 {
			return v, fmt.Errorf("INVALID_ARGUMENT: choose exactly one prompt source")
		}
		if v.Command == "ask" && v.Params["request-id"] == "" {
			v.Params["request-id"] = "initial"
		}
		if (v.Params["type"] == "") != (v.Params["topic"] == "") {
			return v, fmt.Errorf("INVALID_ARGUMENT: --type and --topic must be paired")
		}
	}
	return v, nil
}
func Help(name string) map[string]any {
	specs := Commands
	if s, ok := Spec(name); ok {
		specs = []CommandSpec{s}
	}
	return map[string]any{"usage": "convorel [--config-dir PATH] [--state-dir PATH] COMMAND [OPTIONS]", "commands": specs, "version": "1.0.1"}
}
