// Package service manages installation and the daemon's tunnel child.
package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/MarioJames/convorel/internal/config"
)

// Manager only changes units in UnitDir. A caller must explicitly choose that directory.
type Manager struct {
	UnitDir, Executable string
	Paths               config.Paths
}

func unitQuote(s string) (string, error) {
	if strings.ContainsAny(s, "\x00\r\n") {
		return "", errors.New("UNIT_ARGUMENT_INVALID")
	}
	s = strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "$$").Replace(s)
	return "\"" + s + "\"", nil
}
func (m Manager) Unit() (string, error) {
	if !filepath.IsAbs(m.Executable) || !filepath.IsAbs(m.Paths.ConfigDir) || !filepath.IsAbs(m.Paths.StateDir) {
		return "", errors.New("ABSOLUTE_PATH_REQUIRED")
	}
	args := []string{m.Executable, "--config-dir", m.Paths.ConfigDir, "--state-dir", m.Paths.StateDir, "daemon"}
	for i, a := range args {
		q, e := unitQuote(a)
		if e != nil {
			return "", e
		}
		args[i] = q
	}
	// systemd owns the entire cgroup, including tunnel-client and its MCP process.
	return "[Unit]\nDescription=Convorel daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=" + strings.Join(args, " ") + "\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=20\nUMask=0077\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n\n[Install]\nWantedBy=default.target\n", nil
}
func systemctl(ctx context.Context, args ...string) (string, error) {
	out, e := exec.CommandContext(ctx, "systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
	if e != nil {
		return string(out), fmt.Errorf("SYSTEMCTL_FAILED: %s: %w", strings.TrimSpace(string(out)), e)
	}
	return strings.TrimSpace(string(out)), nil
}
func (m Manager) unitPath() (string, error) {
	if !filepath.IsAbs(m.UnitDir) || filepath.Clean(m.UnitDir) == "/" {
		return "", errors.New("UNIT_DIRECTORY_INVALID")
	}
	return filepath.Join(m.UnitDir, "convorel.service"), nil
}
func (m Manager) Install(ctx context.Context) (any, error) {
	path, e := m.unitPath()
	if e != nil {
		return nil, e
	}
	unit, e := m.Unit()
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(m.UnitDir, 0700); e != nil {
		return nil, e
	}
	old := filepath.Join(m.UnitDir, "convorel-tunnel.service")
	if _, e = os.Lstat(old); e == nil {
		if _, e = systemctl(ctx, "disable", "--now", filepath.Base(old)); e != nil {
			return nil, e
		}
		if e = os.Remove(old); e != nil {
			return nil, e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	// Legacy recovery hooks refer to commands removed in 1.0.
	if e = os.RemoveAll(old + ".d"); e != nil {
		return nil, e
	}
	if e = atomicWrite(path, []byte(unit), 0600); e != nil {
		return nil, e
	}
	if _, e = systemctl(ctx, "daemon-reload"); e != nil {
		return nil, e
	}
	if _, e = systemctl(ctx, "enable", "--now", path); e != nil {
		return nil, e
	}
	return map[string]any{"installed": true, "unit": path}, nil
}
func (m Manager) Uninstall(ctx context.Context) (any, error) {
	path, e := m.unitPath()
	if e != nil {
		return nil, e
	}
	if _, e = os.Lstat(path); errors.Is(e, os.ErrNotExist) {
		return map[string]any{"installed": false, "unit": path}, nil
	} else if e != nil {
		return nil, e
	}
	if _, e = systemctl(ctx, "disable", "--now", filepath.Base(path)); e != nil {
		return nil, e
	}
	if e = os.Remove(path); e != nil {
		return nil, e
	}
	_, e = systemctl(ctx, "daemon-reload")
	return map[string]any{"installed": false, "unit": path}, e
}
func (m Manager) Status(ctx context.Context) (any, error) {
	path, e := m.unitPath()
	if e != nil {
		return nil, e
	}
	_, e = os.Lstat(path)
	installed := e == nil
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	active := "inactive"
	if installed {
		out, err := exec.CommandContext(ctx, "systemctl", "--user", "is-active", filepath.Base(path)).CombinedOutput()
		active = strings.TrimSpace(string(out))
		if err != nil {
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				return nil, err
			}
		}
	}
	return map[string]any{"installed": installed, "active": active == "active", "status": active, "unit": path}, nil
}
func atomicWrite(path string, b []byte, mode os.FileMode) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".convorel-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
