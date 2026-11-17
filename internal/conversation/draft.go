package conversation

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/store"
)

// A draft that opens with a run marker is a prompt Convorel typed itself and
// never needs to come back; anything else belongs to the user.
var ownPrompt = regexp.MustCompile(`^\[CONVOREL:[0-9a-fA-F-]{36}\]`)

// displaceDraft empties a composer that already holds text. ChatGPT keeps
// unsent drafts in the browser profile and shows them again in every new tab,
// so one leftover would otherwise block every later run. A user's draft is
// saved on the run before it is removed; a leftover Convorel prompt is dropped.
func (e *Engine) displaceDraft(id string, r *store.Run, page chatgpt.Page, obs observable) error {
	draft, err := page.Draft(e.ctx)
	if err != nil || draft == "" {
		return err
	}
	if ownPrompt.MatchString(draft) {
		e.note(id, r.ID, "STALE_PROMPT_DISCARDED", draft[:len("[CONVOREL:")+37])
	} else {
		if r.Draft != nil && r.Draft.State != "restored" && r.Draft.Text != draft {
			return errors.New("DRAFT_BACKUP_PENDING: an earlier draft saved by this run is not back in the composer")
		}
		snap, er := obs.Snapshot(e.ctx)
		if er != nil {
			return er
		}
		old := *r
		r.Draft = &store.DraftBackup{Text: draft, URL: snap.URL, State: "saved", SavedAt: now()}
		if err = e.persist(id, old, *r); err != nil {
			return err
		}
		e.note(id, r.ID, "DRAFT_SAVED", snap.URL)
	}
	return page.ClearDraft(e.ctx, draft)
}

// restoreDraft returns a saved draft to the composer it was taken from, once
// the run no longer needs that composer. It never sends and never changes the
// run's phase; a failure keeps the text on the run for status to report.
func (e *Engine) restoreDraft(id, rid string, page chatgpt.Page) {
	t, r, err := e.read(id, rid)
	if err != nil || r.Draft == nil || r.Draft.State != "saved" {
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, 90*time.Second)
	defer cancel()
	state, err := e.putBack(ctx, t, r, page)
	if e.ctx.Err() != nil {
		return
	}
	next := r
	draft := *r.Draft
	draft.State = state
	if err != nil {
		draft.Error = err.Error()
	} else {
		draft.RestoredAt = now()
	}
	next.Draft = &draft
	if e.persist(id, r, next) != nil {
		return
	}
	if err != nil {
		_ = e.opts.Store.RecordFailure(e.ctx, store.Failure{TaskID: id, RunID: rid, Event: "operation_result", Step: "fill", Error: err})
		return
	}
	e.note(id, rid, "DRAFT_RESTORED", draft.URL)
}

func (e *Engine) putBack(ctx context.Context, t store.Task, r store.Run, page chatgpt.Page) (string, error) {
	here := ""
	if obs, ok := page.(observable); ok {
		if snap, err := obs.Snapshot(ctx); err == nil {
			here = snap.URL
		}
	}
	if here != "" && conversationID(here) == conversationID(r.Draft.URL) {
		state, err := swapIn(ctx, page, r)
		if err == nil {
			// Let the page store the draft before finish may close this tab.
			err = wait(ctx, 500*time.Millisecond)
		}
		return state, err
	}
	if conversationID(r.Draft.URL) != "" {
		return "failed", errors.New("DRAFT_RESTORE_FAILED: the draft's conversation is no longer open in the run's tab")
	}
	// A first send moved the run's tab into its new conversation, so the
	// new-conversation composer is reopened in a short-lived tab of its own.
	tab, err := e.opts.Browser.NewTab(ctx, "about:blank")
	if err != nil {
		return "failed", err
	}
	defer func() { _ = tab.Close(context.WithoutCancel(ctx)) }()
	spare := e.opts.Factory(tab)
	if err = spare.Open(ctx, e.startURL(t)); err != nil {
		return "failed", err
	}
	state, err := swapIn(ctx, spare, r)
	if err != nil {
		return state, err
	}
	// The tab is about to close: reload to prove the page stored the draft.
	if err = wait(ctx, 500*time.Millisecond); err != nil {
		return "failed", err
	}
	if err = spare.Open(ctx, e.startURL(t)); err != nil {
		return "failed", err
	}
	kept, err := spare.Draft(ctx)
	if err != nil {
		return "failed", err
	}
	if kept != r.Draft.Text {
		return "failed", errors.New("DRAFT_RESTORE_FAILED: the page did not keep the restored draft")
	}
	return "restored", nil
}

// swapIn writes the saved draft into page's composer. Only an empty composer,
// this run's own unsent prompt or another leftover Convorel prompt may be
// replaced; a different draft written meanwhile wins and is left alone.
func swapIn(ctx context.Context, page chatgpt.Page, r store.Run) (string, error) {
	current, err := page.Draft(ctx)
	if err != nil {
		return "failed", err
	}
	if current == r.Draft.Text {
		return "restored", nil
	}
	if current != "" {
		if current != r.Prompt && !ownPrompt.MatchString(current) {
			return "conflict", errors.New("DRAFT_CONFLICT: the composer holds a newer draft")
		}
		if err = page.ClearDraft(ctx, current); err != nil {
			return "failed", err
		}
	}
	if err = page.RestoreDraft(ctx, r.Draft.Text); err != nil {
		return "failed", err
	}
	return "restored", nil
}

func (e *Engine) note(id, rid, code, detail string) {
	_ = e.opts.Store.RecordFailure(e.ctx, store.Failure{TaskID: id, RunID: rid, Event: "operation_result", Step: "fill", Code: code, Error: errors.New(detail)})
}

func wait(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
