package chatgpt

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/convorel/internal/cdp"
)

//go:embed scripts/*.js
var scripts embed.FS

// BrowserPage implements Page. A page instance belongs to one tab and serializes
// mutations. NetworkEvents has a single consumer while a send is being observed.
type BrowserPage struct {
	tab                   cdp.Tab
	mu                    sync.Mutex
	bound                 Identity
	prompt, modelURL      string
	modelLabel            string
	userMessageID         string
	observing             bool
	modelVerified         bool
	projectURL            string
	submitted             bool
	pendingConversationID string
}

var _ Page = (*BrowserPage)(nil)

func New(tab cdp.Tab) *BrowserPage { return &BrowserPage{tab: tab} }
func NewPage(tab cdp.Tab) Page     { return New(tab) }

func jsFile(name string) string {
	b, e := scripts.ReadFile("scripts/" + name + ".js")
	if e != nil {
		panic(e)
	}
	return string(b)
}
func (p *BrowserPage) expression(action string, extra map[string]any) string {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["action"] = action
	extra["submitted"] = p.submitted
	extra["pendingID"] = p.pendingConversationID
	extra["expectedURL"] = p.bound.URL
	extra["expectedID"] = p.bound.ConversationID
	b, _ := json.Marshal(extra)
	guard := `if(args.expectedURL){const u=new URL(args.expectedURL); if(location.origin!==u.origin)throw new Error('PAGE_IDENTITY_CHANGED'); if(args.expectedID && currentID()!==args.expectedID)throw new Error('CONVERSATION_IDENTITY_CHANGED'); if(!args.expectedID && location.href!==args.expectedURL){if(!args.submitted || !currentID() || (!currentID().startsWith('local-') && currentID()!==args.pendingID))throw new Error('PAGE_IDENTITY_CHANGED');}}`
	messages := jsFile("messages")
	body := jsFile("action")
	if action == "copy" {
		body = jsFile("copy")
	}
	return "(async()=>{const args=" + string(b) + ";" + jsFile("controls") + guard + messages + body + "})()"
}
func (p *BrowserPage) eval(ctx context.Context, action string, extra map[string]any, out any) error {
	return p.tab.Evaluate(ctx, p.expression(action, extra), out)
}
func (p *BrowserPage) click(ctx context.Context, action string) error {
	return p.clickArgs(ctx, action, nil)
}
func (p *BrowserPage) clickArgs(ctx context.Context, action string, extra map[string]any) error {
	if native, ok := p.tab.(interface {
		ClickEvaluated(context.Context, string) error
	}); ok {
		return native.ClickEvaluated(ctx, p.expression(action, extra))
	}
	var c struct{ X, Y float64 }
	if err := p.eval(ctx, action, extra, &c); err != nil {
		return err
	}
	return p.tab.Click(ctx, c.X, c.Y)
}
func (p *BrowserPage) key(ctx context.Context, key string) error {
	k, ok := p.tab.(interface {
		KeyPress(context.Context, string, int) error
	})
	if !ok {
		return errors.New("page keyboard: CDP tab does not support key presses")
	}
	return k.KeyPress(ctx, key, 0)
}
func pause(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
func (p *BrowserPage) wait(ctx context.Context, action string, out any) error {
	var err error
	for i := 0; i < 30; i++ {
		if err = p.eval(ctx, action, nil, out); err == nil {
			return nil
		}
		if e := pause(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	return err
}
func (p *BrowserPage) Open(ctx context.Context, projectURL string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	raw := projectURL
	if raw == "" {
		raw = "https://chatgpt.com/"
	}
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || !allowedOrigin(u) {
		return errors.New("invalid ChatGPT/project URL")
	}
	if projectURL != "" && u.Hostname() == "chatgpt.com" {
		if _, e := ProjectID(projectURL); e != nil {
			return e
		}
	}
	p.bound = Identity{}
	p.modelVerified = false
	p.prompt = ""
	p.submitted = false
	p.pendingConversationID = ""
	if e = p.tab.Navigate(ctx, raw); e != nil {
		return e
	}
	var r struct {
		URL, ID  string
		Messages int
	}
	if e = p.wait(ctx, "ready", &r); e != nil {
		return e
	}
	if r.URL != raw || r.ID != "" || r.Messages != 0 {
		return errors.New("new conversation: location/history changed")
	}
	p.bound = Identity{URL: r.URL}
	p.projectURL = ""
	if _, e := ProjectID(projectURL); e == nil {
		p.projectURL = projectURL
	}
	return nil
}
func allowedOrigin(u *url.URL) bool {
	return u != nil && ((u.Scheme == "https" && u.Host == "chatgpt.com") || (u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")))
}
func conversationID(raw string) string {
	u, e := url.Parse(raw)
	if e != nil {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "c" {
			id, _ := url.PathUnescape(parts[i+1])
			return id
		}
	}
	return ""
}
func (p *BrowserPage) Attach(ctx context.Context, id Identity) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	u, e := url.Parse(id.URL)
	if e != nil || u.User != nil || !allowedOrigin(u) || id.ConversationID == "" || conversationID(id.URL) != id.ConversationID {
		return errors.New("invalid conversation identity")
	}
	// An attached target is evidence; never navigate away to replace a mismatched tab.
	if e = p.verify(ctx, id); e != nil {
		return e
	}
	p.bound = id
	p.modelVerified = false
	return nil
}

// ShowLatest scrolls the transcript to its newest turn. ChatGPT renders only
// the turns near the viewport of a long conversation, so a tab left at the top
// does not contain the latest exchange in its DOM. It never sends.
func (p *BrowserPage) ShowLatest(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var moved bool
	return p.eval(ctx, "showLatest", nil, &moved)
}
func (p *BrowserPage) VerifyIdentity(ctx context.Context, id Identity) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.verify(ctx, id)
}
func (p *BrowserPage) verify(ctx context.Context, id Identity) error {
	var r struct {
		URL, ID  string
		Messages []struct{ ID, Role string }
	}
	// Explicit reattachment validates the supplied identity below, rather than
	// applying a stale provisional pre-send URL guard first.
	if e := p.tab.Evaluate(ctx, `(async()=>{const args={action:"identity"};`+jsFile("controls")+jsFile("messages")+jsFile("action")+"})()", &r); e != nil {
		return e
	}
	if id.URL != "" {
		a, e := url.Parse(id.URL)
		b, f := url.Parse(r.URL)
		if e != nil || f != nil || a.Scheme != b.Scheme || a.Host != b.Host {
			return errors.New("PAGE_IDENTITY_CHANGED")
		}
	}
	if id.ConversationID != "" && r.ID != id.ConversationID {
		return errors.New("CONVERSATION_IDENTITY_CHANGED")
	}
	for _, target := range []struct{ id, role string }{{id.UserMessageID, "user"}, {id.AssistantMessageID, "assistant"}} {
		if target.id != "" {
			n := 0
			for _, m := range r.Messages {
				if m.ID == target.id && m.Role == target.role {
					n++
				}
			}
			if n != 1 {
				return fmt.Errorf("message identity %s: expected one visible message, got %d", target.id, n)
			}
		}
	}
	return nil
}
func (p *BrowserPage) FillComposer(ctx context.Context, prompt string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if prompt == "" {
		return errors.New("empty prompt")
	}
	if e := p.write(ctx, prompt); e != nil {
		return e
	}
	p.prompt = prompt
	return nil
}

// write types into an empty composer and verifies the exact resulting draft.
func (p *BrowserPage) write(ctx context.Context, text string) error {
	if e := p.eval(ctx, "focus", nil, nil); e != nil {
		return e
	}
	if e := p.tab.InsertText(ctx, text); e != nil {
		return e
	}
	var draft string
	if e := p.eval(ctx, "draft", nil, &draft); e != nil {
		return e
	}
	if draft != text {
		return errors.New("composer: exact draft verification failed")
	}
	return nil
}

// Draft reads the unsent composer text without changing it.
func (p *BrowserPage) Draft(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var draft string
	e := p.eval(ctx, "draft", nil, &draft)
	return draft, e
}

// ClearDraft empties the composer only while it still holds exactly expected,
// the text the caller has already saved. It never arms a send.
func (p *BrowserPage) ClearDraft(ctx context.Context, expected string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prompt = ""
	if expected == "" {
		return nil
	}
	if e := p.eval(ctx, "selectDraft", map[string]any{"expected": expected}, nil); e != nil {
		return e
	}
	if e := p.key(ctx, "Backspace"); e != nil {
		return e
	}
	var draft string
	for i := 0; i < 20; i++ {
		if e := p.eval(ctx, "draft", nil, &draft); e != nil {
			return e
		}
		if draft == "" {
			return nil
		}
		if e := pause(ctx, 50*time.Millisecond); e != nil {
			return e
		}
	}
	return errors.New("composer: draft was not cleared")
}

// RestoreDraft puts saved text back into an empty composer. The text is not a
// prompt: Send keeps refusing until FillComposer supplies one.
func (p *BrowserPage) RestoreDraft(ctx context.Context, text string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prompt = ""
	if text == "" {
		return nil
	}
	return p.write(ctx, text)
}

type modelState struct {
	Min, Max, Value     int
	Description, Family string
	Latest, Disabled    bool
}

func (p *BrowserPage) openModel(ctx context.Context) error {
	var c struct{ Expanded bool }
	if e := p.eval(ctx, "model", nil, &c); e != nil {
		return e
	}
	if !c.Expanded {
		return p.click(ctx, "model")
	}
	return nil
}
func (p *BrowserPage) closeModel(ctx context.Context) error { return p.key(ctx, "Escape") }
func (p *BrowserPage) EnsureModel(ctx context.Context, expected string, effort int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.modelVerified = false
	if effort < 1 || effort > 5 {
		return errors.New("effort: expected 1 through 5")
	}
	var before Snapshot
	if e := p.eval(ctx, "snapshot", nil, &before); e != nil {
		return e
	}
	if before.Generating {
		return errors.New("model: response is generating")
	}
	if e := p.openModel(ctx); e != nil {
		return e
	}
	closed := false
	defer func() {
		if !closed {
			_ = p.closeModel(ctx)
		}
	}()
	var s modelState
	if e := p.wait(ctx, "modelState", &s); e != nil {
		return e
	}
	// Compact effort menus expose the model family in their advanced view.
	if s.Family == "" {
		if e := p.click(ctx, "modelFamily"); e != nil {
			return fmt.Errorf("MODEL_UNVERIFIED: %w", e)
		}
		if e := p.wait(ctx, "familyState", &s); e != nil {
			return e
		}
		if e := p.click(ctx, "modelFamily"); e != nil {
			return e
		}
		if e := p.wait(ctx, "modelState", nil); e != nil {
			return e
		}
	}
	family := s.Family
	latest := s.Latest
	normalized := strings.TrimSpace(strings.TrimPrefix(expected, "GPT-"))
	familyNumber := strings.TrimPrefix(family, "GPT-")
	rolling := expected == "" || expected == "latest-pro" || strings.EqualFold(expected, "Latest")
	if !regexp.MustCompile(`^GPT-\d+(\.\d+)?( Sol)?$`).MatchString(family) || (rolling && !latest) || (!rolling && normalized != familyNumber && normalized != familyNumber+" Pro" && expected != "gpt-"+strings.ToLower(familyNumber)) {
		return fmt.Errorf("MODEL_UNVERIFIED: expected %q, selected %q (rolling=%v)", expected, family, latest)
	}
	for i := 0; i < 5; i++ {
		var power modelState
		if e := p.eval(ctx, "modelState", nil, &power); e != nil {
			return e
		}
		if power.Disabled || power.Max-power.Min != 4 {
			return errors.New("effort-slider: unavailable or not five positions")
		}
		target := power.Min + effort - 1
		if power.Value == target {
			names := []string{"Instant", "Light", "Standard", "High", "Pro"}
			if power.Description == "" || !strings.Contains(strings.ToLower(power.Description), strings.ToLower(names[effort-1])) { // Intermediate labels may vary; the ordinal is definitive.
				if !strings.Contains(power.Description, fmt.Sprintf("%d of 5", effort)) {
					return errors.New("effort-slider: description does not verify selected effort")
				}
			}
			// Power can change the selected family. Confirm it from the same open
			// menu before closing; the top-level menu is never opened twice.
			var final modelState
			if e := p.eval(ctx, "modelState", nil, &final); e != nil {
				return e
			}
			if final.Family == "" {
				if e := p.click(ctx, "modelFamily"); e != nil {
					return e
				}
				if e := p.wait(ctx, "familyState", &final); e != nil {
					return e
				}
			}
			if final.Family != family || (rolling && !final.Latest) {
				return errors.New("MODEL_UNVERIFIED: selected family changed after effort selection")
			}
			if e := p.eval(ctx, "modelState", nil, nil); e != nil {
				if e := p.click(ctx, "modelFamily"); e != nil {
					return e
				}
			}
			if e := p.closeModel(ctx); e != nil {
				return e
			}
			closed = true
			var control struct {
				Expanded bool
				Label    string
			}
			if e := p.eval(ctx, "model", nil, &control); e != nil {
				return e
			}
			if control.Expanded {
				return errors.New("model-menu: did not close")
			}
			p.modelLabel = control.Label
			p.modelVerified = true
			p.modelURL = before.URL
			return nil
		}
		if e := p.eval(ctx, "sliderFocus", nil, nil); e != nil {
			return e
		}
		key := "ArrowRight"
		if power.Value > target {
			key = "ArrowLeft"
		}
		if e := p.key(ctx, key); e != nil {
			return e
		}
		if e := pause(ctx, 50*time.Millisecond); e != nil {
			return e
		}
	}
	return errors.New("effort-slider: selection did not persist")
}

// Snapshot exposes DOM evidence for reattached pages and resumed Pro streams.
// Finality requires the target's own Copy control and no active Stop control.
type Message struct {
	ID, Role, Text, Model string
	Final                 bool
}
type Snapshot struct {
	URL, ConversationID string
	Generating          bool
	Attachments         bool
	Messages            []Message
}

func (p *BrowserPage) Snapshot(ctx context.Context) (Snapshot, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var s Snapshot
	e := p.eval(ctx, "snapshot", nil, &s)
	if e != nil && p.submitted && p.bound.ConversationID == "" {
		// Prepared-dispatch streams may not carry the canonical ID until the
		// answer ends. Correlate the new URL using this run's unique saved marker.
		marker := regexp.MustCompile(`^\[CONVOREL:[A-Za-z0-9-]+\]`).FindString(p.prompt)
		if marker != "" {
			var observed Snapshot
			expr := `(async()=>{const args={action:"snapshot"};` + jsFile("controls") + jsFile("messages") + jsFile("action") + "})()"
			if err := p.tab.Evaluate(ctx, expr, &observed); err == nil {
				prior, _ := url.Parse(p.bound.URL)
				current, _ := url.Parse(observed.URL)
				user := ""
				matches := 0
				users := 0
				for _, m := range observed.Messages {
					if m.Role == "user" {
						users++
					}
					if m.Role == "user" && m.ID != "" && strings.Count(m.Text, marker) == 1 {
						user = m.ID
						matches++
					}
				}
				if prior != nil && current != nil && prior.Scheme == current.Scheme && prior.Host == current.Host && observed.ConversationID != "" && !strings.HasPrefix(observed.ConversationID, "local-") && matches == 1 && users == 1 && (p.pendingConversationID == "" || strings.HasPrefix(p.pendingConversationID, "local-") || p.pendingConversationID == observed.ConversationID) {
					p.bound = Identity{URL: observed.URL, ConversationID: observed.ConversationID, UserMessageID: user}
					p.pendingConversationID = observed.ConversationID
					p.userMessageID = user
					return observed, nil
				}
			}
		}
	}
	return s, e
}
func (p *BrowserPage) ReadReply(ctx context.Context, id string) (Reply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id != "" && !regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`).MatchString(id) {
		return Reply{}, errors.New("invalid reply message ID")
	}
	var target Message
	found := false
	// Completion and a just-clicked "Copied" control both hide the Copy control
	// for a moment; finality waits for it to return.
	for attempt := 0; attempt < 60; attempt++ {
		var s Snapshot
		if e := p.eval(ctx, "snapshot", nil, &s); e != nil {
			return Reply{}, e
		}
		var candidates []Message
		user := p.userMessageID
		if user == "" {
			user = p.bound.UserMessageID
		}
		if id == "" && user == "" {
			return Reply{}, errors.New("reply: message identity required")
		}
		seen := false
		for _, m := range s.Messages {
			if m.Role == "user" {
				seen = m.ID == user
				if seen {
					candidates = nil
				}
			}
			if m.Role == "assistant" && ((id != "" && m.ID == id) || (id == "" && seen && m.Final)) {
				candidates = append(candidates, m)
			}
		}
		if len(candidates) > 1 {
			return Reply{}, fmt.Errorf("reply: expected one visible matching message, got %d", len(candidates))
		}
		if len(candidates) == 1 && candidates[0].Final {
			target = candidates[0]
			found = true
			break
		}
		// Stream completion can arrive just before React renders the Copy control.
		if e := pause(ctx, 100*time.Millisecond); e != nil {
			return Reply{}, e
		}
	}
	if !found {
		return Reply{}, errors.New("reply: not complete or not rendered")
	}
	var r struct {
		OK           bool
		Text, Reason string
	}
	// After a click ChatGPT shows "Copied" in place of the Copy control for
	// about two seconds. The first click on a freshly loaded page copies an
	// empty payload, and a click may not reach the clipboard at all.
	for attempt := 0; ; attempt++ {
		if e := p.eval(ctx, "copy", map[string]any{"id": target.ID}, &r); e != nil {
			return Reply{}, e
		}
		if r.OK {
			break
		}
		if attempt == 7 || r.Reason != "COPY_BUTTON_MISSING" && r.Reason != "COPY_NOT_CAPTURED" && r.Reason != "COPY_PAYLOAD_EMPTY" {
			return Reply{}, fmt.Errorf("copy: %s", r.Reason)
		}
		if e := pause(ctx, time.Second); e != nil {
			return Reply{}, e
		}
	}
	return Reply{ID: target.ID, Markdown: r.Text, Model: target.Model}, nil
}

// DoctorUI is the registration point for doctor --ui. Callers use report.OK to
// choose a nonzero exit status; checks never send or create a conversation.
func DoctorUI(ctx context.Context, tab cdp.Tab) (SelfCheckReport, error) {
	return New(tab).SelfCheck(ctx)
}
func (p *BrowserPage) SelfCheck(ctx context.Context) (SelfCheckReport, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var r SelfCheckReport
	// Capture each missing control independently, including failures opening menus.
	if e := p.eval(ctx, "selfCheck", nil, &r); e != nil {
		return r, e
	}
	if r.ModelMenu.OK {
		if e := p.openModel(ctx); e == nil {
			var s modelState
			if e = p.wait(ctx, "modelState", &s); e == nil && !s.Disabled && s.Max-s.Min == 4 && s.Value >= s.Min && s.Value <= s.Max {
				r.EffortSlider = Check{OK: true, Count: 5, Detail: fmt.Sprintf("%d of 5: %s", s.Value-s.Min+1, s.Description)}
				r.Effort = s.Value - s.Min + 1
			} else if e != nil {
				r.EffortSlider = Check{Detail: e.Error()}
			} else if s.Disabled {
				r.EffortSlider = Check{Detail: "effort-slider: disabled"}
			} else {
				r.EffortSlider = Check{Count: s.Max - s.Min + 1, Detail: "effort-slider: expected five positions and a valid selected position"}
			}
			_ = p.closeModel(ctx)
		} else {
			r.ModelMenu = Check{Detail: e.Error()}
		}
	}
	if e := p.click(ctx, "options"); e == nil {
		if e = p.wait(ctx, "rename", nil); e == nil {
			r.Rename = Check{OK: true, Count: 1}
		} else {
			r.Rename = Check{Detail: e.Error()}
		}
		_ = p.key(ctx, "Escape")
	} else {
		r.Rename = Check{Detail: e.Error()}
	}
	r.OK = r.Composer.OK && r.Send.OK && r.ModelMenu.OK && r.EffortSlider.OK && r.Rename.OK
	return r, nil
}
