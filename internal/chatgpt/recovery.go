package chatgpt

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

// RecoverFirst observes at most five recent candidates on this owned tab. A
// timestamp only narrows the search: the exact saved marker is the authority.
// No backend request is manufactured and no message is ever sent here.
func (p *BrowserPage) RecoverFirst(ctx context.Context, start, marker string, dispatched time.Time, knownConversation, knownUser string) (Identity, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if marker == "" || dispatched.IsZero() {
		return Identity{}, errors.New("recovery: marker and dispatch time required")
	}
	if start == "" {
		start = "https://chatgpt.com/"
	}
	origin, err := url.Parse(start)
	if err != nil || !allowedOrigin(origin) {
		return Identity{}, errors.New("recovery: invalid origin")
	}
	reader, ok := p.tab.(responseReader)
	if !ok {
		return Identity{}, errors.New("recovery: response reader unavailable")
	}
	p.bound = Identity{}
	since := time.Now()
	if err = p.tab.Navigate(ctx, start); err != nil {
		return Identity{}, err
	}
	listPath := "/backend-api/conversations"
	if project, e := ProjectID(start); e == nil {
		listPath = "/backend-api/gizmos/" + project + "/conversations"
	}
	var candidates []string
	// Wait for the app's conversation list (or its rendered sidebar). Some app
	// rollouts do not issue the list request until the sidebar is expanded.
	for attempt := 0; attempt < 50 && len(candidates) == 0; attempt++ {
		for _, r := range reader.Responses() {
			u, e := url.Parse(r.URL)
			if e != nil || r.At.Before(since) || r.Method != "GET" || r.Status != 200 || u.Path != listPath {
				continue
			}
			body, e := reader.ResponseBody(ctx, r.RequestID)
			if e != nil {
				continue
			}
			var list struct {
				Items []struct {
					ID      string
					Created string `json:"create_time"`
				}
			}
			if json.Unmarshal(body, &list) != nil {
				continue
			}
			for _, item := range list.Items {
				created, e := time.Parse(time.RFC3339Nano, item.Created)
				if e == nil && !created.Before(dispatched) {
					candidates = append(candidates, item.ID)
				}
			}
		}
		if len(candidates) == 0 && attempt == 49 {
			var links []string
			_ = p.tab.Evaluate(ctx, `Array.from(document.querySelectorAll('nav a[href],aside a[href],[data-sidebar-item][href]')).filter(a=>a.getClientRects().length).map(a=>a.href)`, &links)
			for _, link := range links {
				u, e := url.Parse(link)
				if e == nil && u.Scheme == origin.Scheme && u.Host == origin.Host {
					if id := conversationID(link); id != "" && !strings.HasPrefix(id, "local-") {
						candidates = append(candidates, id)
					}
				}
			}
		}
		if len(candidates) == 0 {
			if e := pause(ctx, 100*time.Millisecond); e != nil {
				return Identity{}, e
			}
		}
	}
	seen := map[string]bool{}
	checked := 0
	for _, id := range candidates {
		if seen[id] {
			continue
		}
		seen[id] = true
		if checked >= 5 {
			break
		}
		checked++
		if knownConversation != "" && knownConversation != id {
			continue
		}
		target := origin.Scheme + "://" + origin.Host + "/c/" + url.PathEscape(id)
		p.bound = Identity{}
		navigated := time.Now()
		if err = p.tab.Navigate(ctx, target); err != nil {
			continue
		}
		p.bound = Identity{URL: target, ConversationID: id}
		metadataCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		m, e := p.readMetadata(metadataCtx, navigated, false)
		cancel()
		if e != nil || m.CreatedAt.Before(dispatched) {
			continue
		}
		var snap Snapshot
		for attempt := 0; attempt < 30; attempt++ {
			if p.eval(ctx, "snapshot", nil, &snap) == nil && len(snap.Messages) > 0 {
				break
			}
			if err := pause(ctx, 100*time.Millisecond); err != nil {
				return Identity{}, err
			}
		}
		if snap.ConversationID != id {
			continue
		}
		users := 0
		var user string
		for _, message := range snap.Messages {
			if message.Role == "user" {
				users++
				if strings.Count(message.Text, marker) == 1 {
					user = message.ID
				}
			}
		}
		if users != 1 || user == "" || knownUser != "" && user != knownUser {
			continue
		}
		identity := Identity{URL: target, ConversationID: id, UserMessageID: user}
		if p.verify(ctx, identity) != nil {
			continue
		}
		p.bound = identity
		p.userMessageID = user
		return identity, nil
	}
	return Identity{}, errors.New("delivery_unknown: no unique recent conversation with exact marker; observe only")
}
