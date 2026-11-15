package cdp

import (
	"context"
	"encoding/base64"
	"time"
)

// NetworkResponse describes a page-owned HTTP response, without request headers
// or credentials. The bounded log is independent of the send stream consumer.
type NetworkResponse struct {
	RequestID, URL, Method string
	Status                 int
	At                     time.Time
}

func (t *PageTab) Responses() []NetworkResponse {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]NetworkResponse(nil), t.responses...)
}
func (t *PageTab) ResponseBody(ctx context.Context, id string) ([]byte, error) {
	var r struct {
		Body          string
		Base64Encoded bool
	}
	if err := t.call(ctx, "Network.getResponseBody", map[string]any{"requestId": id}, &r); err != nil {
		return nil, err
	}
	if r.Base64Encoded {
		return base64.StdEncoding.DecodeString(r.Body)
	}
	return []byte(r.Body), nil
}

// Reload bypasses document cache, preserving the owned tab and its URL. Unlike
// same-URL Page.navigate, this forces the application's metadata hydration.
func (t *PageTab) Reload(ctx context.Context) error {
	return t.manager.pacing.run(ctx, true, func() error {
		if err := t.call(ctx, "Network.enable", map[string]any{"maxPostDataSize": 16 << 20}, nil); err != nil {
			return err
		}
		if err := t.call(ctx, "Page.enable", nil, nil); err != nil {
			return err
		}
		events, cancel := t.client.Subscribe(t.session)
		defer cancel()
		if err := t.call(ctx, "Page.reload", map[string]any{"ignoreCache": true}, nil); err != nil {
			return err
		}
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.ctx.Done():
				return context.Canceled
			case e, ok := <-events:
				if !ok {
					return context.Canceled
				}
				if e.Method == "Page.loadEventFired" {
					return nil
				}
			}
		}
	})
}
