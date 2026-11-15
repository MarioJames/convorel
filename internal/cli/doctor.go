package cli

import (
	"errors"
	"os"

	"github.com/MarioJames/convorel/internal/config"
)

// DoctorLocal checks the selected file shapes without contacting a daemon or browser.
// An unconfigured installation is healthy locally and explicitly reports that state.
func DoctorLocal(p config.Paths) (map[string]any, error) {
	prefs, err := config.ReadPreferences(p)
	if err != nil {
		return nil, err
	}
	c, err := config.Load(p)
	configured := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	profile, source, err := config.ResolveBrowserProfile(p, c, prefs)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "checks": map[string]any{"preferences": true, "configured": configured}, "profile": profile, "profileSource": source, "tools": []string{"capabilities", "exec", "artifact", "memory"}}, nil
}
