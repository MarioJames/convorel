package conversation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/store"
	"github.com/MarioJames/convorel/internal/workspace"
)

type observable interface {
	Snapshot(context.Context) (chatgpt.Snapshot, error)
}

func (e *Engine) run(s *taskState, id, rid string, send bool, signal func()) {
	t, r, err := e.read(id, rid)
	if err != nil {
		return
	}
	if send {
		w, er := workspace.NewWorkspace(t.Config.Workspace)
		if er != nil {
			e.failure(id, rid, "observe", er)
			return
		}
		if w.ID != t.WorkspaceID {
			e.failure(id, rid, "observe", errors.New("WORKSPACE_MISMATCH"))
			return
		}
	}
	page, err := e.open(s, t, r)
	if err != nil {
		e.failure(id, rid, "observe", err)
		return
	}
	t, r, err = e.read(id, rid)
	if err != nil {
		return
	}
	if r.State == store.Complete {
		signal()
		e.restoreDraft(id, rid, page)
		e.name(id, page)
		return
	}
	obs, ok := page.(observable)
	if !ok {
		e.failure(id, rid, "observe", errors.New("page does not support observation"))
		return
	}
	var events <-chan chatgpt.SubmissionEvent
	if send {
		// Reject damaged saved prompts before any browser mutation capable of sending.
		if !validPrompt(r) {
			e.failure(id, rid, "send", errors.New("PROMPT_CORRUPT"))
			return
		}
		// A successor may continue only the exact preceding completed turn.
		for i, prior := range t.Runs {
			if prior.ID == rid && i > 0 {
				previous := t.Runs[i-1]
				if previous.State != store.Complete || previous.Reply == nil {
					e.failure(id, rid, "observe", errors.New("PRIOR_RUN_NOT_COMPLETE"))
					return
				}
				if err = verifyAnchorFresh(e.ctx, page, previous); err != nil {
					e.failure(id, rid, "observe", err)
					return
				}
				if err = page.VerifyIdentity(e.ctx, identity(t, previous, true)); err != nil {
					e.failure(id, rid, "observe", err)
					return
				}
				reply, er := page.ReadReply(e.ctx, previous.Reply.ID)
				if er != nil {
					e.failure(id, rid, "observe", fmt.Errorf("PRIOR_REPLY_UNREADABLE: %w", er))
					return
				}
				if reply.Markdown != previous.Reply.Markdown {
					e.failure(id, rid, "observe", errors.New("COMPLETED_TURN_CHANGED"))
					return
				}
			}
		}
		effort := t.Config.Effort
		if effort == 0 {
			effort = 5
		}
		var pc PromptContext
		if json.Unmarshal(r.PromptContext, &pc) == nil && pc.Effort != 0 {
			effort = pc.Effort
		}
		if err = page.EnsureModel(e.ctx, t.Config.Model, effort); err != nil {
			e.failure(id, rid, "model", err)
			return
		}
		// An unsent draft is moved aside, never sent along or typed over.
		if err = e.displaceDraft(id, &r, page, obs); err != nil {
			e.failure(id, rid, "fill", err)
			return
		}
		if err = page.FillComposer(e.ctx, r.Prompt); err != nil {
			e.failure(id, rid, "fill", err)
			e.restoreDraft(id, rid, page)
			return
		}
		// Persist intent before dispatch. Restart treats an interrupted intent as
		// uncertain; a repeated request-id never implicitly sends it again.
		old := r
		if r.State == store.Rejected {
			r.State = store.Prepared
			r.Delivery = store.DeliveryFacts{}
		}
		r.SubmittedAt = now()
		r.Error = ""
		if err = e.persist(id, old, r); err != nil {
			return
		}
		sendCtx, cancel := context.WithCancel(e.ctx)
		defer cancel()
		events, err = page.Send(sendCtx)
		if err != nil {
			old = r
			r.Error = err.Error()
			if strings.Contains(err.Error(), "dispatch uncertain") {
				r.State = store.DeliveryUnknown
				r.Delivery.RequestSent = true
			} else {
				r.SubmittedAt = ""
			}
			if er := e.persist(id, old, r); er != nil {
				return
			}
			e.failure(id, rid, "send", err)
			if r.State != store.DeliveryUnknown {
				e.restoreDraft(id, rid, page)
				return
			}
			signal()
		}
	} else {
		signal()
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	candidate := r.UserMessageID
	for {
		select {
		case <-e.ctx.Done():
			return
		case ev, open := <-events:
			if !open {
				events = nil
				signal()
				continue
			}
			old := r
			r.LastObservedAt = now()
			if ev.Model != "" {
				r.ObservedModel = ev.Model
				r.Delivery.Model = ev.Model
			}
			if ev.ConversationID != "" && !strings.HasPrefix(ev.ConversationID, "local-") {
				r.Delivery.ConversationID = ev.ConversationID
			}
			switch ev.Kind {
			case chatgpt.IdentityObserved:
				if ev.UserMessageID != "" {
					candidate = ev.UserMessageID
					r.Delivery.RequestUserMessageID = ev.UserMessageID
				}
			case chatgpt.RequestSent:
				candidate = ev.UserMessageID
				r.Delivery.RequestUserMessageID = ev.UserMessageID
				r.Delivery.RequestSent = true
			case chatgpt.HTTPStatus:
				r.Delivery.RequestSent = true
				r.Delivery.POSTStatus = ev.Status
				if ev.Status >= 200 && ev.Status < 300 {
					r.State = store.DeliveryUnknown
				}
				if ev.Status < 200 || ev.Status >= 300 {
					r.State = store.Rejected
					r.Error = "HTTP_REJECTED"
					r.UserMessageID = ""
					r.Delivery.UserMessageID = ""
				}
			case chatgpt.InputMessage:
				candidate = ev.UserMessageID
				r.UserMessageID = ev.UserMessageID
				r.Delivery.UserMessageID = ev.UserMessageID
				if r.UserMessageID != "" && r.Delivery.POSTStatus >= 200 && r.Delivery.POSTStatus < 300 {
					r.State = store.Delivered
					r.Error = ""
				}
			case chatgpt.StreamAborted:
				if r.State == store.Prepared {
					r.State = store.DeliveryUnknown
					r.Delivery.RequestSent = true
				}
				r.Delivery.StreamAborted = true
				r.Error = ev.Error
			case chatgpt.StreamComplete:
				r.Delivery.StreamComplete = true
			}
			// HTTP and input events can arrive in either order in the CDP queue.
			if (r.State == store.DeliveryUnknown || r.State == store.Prepared) && r.UserMessageID != "" && r.Delivery.POSTStatus >= 200 && r.Delivery.POSTStatus < 300 {
				r.State = store.Delivered
				r.Error = ""
			}
			// Until the first response, the durable prepared+SubmittedAt intent
			// fences retries. Do not publish unknown before an HTTP rejection
			// has had a chance to prove that retry is safe.
			if err = e.persist(id, old, r); err != nil {
				return
			}
			if ev.ConversationID != "" {
				if err = e.bindURL(t, ev.ConversationID, obs); err != nil {
					e.failure(id, rid, "observe", err)
					signal()
					return
				}
			}
			if r.State == store.Rejected {
				e.publish(id)
				e.restoreDraft(id, rid, page)
				return
			}
			if r.State == store.Delivered || ev.Kind == chatgpt.StreamAborted {
				signal()
			}
			if ev.Kind == chatgpt.StreamComplete && ev.AssistantMessageID != "" {
				if e.complete(id, &r, page, ev.AssistantMessageID) {
					signal()
					e.restoreDraft(id, rid, page)
					e.name(id, page)
					return
				}
			}
		case <-ticker.C:
			snap, er := obs.Snapshot(e.ctx)
			if er != nil {
				continue
			}
			// The address keeps ChatGPT's provisional local- identity for a moment
			// after the stream has named the server conversation.
			if r.Delivery.ConversationID != "" && snap.ConversationID != "" && !strings.HasPrefix(snap.ConversationID, "local-") && snap.ConversationID != r.Delivery.ConversationID {
				e.failure(id, rid, "observe", errors.New("CONVERSATION_IDENTITY_CHANGED"))
				signal()
				return
			}
			// Unknown submissions may be recovered only by a unique saved run marker,
			// never by position or an unrelated assistant response.
			user := r.UserMessageID
			if user == "" {
				for _, m := range snap.Messages {
					if m.Role == "user" && strings.Count(m.Text, r.Marker) == 1 {
						if user != "" {
							user = ""
							break
						}
						user = m.ID
					}
				}
			}
			if user == "" {
				user = candidate
			}
			if user != "" && snap.ConversationID != "" {
				if err = e.bindURL(t, snap.ConversationID, obs); err != nil {
					e.failure(id, rid, "observe", err)
					signal()
					return
				}
			}
			// Save a uniquely correlated DOM input before waiting for the answer.
			// Prepared-dispatch APIs can omit the user ID from both POST and stream.
			// Restart must still retain the already observed input and canonical URL.
			markerMatches := 0
			for _, m := range snap.Messages {
				if m.Role == "user" && m.ID == user && strings.Count(m.Text, r.Marker) == 1 {
					markerMatches++
				}
			}
			if r.UserMessageID == "" && user != "" && markerMatches == 1 && snap.ConversationID != "" && !strings.HasPrefix(snap.ConversationID, "local-") {
				old := r
				r.UserMessageID = user
				r.Delivery.UserMessageID = user
				r.Delivery.RequestSent = true
				r.Delivery.ConversationID = snap.ConversationID
				if r.Delivery.POSTStatus >= 200 && r.Delivery.POSTStatus < 300 {
					r.State = store.Delivered
					r.Error = ""
				} else if r.State == store.Prepared {
					r.State = store.DeliveryUnknown
				}
				if err = e.persist(id, old, r); err != nil {
					return
				}
				if r.State == store.Delivered {
					signal()
				}
			}
			if snap.Generating {
				continue
			}
			seen := false
			assistant := ""
			ambiguous := false
			for _, m := range snap.Messages {
				if m.Role == "user" {
					if seen {
						ambiguous = true
					}
					seen = m.ID == user
				}
				if seen && m.Role == "assistant" && m.Final {
					if assistant != "" {
						ambiguous = true
					}
					assistant = m.ID
				}
			}
			if !ambiguous && assistant != "" && user != "" {
				old := r
				if r.UserMessageID == "" {
					r.UserMessageID = user
					r.Delivery.UserMessageID = user
					r.Delivery.RequestSent = true
					r.Delivery.ConversationID = snap.ConversationID
					if err = e.persist(id, old, r); err != nil {
						return
					}
				}
				if e.complete(id, &r, page, assistant) {
					signal()
					e.restoreDraft(id, rid, page)
					e.name(id, page)
					return
				}
			}
		}
	}
}
func validPrompt(r store.Run) bool {
	if r.Marker != "[CONVOREL:"+r.ID+"]" || digest(r.Prompt) != r.PromptHash || !strings.HasPrefix(r.Prompt, r.Marker+"\n\n") {
		return false
	}
	if len(r.PromptContext) == 0 && r.Input == "" {
		return true
	}
	var pc PromptContext
	return json.Unmarshal(r.PromptContext, &pc) == nil && pc.Version == 1 && digest(r.Input) == r.InputHash && RenderPrompt(r.Marker, r.Input, pc) == r.Prompt
}
func (e *Engine) bindURL(t store.Task, cid string, obs observable) error {
	// ChatGPT briefly exposes a provisional local-chatgpt: identity while
	// creating a conversation. Only the server identity may become durable.
	if strings.HasPrefix(cid, "local-") {
		return nil
	}
	snap, err := obs.Snapshot(e.ctx)
	if err != nil || snap.ConversationID != cid || conversationID(snap.URL) != cid {
		return nil
	}
	u, err := url.Parse(snap.URL)
	if err != nil {
		return err
	}
	if u.User != nil || !(u.Scheme == "https" && u.Host == "chatgpt.com" || u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return errors.New("PAGE_ORIGIN_CHANGED")
	}
	u.RawQuery = ""
	u.Fragment = ""
	e.mu.Lock()
	defer e.mu.Unlock()
	tasks, err := e.opts.Store.List(e.ctx)
	if err != nil {
		return err
	}
	for _, other := range tasks {
		if other.ID != t.ID && other.URL == u.String() {
			return errors.New("CONVERSATION_CONFLICT: another task owns this conversation")
		}
	}
	return e.opts.Store.UpdateTask(e.ctx, t.ID, func(task *store.Task) error {
		if task.URL != "" {
			old, err := url.Parse(task.URL)
			if err != nil || old.Scheme != u.Scheme || old.Host != u.Host || conversationID(task.URL) != cid {
				return errors.New("CONVERSATION_IDENTITY_CHANGED")
			}
		}
		task.URL = u.String()
		return nil
	})
}

// verifyAnchorFresh brings the newest turn into view when the tab does not
// render the anchor: ChatGPT keeps only turns near the viewport of a long
// conversation in the DOM, and a tab left scrolled up omits the latest one.
func verifyAnchorFresh(ctx context.Context, page chatgpt.Page, r store.Run) error {
	err := verifyAnchor(ctx, page, r)
	if err == nil || err.Error() != "SUBMITTED_MESSAGE_MISSING" {
		return err
	}
	latest, ok := page.(interface{ ShowLatest(context.Context) error })
	if !ok {
		return err
	}
	// Rendering follows the scroll asynchronously; re-scroll while it settles.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if er := latest.ShowLatest(ctx); er != nil {
			return fmt.Errorf("SUBMITTED_MESSAGE_MISSING: %w", er)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		err = verifyAnchor(ctx, page, r)
		if err == nil || err.Error() != "SUBMITTED_MESSAGE_MISSING" || time.Now().After(deadline) {
			return err
		}
	}
}
func verifyAnchor(ctx context.Context, page chatgpt.Page, r store.Run) error {
	obs, ok := page.(observable)
	if !ok {
		return errors.New("page cannot verify preceding turn")
	}
	snap, err := obs.Snapshot(ctx)
	if err != nil {
		return err
	}
	if snap.Generating || snap.Attachments {
		return errors.New("PAGE_NOT_IDLE")
	}
	found := false
	for _, m := range snap.Messages {
		if m.Role == "user" {
			if found {
				return errors.New("COMPLETED_TURN_CHANGED")
			}
			if m.ID == r.UserMessageID {
				found = true
			}
		}
	}
	if !found {
		return errors.New("SUBMITTED_MESSAGE_MISSING")
	}
	return nil
}

func (e *Engine) complete(id string, r *store.Run, page chatgpt.Page, assistant string) bool {
	reply, err := page.ReadReply(e.ctx, assistant)
	if err != nil {
		e.failure(id, r.ID, "observe", err)
		return false
	}
	old := *r
	next := old
	next.Reply = &store.Reply{ID: reply.ID, Role: "assistant", Markdown: reply.Markdown, Model: reply.Model, Final: true}
	next.ReplyHash = digest(reply.Markdown)
	next.State = store.Complete
	next.CompletedAt = now()
	next.Error = ""
	if err = e.persist(id, old, next); err != nil {
		return false
	}
	*r = next
	// Archive writes never gate the completion result or naming.
	e.publish(id)
	return true
}
func (e *Engine) name(id string, page chatgpt.Page) {
	ctx, cancel := context.WithTimeout(e.ctx, 45*time.Second)
	defer cancel()
	t, err := e.opts.Store.GetTask(e.ctx, id)
	if err != nil || t.Naming == nil || t.NamingState != nil && t.NamingState.Verified {
		return
	}
	var title string
	meta, ok := page.(interface {
		Metadata(context.Context) (chatgpt.ConversationMetadata, error)
		VerifyProject(context.Context, string) error
	})
	if !ok {
		err = errors.New("naming metadata unavailable")
	} else {
		var m chatgpt.ConversationMetadata
		m, err = meta.Metadata(ctx)
		if err == nil && m.ConversationID != conversationID(t.URL) {
			err = errors.New("CONVERSATION_IDENTITY_CHANGED")
		}
		if err == nil && t.Config.ProjectURL != "" {
			err = meta.VerifyProject(ctx, t.Config.ProjectURL)
		}
		if err == nil {
			language := t.Naming.Language
			if language == "" {
				language = "en"
			}
			title, err = chatgpt.ConversationTitle(m.CreatedAt, t.Naming.Type, t.Naming.Topic, "Asia/Shanghai", language)
		}
		if err == nil {
			err = page.Rename(ctx, title)
		}
	}
	if e.ctx.Err() != nil {
		return
	}
	_ = e.opts.Store.UpdateTask(e.ctx, id, func(t *store.Task) error {
		t.NamingState = &store.NamingState{State: "verified", Title: title, Verified: err == nil}
		if err != nil {
			t.NamingState.State = "failed"
			t.NamingState.Error = err.Error()
		}
		return nil
	})
	if err != nil {
		_ = e.opts.Store.RecordFailure(e.ctx, store.Failure{TaskID: id, RunID: t.CurrentRun, Event: "operation_result", Step: "naming", Error: err})
	}
}
