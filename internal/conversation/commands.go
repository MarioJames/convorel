package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/MarioJames/convorel/internal/config"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/rpc"
	"github.com/MarioJames/convorel/internal/store"
)

// Execute implements the daemon command surface. All run work belongs to the
// engine context; the caller context bounds only intake and waiting.
func (e *Engine) Execute(ctx context.Context, command string, p map[string]string) (any, error) {
	switch command {
	case "ask", "followup":
		return e.Ask(ctx, p, command == "followup")
	case "retry":
		return e.Retry(ctx, p["id"], p["run"])
	case "wait":
		return e.Wait(ctx, p["id"], p["run"])
	case "status":
		return e.Status(ctx, p["id"], p["run"])
	case "result":
		t, r, err := e.read(p["id"], p["run"])
		if err != nil {
			return nil, err
		}
		if err = verifyResult(r); err != nil {
			return nil, err
		}
		return output(t, r), nil
	case "history":
		r, err := e.opts.Store.History(ctx, p["id"])
		return map[string]any{"id": p["id"], "runs": r}, err
	case "finish":
		return e.Finish(ctx, p["id"], p["run"])
	case "list":
		tasks, err := e.opts.Store.List(ctx)
		if err != nil {
			return nil, err
		}
		results := make([]map[string]any, 0)
		for _, t := range tasks {
			if p["workspace"] != "" && p["workspace"] != t.Config.Workspace {
				continue
			}
			r, er := selectRun(t, "")
			if er != nil {
				continue
			}
			v := output(t, r)
			v["workspace"] = t.Config.Workspace
			delete(v, "reply")
			results = append(results, v)
		}
		total := len(results)
		offset, limit := number(p["offset"], 0), number(p["limit"], 20)
		if limit > 100 {
			limit = 100
		}
		if offset > total {
			offset = total
		}
		end := offset + limit
		if end > total {
			end = total
		}
		return map[string]any{"tasks": results[offset:end], "total": total}, nil
	case "search":
		if e.opts.Archive == nil {
			return nil, rpc.NewError("ARCHIVE_UNAVAILABLE", "archive could not be opened")
		}
		v, err := e.opts.Archive.Search(ctx, archive.SearchInput{Query: p["query"], TaskID: p["id"], Role: p["role"], Limit: number(p["limit"], 20), Offset: number(p["offset"], 0)})
		if err != nil {
			return nil, err
		}
		b, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		if len(b) > rpc.MaxFrameBytes-4096 {
			return nil, rpc.NewError("RESULT_TOO_LARGE", "reduce --limit or narrow --query")
		}
		return v, nil
	case "diagnostics":
		v, total, err := e.opts.Store.Diagnostics(ctx, store.DiagnosticQuery{TaskID: p["id"], RunID: p["run"], Since: p["since"], Limit: number(p["limit"], 100)})
		return map[string]any{"events": v, "total": total}, err
	}
	return nil, rpc.NewError("UNKNOWN_COMMAND", command)
}
func number(s string, def int) int {
	v, err := strconv.Atoi(s)
	if err != nil || v < 0 {
		return def
	}
	return v
}
func (e *Engine) Finish(ctx context.Context, id, rid string) (map[string]any, error) {
	s := e.task(id)
	s.mu.Lock()
	defer s.mu.Unlock()
	t, r, err := e.read(id, rid)
	if err != nil {
		return nil, err
	}
	if s.active {
		return nil, rpc.NewError("RUN_IN_FLIGHT", "observation or naming still holds the tab")
	}
	if r.State == store.Delivered || r.State == store.DeliveryUnknown {
		return nil, rpc.NewError("RUN_IN_FLIGHT", "cannot release a tab awaiting a reply")
	}
	if t.Binding != nil && !t.Binding.Closed && t.Binding.Owned {
		end := e.begin()
		defer end()
		tab, attachErr := e.opts.Browser.AttachTab(ctx, t.Binding.Target)
		if attachErr != nil {
			if strings.Contains(attachErr.Error(), "TARGET_NOT_FOUND") {
				if err = e.markReleased(id, s); err != nil {
					return nil, err
				}
				v, err := e.Status(ctx, id, r.ID)
				if err == nil {
					v["cleanup"] = map[string]any{"state": "released", "alreadyGone": true}
				}
				return v, err
			}
			return nil, fmt.Errorf("RELEASE_FAILED: %w", attachErr)
		}
		page := e.opts.Factory(tab)
		if r.State != store.Complete {
			return nil, rpc.NewError("RESULT_NOT_COMPLETE", "finish requires a completed run")
		}
		if err = verifyResult(r); err != nil {
			return nil, err
		}
		if err = verifyAnchor(ctx, page, r); err != nil {
			return nil, err
		}
		if err = page.VerifyIdentity(ctx, identity(t, r, true)); err != nil {
			return nil, err
		}
		saved, er := page.ReadReply(ctx, r.Reply.ID)
		if er != nil {
			return nil, er
		}
		if saved.Markdown != r.Reply.Markdown {
			return nil, rpc.NewError("COMPLETED_TURN_CHANGED", "reply changed before release")
		}
		// Preserve user work added after the run completed.
		var dirty bool
		if err = tab.Evaluate(ctx, `(() => Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden").some(e=>(e.value||e.innerText||"").trim()))()`, &dirty); err != nil {
			return nil, err
		}
		if dirty {
			return nil, rpc.NewError("PAGE_NOT_IDLE", "draft must be preserved")
		}
		e.release.Lock()
		defer e.release.Unlock()
		if err = tab.Close(ctx); err != nil {
			return nil, err
		}
		s.tab = nil
		s.page = nil
		if manager, ok := e.opts.Browser.(interface {
			Targets(context.Context) ([]cdp.Target, error)
		}); ok {
			targets, er := manager.Targets(ctx)
			if er != nil {
				return nil, er
			}
			for _, target := range targets {
				if target.ID == tab.ID() {
					if err = closePersistedTarget(ctx, t.Config, tab.ID(), t.URL); err != nil {
						return nil, err
					}
				}
			}
		}
		if err = e.markReleased(id, s); err != nil {
			return nil, err
		}
	}
	v, err := e.Status(ctx, id, r.ID)
	if err != nil {
		return nil, err
	}
	v["cleanup"] = map[string]any{"state": "released"}
	return v, err
}

func verifyResult(r store.Run) error {
	if r.State != store.Complete {
		return nil
	}
	if r.Reply == nil || r.Reply.ID == "" || r.Reply.Markdown == "" {
		return rpc.NewError("RESULT_NOT_COMPLETE", "saved reply is missing")
	}
	content := r.Reply.Text
	if content == "" {
		content = r.Reply.Markdown
	}
	if r.ReplyHash != "" && r.ReplyHash != digest(content) {
		return rpc.NewError("RESULT_CORRUPT", "saved reply hash differs")
	}
	return nil
}

// After a daemon restart the transport correctly treats reattached targets as
// borrowed. The durable task binding is the ownership proof for explicit
// finish. A browser-level connection closes that exact owned target without
// opening another tab session or adopting any other target.
func closePersistedTarget(ctx context.Context, c config.Config, target, savedURL string) error {
	endpoint := c.CDP
	if c.Browser != nil && c.Browser.CDP != "" {
		endpoint = c.Browser.CDP
	}
	client, err := cdp.Dial(ctx, endpoint)
	if err != nil {
		return err
	}
	defer client.Close()
	targets, err := client.Targets(ctx)
	if err != nil {
		return err
	}
	found := false
	pages := 0
	for _, entry := range targets {
		if entry.Type == "page" {
			pages++
		}
		if entry.ID == target {
			current, er := url.Parse(entry.URL)
			saved, er2 := url.Parse(savedURL)
			if er != nil || er2 != nil || current.Scheme != saved.Scheme || current.Host != saved.Host || conversationID(entry.URL) != conversationID(savedURL) {
				return rpc.NewError("CONVERSATION_IDENTITY_CHANGED", "owned target changed before release")
			}
			found = true
		}
	}
	if !found {
		return nil
	}
	if pages <= 1 {
		if err = client.Call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, nil); err != nil {
			return err
		}
	}
	var response struct {
		Success bool `json:"success"`
	}
	if err = client.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": target}, &response); err != nil {
		return err
	}
	if !response.Success {
		return rpc.NewError("RELEASE_FAILED", "browser refused target close")
	}
	for attempt := 0; attempt < 40; attempt++ {
		targets, err = client.Targets(ctx)
		if err != nil {
			return err
		}
		found = false
		for _, entry := range targets {
			if entry.ID == target {
				found = true
			}
		}
		if !found {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return rpc.NewError("RELEASE_UNCONFIRMED", "target remained after close")
}

func (e *Engine) markReleased(id string, s *taskState) error {
	err := e.opts.Store.UpdateTask(e.ctx, id, func(t *store.Task) error {
		t.Binding.Closed = true
		t.Cleanup = json.RawMessage(`{"state":"released"}`)
		return nil
	})
	if err == nil {
		s.tab = nil
		s.page = nil
	}
	return err
}
