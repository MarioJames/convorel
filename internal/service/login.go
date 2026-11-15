package service

import (
	"context"
	"errors"
	"time"

	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/config"
)

// Login uses the daemon's shared browser; it never starts a competing lifecycle manager.
// Sign-in remains interactive. Only the authenticated session boolean leaves the page.
func Login(ctx context.Context, p config.Paths, browser cdp.Browser) (any, error) {
	if browser == nil {
		return nil, errors.New("BROWSER_UNAVAILABLE")
	}
	c, e := config.Load(p)
	if e != nil {
		return nil, e
	}
	if c.Browser == nil {
		return nil, errors.New("BROWSER_NOT_MANAGED: start the configured external browser yourself")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if e = browser.EnsureStarted(ctx); e != nil {
		return nil, e
	}
	tab, e := browser.NewTab(ctx, "https://chatgpt.com/")
	if e != nil {
		return nil, e
	}
	// Leave the login page open on timeout so the person can complete sign-in and retry.
	probe := `(async () => { if (location.origin !== 'https://chatgpt.com') return false; const r = await fetch('/api/auth/session', {credentials:'include'}); if (!r.ok) return false; const s = await r.json().catch(() => null); return !!(s && s.user); })()`
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		var ready bool
		if e = tab.Evaluate(ctx, probe, &ready); e == nil && ready {
			pref, e := config.ReadPreferences(p)
			if e != nil {
				return nil, e
			}
			profile, _, e := config.ResolveBrowserProfile(p, c, pref)
			if e != nil {
				return nil, e
			}
			_ = tab.Close(ctx)
			return map[string]any{"ready": true, "login": "ready", "profile": profile, "cdp": c.CDP}, nil
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("CHATGPT_LOGIN_TIMEOUT: finish sign-in in Chrome and run convorel login again")
		case <-ticker.C:
		}
	}
}
