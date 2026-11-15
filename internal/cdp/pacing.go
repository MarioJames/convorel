package cdp

import (
	"context"
	"time"
)

// pacing serializes browser mutations in memory. Observations never wait for
// this lease. A context-aware channel also lets a queued action be cancelled
// before dispatch, without changing delivery certainty.
type pacing struct {
	lease                chan struct{}
	next                 time.Time
	interval, navigation time.Duration
}

func newPacing(interval, navigation time.Duration) *pacing {
	if interval == 0 {
		interval = 400 * time.Millisecond
	}
	if navigation == 0 {
		navigation = 1500 * time.Millisecond
	}
	return &pacing{lease: make(chan struct{}, 1), interval: interval, navigation: navigation}
}
func pause(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (p *pacing) run(ctx context.Context, navigation bool, fn func() error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case p.lease <- struct{}{}:
	}
	defer func() { <-p.lease }()
	if err := pause(ctx, time.Until(p.next)); err != nil {
		return err
	}
	interval := p.interval
	if navigation && p.navigation > interval {
		interval = p.navigation
	}
	p.next = time.Now().Add(interval)
	err := fn()
	p.next = time.Now().Add(interval)
	if navigation {
		settle := pause(ctx, p.navigation)
		if err == nil {
			return settle
		}
	}
	return err
}
