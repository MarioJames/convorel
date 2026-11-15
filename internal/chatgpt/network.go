package chatgpt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/MarioJames/convorel/internal/cdp"
)

// SSEDecoder accepts arbitrary CDP chunk boundaries (including split UTF-8 and
// CRLF). Event names and data are distinct: ChatGPT uses JSON type envelopes.
type SSEDecoder struct{ buffer string }
type SSE struct{ Event, Data string }

func (d *SSEDecoder) Feed(chunk []byte) []SSE {
	d.buffer += string(chunk)
	var result []SSE
	for {
		end := strings.Index(d.buffer, "\n\n")
		skip := 2
		if j := strings.Index(d.buffer, "\r\n\r\n"); j >= 0 && (end < 0 || j < end) {
			end = j
			skip = 4
		}
		if end < 0 {
			break
		}
		frame := d.buffer[:end]
		d.buffer = d.buffer[end+skip:]
		var event SSE
		var data []string
		for _, line := range strings.Split(frame, "\n") {
			line = strings.TrimSuffix(line, "\r")
			if strings.HasPrefix(line, "event:") {
				event.Event = strings.TrimPrefix(strings.TrimPrefix(line, "event:"), " ")
			}
			if strings.HasPrefix(line, "data:") {
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if len(data) > 0 {
			event.Data = strings.Join(data, "\n")
			result = append(result, event)
		}
	}
	return result
}

type networkState struct {
	id                                  string
	facts                               SubmissionEvent
	decoder                             SSEDecoder
	confirmed, complete, done, rejected bool
}

// A DOM fallback may finish only this round's unambiguous response. An assistant
// before a later user turn is historical evidence, not the current result.
func finalResponse(s Snapshot, user string) (string, error) {
	seen := false
	var replies []string
	for _, m := range s.Messages {
		if m.Role == "user" {
			if seen {
				return "", errors.New("DOM_IDENTITY_CHANGED: later user turn appeared")
			}
			seen = m.ID == user
		}
		if seen && m.Role == "assistant" && m.Final {
			replies = append(replies, m.ID)
		}
	}
	if len(replies) > 1 {
		return "", errors.New("reply: expected one visible final assistant, got multiple")
	}
	if len(replies) == 1 && !s.Generating {
		return replies[0], nil
	}
	return "", nil
}

func stringField(m map[string]any, key string) string { s, _ := m[key].(string); return s }
func (s *networkState) request(e cdp.NetworkEvent) (SubmissionEvent, bool) {
	var p struct {
		ID      string `json:"requestId"`
		Request struct {
			URL, Method string
			PostData    string `json:"postData"`
		}
	}
	if json.Unmarshal(e.Params, &p) != nil || p.Request.Method != "POST" || !cdp.MatchURLPath(p.Request.URL, "/backend-api/f/conversation") {
		return SubmissionEvent{}, false
	}
	var body struct {
		ConversationID string `json:"conversation_id"`
		Parent         string `json:"parent_message_id"`
		Model          string `json:"model"`
		Messages       []struct {
			ID     string
			Author struct{ Role string }
		}
	}
	if json.Unmarshal([]byte(p.Request.PostData), &body) != nil {
		return SubmissionEvent{}, false
	}
	s.id = e.RequestID
	if s.id == "" {
		s.id = p.ID
	}
	s.facts = SubmissionEvent{Kind: RequestSent, RequestID: s.id, ConversationID: body.ConversationID, ParentMessageID: body.Parent, Model: body.Model}
	for _, m := range body.Messages {
		if m.Author.Role == "user" {
			s.facts.UserMessageID = m.ID
		}
	}
	return s.facts, true
}
func (s *networkState) stream(data []byte) []SubmissionEvent {
	var out []SubmissionEvent
	for _, frame := range s.decoder.Feed(data) {
		before := s.facts
		outStart := len(out)
		if strings.TrimSpace(frame.Data) == "[DONE]" {
			s.done = true
			e := s.facts
			e.Kind = StreamDone
			out = append(out, e)
			continue
		}
		var value any
		if json.Unmarshal([]byte(frame.Data), &value) != nil {
			continue
		}
		var walk func(any)
		walk = func(v any) {
			switch n := v.(type) {
			case []any:
				for _, x := range n {
					walk(x)
				}
			case map[string]any:
				if cid := stringField(n, "conversation_id"); cid != "" {
					s.facts.ConversationID = cid
				}
				typ := stringField(n, "type")
				if typ == "" {
					typ = frame.Event
				}
				if model := stringField(n, "model_slug"); model != "" && s.facts.Model == "" {
					s.facts.Model = model
				}
				if msg, ok := n["message"].(map[string]any); ok {
					if author, ok := msg["author"].(map[string]any); ok {
						switch stringField(author, "role") {
						case "assistant":
							if id := stringField(msg, "id"); id != "" {
								s.facts.AssistantMessageID = id
							}
						case "user":
							if id := stringField(msg, "id"); id != "" {
								s.facts.UserMessageID = id
							}
						}
					}
				}
				switch typ {
				case "input_message":
					if !s.confirmed {
						s.confirmed = true
						e := s.facts
						e.Kind = InputMessage
						out = append(out, e)
					}
				case "message_stream_complete":
					if !s.complete {
						if id := stringField(n, "message_id"); id != "" {
							s.facts.AssistantMessageID = id
						}
						s.complete = true
						e := s.facts
						e.Kind = StreamComplete
						out = append(out, e)
					}
				}
				// Delta envelopes wrap real events under v; message objects carry identity.
				for _, key := range []string{"v", "data", "message"} {
					if x, ok := n[key]; ok {
						walk(x)
					}
				}
			}
		}
		walk(value)
		if len(out) == outStart && (s.facts.ConversationID != before.ConversationID || s.facts.UserMessageID != before.UserMessageID) {
			e := s.facts
			e.Kind = IdentityObserved
			out = append(out, e)
		}
	}
	return out
}
func (p *BrowserPage) Send(ctx context.Context) (<-chan SubmissionEvent, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.observing {
		return nil, errors.New("submission observation still in flight")
	}
	if !p.modelVerified {
		return nil, errors.New("MODEL_UNVERIFIED: call EnsureModel before send")
	}
	var draft string
	if e := p.eval(ctx, "draft", nil, &draft); e != nil {
		return nil, e
	}
	if p.prompt == "" || draft != p.prompt {
		return nil, errors.New("composer: draft changed before send")
	}
	var state Snapshot
	if e := p.eval(ctx, "snapshot", nil, &state); e != nil {
		return nil, e
	}
	if state.URL != p.modelURL || state.Generating || state.Attachments {
		return nil, errors.New("page/model identity changed before send")
	}
	var control struct {
		Expanded bool
		Label    string
	}
	if e := p.eval(ctx, "model", nil, &control); e != nil {
		return nil, e
	}
	if control.Expanded || control.Label != p.modelLabel {
		return nil, errors.New("MODEL_UNVERIFIED: selected model/effort changed")
	}
	if e := p.tab.EnableNetworkStreaming(ctx, "/backend-api/f/conversation"); e != nil {
		return nil, e
	}
	// Discard only pre-dispatch events from this session. There is exactly one
	// monitor per send; never replay an old request as evidence for a new round.
	events := p.tab.NetworkEvents()
	for {
		select {
		case _, ok := <-events:
			if !ok {
				return nil, errors.New("network observer closed")
			}
		default:
			goto drained
		}
	}
drained:
	if err := p.eval(ctx, "send", map[string]any{"prompt": p.prompt}, nil); err != nil {
		return nil, err
	}
	out := make(chan SubmissionEvent, 32)
	p.modelVerified = false
	p.submitted = true
	// Subscription and streaming are armed before the real mouse dispatch. If
	// Click returns an error, delivery can be uncertain; do not permit an implicit resend.
	if e := p.clickArgs(ctx, "send", map[string]any{"prompt": p.prompt}); e != nil {
		close(out)
		return nil, fmt.Errorf("send dispatch uncertain; observe before retrying: %w", e)
	}
	p.observing = true
	go p.monitor(ctx, events, out)
	return out, nil
}
func (p *BrowserPage) monitor(ctx context.Context, events <-chan cdp.NetworkEvent, out chan<- SubmissionEvent) {
	defer func() { p.mu.Lock(); p.observing = false; p.mu.Unlock(); close(out) }()
	s := networkState{}
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	emit := func(e SubmissionEvent) bool {
		select {
		case out <- e:
			return true
		case <-ctx.Done():
			return false
		}
	}
	update := func() {
		if s.facts.ConversationID != "" {
			p.mu.Lock()
			p.userMessageID = s.facts.UserMessageID
			p.pendingConversationID = s.facts.ConversationID
			p.mu.Unlock()
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				if s.id != "" && !s.complete && !s.rejected {
					e := s.facts
					e.Kind = StreamAborted
					e.Error = "delivery_unknown: CDP disconnected"
					if s.confirmed {
						e.Error = "observation_interrupted: delivery was confirmed before CDP disconnected"
					}
					emit(e)
				}
				return
			}
			if event.Method == "Network.requestWillBeSent" && s.id == "" {
				if e, ok := s.request(event); ok {
					update()
					if !emit(e) {
						return
					}
				}
				continue
			}
			if s.id == "" || event.RequestID != s.id {
				continue
			}
			for _, e := range s.stream(event.Data) {
				update()
				if !emit(e) {
					return
				}
			}
			switch event.Method {
			case "Network.responseReceived":
				var v struct{ Response struct{ Status int } }
				if json.Unmarshal(event.Params, &v) == nil {
					e := s.facts
					e.Kind = HTTPStatus
					e.Status = v.Response.Status
					if e.Status < 200 || e.Status >= 300 {
						e.Error = "rejected"
						s.rejected = true
					}
					if !emit(e) {
						return
					}
					if s.rejected {
						return
					}
				}
			case "Network.loadingFailed", "Network.loadingFinished":
				if s.complete {
					return
				}
				if !s.confirmed {
					e := s.facts
					e.Kind = StreamAborted
					e.Error = "delivery_unknown: stream ended before input_message"
					emit(e)
					return
				}
				// Confirmed delivery can resume on another stream. DOM finality remains
				// authoritative fallback; a transport abort is not a rejected submission.
			}
			if s.done && s.complete {
				return
			}
		case <-ticker.C:
			if !s.confirmed || s.complete {
				continue
			}
			snap, e := p.Snapshot(ctx)
			if e != nil {
				continue
			}
			if snap.ConversationID != s.facts.ConversationID || snap.Generating {
				continue
			}
			id, err := finalResponse(snap, s.facts.UserMessageID)
			if err != nil || id != "" {
				e := s.facts
				e.Kind = StreamComplete
				e.AssistantMessageID = id
				if err != nil {
					e.Kind, e.Error = StreamAborted, err.Error()
				}
				emit(e)
				return
			}
		}
	}
}

// Observe resumes DOM-only observation after a daemon restart. It never sends.
// Identity must include the persisted user message ID to distinguish this round.
func (p *BrowserPage) Observe(ctx context.Context, id Identity) (<-chan SubmissionEvent, error) {
	if id.UserMessageID == "" {
		return nil, errors.New("observation requires user message identity")
	}
	if e := p.VerifyIdentity(ctx, id); e != nil {
		return nil, e
	}
	out := make(chan SubmissionEvent, 1)
	go func() {
		defer close(out)
		for {
			if e := p.VerifyIdentity(ctx, id); e != nil {
				select {
				case out <- SubmissionEvent{Kind: StreamAborted, Error: e.Error()}:
				case <-ctx.Done():
				}
				return
			}
			s, e := p.Snapshot(ctx)
			if e == nil && !s.Generating {
				reply, err := finalResponse(s, id.UserMessageID)
				if s.ConversationID != id.ConversationID {
					err = errors.New("CONVERSATION_IDENTITY_CHANGED")
				}
				if err != nil || reply != "" {
					event := SubmissionEvent{Kind: StreamComplete, ConversationID: s.ConversationID, UserMessageID: id.UserMessageID, AssistantMessageID: reply}
					for _, m := range s.Messages {
						if m.ID == reply {
							event.Model = m.Model
						}
					}
					if err != nil {
						event.Kind, event.Error = StreamAborted, err.Error()
					}
					select {
					case out <- event:
					case <-ctx.Done():
					}
					return
				}
			}
			if pause(ctx, 400*time.Millisecond) != nil {
				return
			}
		}
	}()
	return out, nil
}
