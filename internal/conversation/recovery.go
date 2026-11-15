package conversation

import (
	"context"
	"errors"
	"time"

	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/store"
)

func (e *Engine) recoverFirst(s *taskState, t store.Task, r store.Run) (chatgpt.Page, error) {
	ctx, cancel := context.WithTimeout(e.ctx, 40*time.Second)
	defer cancel()
	dispatched, err := time.Parse(time.RFC3339Nano, r.SubmittedAt)
	if err != nil || len(t.Runs) != 1 {
		return nil, errors.New("delivery_unknown: first-send recovery requires dispatch time")
	}
	tab, err := e.opts.Browser.NewTab(ctx, "about:blank")
	if err != nil {
		return nil, err
	}
	adopted := false
	defer func() {
		if !adopted {
			_ = tab.Close(e.ctx)
		}
	}()
	page := e.opts.Factory(tab)
	recovery, ok := page.(interface {
		RecoverFirst(context.Context, string, string, time.Time, string, string) (chatgpt.Identity, error)
	})
	if !ok {
		return nil, errors.New("delivery_unknown: page cannot recover first send")
	}
	knownUser := r.UserMessageID

	found, err := recovery.RecoverFirst(ctx, e.startURL(t), r.Marker, dispatched, r.Delivery.ConversationID, knownUser)
	if err != nil {
		return nil, err
	}
	obs, ok := page.(observable)
	if !ok {
		return nil, errors.New("recovery: snapshot unavailable")
	}
	if err = e.bindURL(t, found.ConversationID, obs); err != nil {
		return nil, err
	}
	old := r
	r.UserMessageID = found.UserMessageID
	r.Delivery.UserMessageID = found.UserMessageID
	r.Delivery.ConversationID = found.ConversationID
	r.Delivery.RequestSent = true
	if r.Delivery.POSTStatus >= 200 && r.Delivery.POSTStatus < 300 {
		r.State = store.Delivered
		r.Error = ""
	}
	if err = e.persist(t.ID, old, r); err != nil {
		return nil, err
	}
	if err = e.opts.Store.UpdateTask(e.ctx, t.ID, func(task *store.Task) error {
		task.Binding = &store.Binding{Target: tab.ID(), Owned: true, Epoch: tab.ID()}
		return nil
	}); err != nil {
		return nil, err
	}
	s.tab = tab
	s.page = page
	adopted = true
	return page, nil
}
