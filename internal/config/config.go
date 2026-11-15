// Package config preserves Convorel's version-one JSON files and explicit paths.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

type Paths struct {
	ConfigDir string `json:"configDir"`
	StateDir  string `json:"stateDir"`
}

func DefaultPaths() (Paths, error) {
	h, e := os.UserHomeDir()
	return Paths{filepath.Join(h, ".config/convorel"), filepath.Join(h, ".local/share/convorel")}, e
}

// ConsumeArgs resolves only global options preceding the command. No XDG or environment overrides.
func ConsumeArgs(args []string) (Paths, []string, error) {
	p, e := DefaultPaths()
	if e != nil {
		return p, nil, e
	}
	for len(args) > 0 && (args[0] == "--config-dir" || args[0] == "--state-dir") {
		if len(args) < 2 || args[1] == "" || strings.HasPrefix(args[1], "--") {
			return p, nil, fmt.Errorf("INVALID_ARGUMENT: missing %s PATH", args[0])
		}
		v, e := filepath.Abs(args[1])
		if e != nil {
			return p, nil, e
		}
		if args[0] == "--config-dir" {
			p.ConfigDir = v
		} else {
			p.StateDir = v
		}
		args = args[2:]
	}
	return p, args, nil
}
func (p Paths) Socket() string          { return filepath.Join(p.StateDir, "convorel.sock") }
func (p Paths) ConfigFile() string      { return filepath.Join(p.StateDir, "config.json") }
func (p Paths) PreferencesFile() string { return filepath.Join(p.ConfigDir, "preferences.json") }

type Browser struct {
	Mode        string `json:"mode,omitempty"`
	Executable  string `json:"executable"`
	UserDataDir string `json:"userDataDir"`
	CDP         string `json:"cdp,omitempty"`
}
type Config struct {
	Version     int      `json:"version"`
	Workspace   string   `json:"workspace"`
	CDP         string   `json:"cdp"`
	Browser     *Browser `json:"browser,omitempty"`
	Model       string   `json:"model,omitempty"`
	Effort      int      `json:"effort,omitempty"`
	ProjectURL  string   `json:"projectUrl,omitempty"`
	ProjectName string   `json:"projectName,omitempty"`
}

func Load(p Paths) (Config, error) {
	var c Config
	e := read(p.ConfigFile(), &c)
	if e == nil && c.Version != 1 {
		e = errors.New("CONFIG_VERSION_UNSUPPORTED")
	}
	return c, e
}
func Save(p Paths, c Config) error {
	if c.Version != 1 {
		return errors.New("CONFIG_VERSION_UNSUPPORTED")
	}
	return write(p.ConfigFile(), c)
}

type Preferences struct {
	Version int               `json:"version"`
	Values  map[string]string `json:"values"`
}

var preferenceMu sync.Mutex
var SettingKeys = []string{"tunnel.apiKey", "tunnel.id", "mcp.roots", "mcp.memoryRoots", "mcp.execDependencyRoots", "mcp.memoryExecutable", "model", "project.url", "project.name", "browser.executable", "browser.serial", "browser.headless", "browser.userDataDir", "browser.actionIntervalMs", "browser.navigationWaitMs", "locks.taskWaitMs", "release.baseUrl", "diagnostics.enabled", "effort", "browser.idleStopMinutes"}

func ReadPreferences(p Paths) (Preferences, error) {
	v := Preferences{Values: map[string]string{}}
	e := read(p.PreferencesFile(), &v)
	if errors.Is(e, os.ErrNotExist) {
		v.Version = 1
		return v, nil
	}
	if e != nil {
		return v, fmt.Errorf("PREFERENCES_READ_FAILED: %w", e)
	}
	if v.Version != 1 {
		return v, errors.New("PREFERENCES_VERSION_UNSUPPORTED")
	}
	if v.Values == nil {
		v.Values = map[string]string{}
	}
	return v, nil
}
func KnownKey(key string) bool {
	for _, k := range SettingKeys {
		if k == key {
			return true
		}
	}
	return false
}
func FullPath(v string) (string, error) {
	if v == "~" || strings.HasPrefix(v, "~/") {
		h, e := os.UserHomeDir()
		if e != nil {
			return "", e
		}
		v = h + strings.TrimPrefix(v, "~")
	}
	if strings.ContainsAny(v, "\\\x00\r\n") || !filepath.IsAbs(v) {
		return "", errors.New("ABSOLUTE_PATH_REQUIRED")
	}
	for _, s := range strings.Split(v, "/") {
		if s == ".." {
			return "", errors.New("ACCESS_DENIED")
		}
	}
	return filepath.Clean(v), nil
}
func Validate(key, value string) error {
	if !KnownKey(key) {
		return fmt.Errorf("UNKNOWN_SETTING: %s", key)
	}
	if strings.ContainsAny(value, "\r\n\x00") {
		return errors.New("INVALID_VALUE: newline or NUL")
	}
	if value == "" {
		return nil
	}
	switch key {
	case "browser.serial", "browser.headless", "diagnostics.enabled":
		if value != "true" && value != "false" {
			return errors.New("INVALID_VALUE: expected true or false")
		}
	case "effort", "browser.idleStopMinutes", "browser.actionIntervalMs", "browser.navigationWaitMs", "locks.taskWaitMs":
		n, e := strconv.Atoi(value)
		if e != nil || n < 1 || (key == "effort" && n > 5) || ((key == "browser.actionIntervalMs" || key == "browser.navigationWaitMs") && n > 10000) {
			return fmt.Errorf("INVALID_VALUE: %s out of range", key)
		}
	case "browser.executable", "browser.userDataDir", "mcp.memoryExecutable":
		_, e := FullPath(value)
		return e
	case "tunnel.id":
		if len(value) != 39 || !strings.HasPrefix(value, "tunnel_") {
			return errors.New("INVALID_TUNNEL_ID")
		}
		for _, c := range value[7:] {
			if !strings.ContainsRune("0123456789abcdef", c) {
				return errors.New("INVALID_TUNNEL_ID")
			}
		}
	case "release.baseUrl", "project.url":
		u, e := url.Parse(value)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("INVALID_VALUE: expected HTTP(S) URL")
		}
		if key == "project.url" && (u.Scheme != "https" || u.Host != "chatgpt.com" || !regexp.MustCompile(`(?i)^/g/g-p-[a-z0-9]+(?:-[^/]+)?/project$`).MatchString(u.Path)) {
			return errors.New("INVALID_PROJECT_URL")
		}
	case "mcp.roots", "mcp.execDependencyRoots":
		var roots []string
		if json.Unmarshal([]byte(value), &roots) != nil || len(roots) < 1 || len(roots) > 16 {
			return errors.New("INVALID_MCP_ROOTS")
		}
		for _, r := range roots {
			p, e := FullPath(r)
			if e != nil {
				return e
			}
			if key == "mcp.execDependencyRoots" && filepath.Base(p) != "node_modules" {
				return errors.New("EXEC_DEPENDENCY_ROOT_INVALID")
			}
			if _, e = os.Stat(p); e != nil {
				return errors.New("MCP_ROOT_MISSING")
			}
		}
	case "mcp.memoryRoots":
		var roots []string
		if json.Unmarshal([]byte(value), &roots) != nil || len(roots) < 1 || len(roots) > 16 {
			return errors.New("INVALID_MEMORY_ROOTS")
		}
		for _, r := range roots {
			if !strings.HasPrefix(r, "viking://") || strings.ContainsAny(r, "%?#\\\x00\r\n") {
				return errors.New("INVALID_MEMORY_ROOTS")
			}
			parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(r, "viking://"), "/"), "/")
			if len(parts) < 3 {
				return errors.New("INVALID_MEMORY_ROOTS")
			}
			for _, part := range parts {
				if part == "" || part == "." || part == ".." || part == "~" {
					return errors.New("INVALID_MEMORY_ROOTS")
				}
			}
		}
	}
	return nil
}
func WritePreference(p Paths, key, value string) (map[string]any, error) {
	if e := Validate(key, value); e != nil {
		return nil, e
	}
	if value != "" && (key == "browser.userDataDir" || key == "browser.executable" || key == "mcp.memoryExecutable") {
		value, _ = FullPath(value)
	}
	preferenceMu.Lock()
	defer preferenceMu.Unlock()
	v, e := ReadPreferences(p)
	if e != nil {
		return nil, e
	}
	if value == "" {
		delete(v.Values, key)
	} else {
		v.Values[key] = value
	}
	if e = write(p.PreferencesFile(), v); e != nil {
		return nil, e
	}
	return Display(key, value), nil
}
func Display(key, value string) map[string]any {
	source := "preferences"
	if value == "" {
		source = "unset"
	}
	if key == "tunnel.apiKey" && value != "" {
		value = "set"
	}
	return map[string]any{"key": key, "configured": value != "", "value": value, "source": source}
}
func (p Preferences) Effort() int {
	n, _ := strconv.Atoi(p.Values["effort"])
	if n < 1 || n > 5 {
		return 5
	}
	return n
}
func (p Preferences) IdleStopMinutes() int {
	n, _ := strconv.Atoi(p.Values["browser.idleStopMinutes"])
	if n < 1 {
		return 10
	}
	return n
}
func ResolveBrowserProfile(p Paths, c Config, v Preferences) (string, string, error) {
	if s := v.Values["browser.userDataDir"]; s != "" {
		s, e := FullPath(s)
		return s, "preference", e
	}
	if c.Browser != nil && c.Browser.UserDataDir != "" {
		return c.Browser.UserDataDir, "state", nil
	}
	return filepath.Join(p.StateDir, "chrome"), "default", nil
}
func Snapshot(c Config, p Preferences) (Config, error) {
	c.Model = p.Values["model"]
	c.Effort = p.Effort()
	c.ProjectURL = p.Values["project.url"]
	c.ProjectName = p.Values["project.name"]
	if (c.ProjectURL == "") != (c.ProjectName == "") {
		return c, errors.New("PROJECT_CONFIG_INCOMPLETE")
	}
	if c.ProjectURL != "" {
		if e := Validate("project.url", c.ProjectURL); e != nil {
			return c, e
		}
	}
	return c, nil
}
func read(path string, v any) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func write(path string, v any) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	if e := os.Chmod(filepath.Dir(path), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".config-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(append(b, '\n'))
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(f.Name(), path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
