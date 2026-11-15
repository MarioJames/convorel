package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
)

func equalJSON(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var x, y bytes.Buffer
	if json.Compact(&x, a) != nil || json.Compact(&y, b) != nil {
		return false
	}
	return bytes.Equal(x.Bytes(), y.Bytes())
}

func checkTransition(old, next Run) error {
	if !validPhase(next.State) {
		return ErrInvalidTransition
	}
	if old.ID != next.ID || old.RequestID != next.RequestID || old.InputHash != next.InputHash || old.Input != next.Input || old.Prompt != next.Prompt || old.PromptHash != next.PromptHash || old.Marker != next.Marker || old.CreatedAt != next.CreatedAt || !equalJSON(old.PromptContext, next.PromptContext) {
		return errors.New("RUN_IDENTITY_CHANGED")
	}
	if !old.State.Retryable() && next.State.Retryable() {
		return ErrRetryNotAllowed
	}
	allowed := old.State == next.State
	switch old.State {
	case Prepared, Rejected:
		switch next.State {
		case Prepared, Rejected, DeliveryUnknown, Delivered, Complete, Failed, Blocked:
			allowed = true
		}
	case DeliveryUnknown:
		switch next.State {
		case Delivered, Complete, Failed, Blocked, Superseded:
			allowed = true
		}
	case Delivered:
		switch next.State {
		case Complete, Failed, Blocked, Superseded:
			allowed = true
		}
	case Blocked:
		// A blocked page can recover only through observation, never a send.
		switch next.State {
		case DeliveryUnknown, Delivered, Complete, Failed, Superseded:
			allowed = true
		}
	}
	if !allowed {
		return ErrInvalidTransition
	}
	if old.UserMessageID != "" && old.UserMessageID != next.UserMessageID {
		return errors.New("DELIVERY_IDENTITY_CHANGED")
	}
	if old.Delivery.UserMessageID != "" && old.Delivery.UserMessageID != next.Delivery.UserMessageID {
		return errors.New("DELIVERY_IDENTITY_CHANGED")
	}
	if old.Delivery.ConversationID != "" && old.Delivery.ConversationID != next.Delivery.ConversationID {
		return errors.New("DELIVERY_IDENTITY_CHANGED")
	}
	if old.Delivery.RequestSent && !next.Delivery.RequestSent && !(old.State == Rejected && next.State == Prepared) {
		return errors.New("DELIVERY_FACTS_CHANGED")
	}
	user := next.UserMessageID
	if user == "" {
		user = next.Delivery.UserMessageID
	}
	if next.UserMessageID != "" && next.Delivery.UserMessageID != "" && next.UserMessageID != next.Delivery.UserMessageID {
		return errors.New("DELIVERY_IDENTITY_CHANGED")
	}
	switch next.State {
	case Prepared:
		if next.Delivery.RequestSent && next.SubmittedAt == "" || next.Delivery.POSTStatus != 0 || user != "" {
			return ErrInvalidTransition
		}
	case Rejected:
		if !next.Delivery.RequestSent || next.Delivery.POSTStatus < 300 && next.Delivery.POSTStatus >= 200 || next.Delivery.POSTStatus < 100 || next.Delivery.POSTStatus > 599 || user != "" {
			return ErrInvalidTransition
		}
	case DeliveryUnknown:
		if !next.Delivery.RequestSent {
			return ErrInvalidTransition
		}
	case Delivered:
		if !next.Delivery.RequestSent || user == "" {
			return ErrInvalidTransition
		}
	case Complete:
		if next.Reply == nil || next.Reply.ID == "" || next.Reply.Markdown == "" {
			return errors.New("RESULT_NOT_COMPLETE")
		}
	}
	return nil
}

func (s *SQLiteStore) Transition(ctx context.Context, id, runID string, expected Phase, next Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := readTask(ctx, tx, id)
	if err != nil {
		return err
	}
	for i, old := range t.Runs {
		if old.ID != runID {
			continue
		}
		if old.State != expected {
			return ErrTransitionConflict
		}
		if err = checkTransition(old, next); err != nil {
			return err
		}
		// A caller may construct a fresh Run; legacy evidence must still survive.
		next.original = old.original
		t.Runs[i] = next
		if err = writeTask(ctx, tx, t); err != nil {
			return err
		}
		return tx.Commit()
	}
	return ErrRunNotFound
}

// UpdateTask atomically edits browser/naming/cleanup metadata. Run publication
// goes through Transition/AppendRun so a stale metadata edit cannot erase runs.
// The callback must not call the store; it executes under the writer mutex.
func (s *SQLiteStore) UpdateTask(ctx context.Context, id string, update func(*Task) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.tasks.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := readTask(ctx, tx, id)
	if err != nil {
		return err
	}
	frozen := func(t Task) []byte {
		b, _ := json.Marshal(struct {
			Version                     int
			ID, WorkspaceID, CurrentRun string
			Config                      any
			Runs                        []Run
		}{t.Version, t.ID, t.WorkspaceID, t.CurrentRun, t.Config, t.Runs})
		return b
	}
	before := frozen(t)
	if err = update(&t); err != nil {
		return err
	}
	if !bytes.Equal(before, frozen(t)) {
		return errors.New("TASK_IDENTITY_CHANGED: use run operations for run changes")
	}
	if err = writeTask(ctx, tx, t); err != nil {
		return err
	}
	return tx.Commit()
}
