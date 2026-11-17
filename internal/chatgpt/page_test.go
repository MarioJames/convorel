package chatgpt_test

import (
	"context"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/cdp"
	"github.com/MarioJames/convorel/internal/chatgpt"
	"github.com/MarioJames/convorel/internal/chatgpt/fixture"
)

func browser(t *testing.T) (*cdp.Manager, context.Context) {
	t.Helper()
	if _, e := os.Stat("/usr/bin/google-chrome"); e != nil {
		t.Skip("headless Chrome absent: /usr/bin/google-chrome")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home+"/config")
	t.Setenv("XDG_CACHE_HOME", home+"/cache")
	t.Setenv("XDG_DATA_HOME", home+"/data")
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	endpoint := "http://" + listener.Addr().String()
	_ = listener.Close()
	m, e := cdp.New(cdp.Options{Mode: "managed", Endpoint: endpoint, Executable: "/usr/bin/google-chrome", UserDataDir: t.TempDir(), Headless: true, ActionInterval: -1, NavigationWait: -1, ExtraArgs: []string{"--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"}})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	t.Cleanup(func() {
		cancel()
		c, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if e := m.Stop(c); e != nil {
			t.Error(e)
		}
	})
	if e = m.Ensure(ctx); e != nil {
		t.Fatal(e)
	}
	return m, ctx
}
func newPage(t *testing.T, m *cdp.Manager, ctx context.Context, s *fixture.Server) (*chatgpt.BrowserPage, cdp.Tab) {
	t.Helper()
	tab, e := m.NewTab(ctx, "about:blank")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = tab.Close(context.Background()) })
	p := chatgpt.New(tab)
	if e = p.Open(ctx, s.URL+"/"); e != nil {
		t.Fatal(e)
	}
	return p, tab
}
func send(t *testing.T, p *chatgpt.BrowserPage, ctx context.Context, prompt string) []chatgpt.SubmissionEvent {
	t.Helper()
	if e := p.EnsureModel(ctx, "latest-pro", 1); e != nil {
		t.Fatal(e)
	}
	if e := p.FillComposer(ctx, prompt); e != nil {
		t.Fatal(e)
	}
	events, e := p.Send(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var result []chatgpt.SubmissionEvent
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return result
			}
			result = append(result, event)
		case <-ctx.Done():
			t.Fatalf("events timeout: %+v", result)
		}
	}
}
func event(t *testing.T, events []chatgpt.SubmissionEvent, kind chatgpt.SubmissionKind) chatgpt.SubmissionEvent {
	t.Helper()
	for _, e := range events {
		if e.Kind == kind {
			return e
		}
	}
	t.Fatalf("missing %s: %+v", kind, events)
	return chatgpt.SubmissionEvent{}
}
func TestVisibleComposerNetworkCopyAndRename(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{HiddenExtraForm: true})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	prompt := "A7: exact prompt\n\nhello 世界 😀\n"
	events := send(t, p, ctx, prompt)
	req := event(t, events, chatgpt.RequestSent)
	if req.UserMessageID == "" || req.Model != "gpt-6" || req.ParentMessageID != "fixture-parent" {
		t.Fatalf("request facts: %+v", req)
	}
	if e := event(t, events, chatgpt.HTTPStatus); e.Status != 200 {
		t.Fatal(e)
	}
	input := event(t, events, chatgpt.InputMessage)
	if input.UserMessageID != req.UserMessageID || input.ConversationID != fixture.ConversationID {
		t.Fatalf("input: %+v", input)
	}
	complete := event(t, events, chatgpt.StreamComplete)
	if complete.AssistantMessageID != fixture.AssistantMessageID {
		t.Fatal(complete)
	}
	event(t, events, chatgpt.StreamDone)
	if requests := s.Requests(); len(requests) != 1 || requests[0].Prompt != prompt {
		t.Fatalf("requests: %+v", requests)
	}
	var hiddenDraft string
	if e := tab.Evaluate(ctx, `document.querySelector('form[style] textarea').value`, &hiddenDraft); e != nil || hiddenDraft != "" {
		t.Fatalf("hidden draft %q: %v", hiddenDraft, e)
	}
	// Network completion can precede the render task. Poll only the read operation.
	var reply chatgpt.Reply
	var err error
	for i := 0; i < 40; i++ {
		reply, err = p.ReadReply(ctx, complete.AssistantMessageID)
		if err == nil {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if err != nil || reply.Markdown != fixture.Markdown {
		t.Fatalf("copy markdown: %+v, %v", reply, err)
	}
	report, e := p.SelfCheck(ctx)
	if e != nil || !report.OK || report.Effort != 1 || report.EffortSlider.Count != 5 {
		t.Fatalf("doctor report: %+v, %v", report, e)
	}
	if len(s.Requests()) != 1 {
		t.Fatal("doctor sent a message")
	}
	// ClipboardItem markdown preference and ambiguity use the actual Copy button.
	if e := tab.Evaluate(ctx, `(()=>{const b=document.querySelector('[data-testid=copy-turn-action-button]');window.originalCopy=b.onclick;b.onclick=()=>navigator.clipboard.write([{types:['text/plain','text/markdown'],getType:async type=>new Blob([type==='text/markdown'?window.fixtureMarkdown:'rendered plain text'])}]);return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	copied, e := p.ReadReply(ctx, complete.AssistantMessageID)
	if e != nil || copied.Markdown != fixture.Markdown {
		t.Fatalf("ClipboardItem markdown: %+v %v", copied, e)
	}
	if e := tab.Evaluate(ctx, `(()=>{document.querySelector('[data-testid=copy-turn-action-button]').onclick=()=>{navigator.clipboard.writeText('one');navigator.clipboard.writeText('two')};return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	if _, e := p.ReadReply(ctx, complete.AssistantMessageID); e == nil || !strings.Contains(e.Error(), "COPY_AMBIGUOUS") {
		t.Fatalf("clipboard ambiguity accepted: %v", e)
	}
	var restored bool
	if e := tab.Evaluate(ctx, `(()=>{document.querySelector('[data-testid=copy-turn-action-button]').onclick=window.originalCopy;return !Object.hasOwn(navigator.clipboard,'write')&&!Object.hasOwn(navigator.clipboard,'writeText')})()`, &restored); e != nil || !restored {
		t.Fatalf("clipboard not restored: %v %v", restored, e)
	}
	if e := tab.Evaluate(ctx, `(()=>{document.querySelector('[data-testid=copy-turn-action-button]').onclick=()=>{history.replaceState(null,'','/c/different');navigator.clipboard.writeText(window.fixtureMarkdown)};return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	if _, e := p.ReadReply(ctx, complete.AssistantMessageID); e == nil || !strings.Contains(e.Error(), "TARGET_CHANGED") {
		t.Fatalf("navigation during Copy accepted: %v", e)
	}
	if e := tab.Evaluate(ctx, `(()=>{history.replaceState(null,'','/c/fixture-conversation');document.querySelector('[data-testid=copy-turn-action-button]').onclick=window.originalCopy;return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	// Reattachment proves DOM-only restart recovery, without another send.
	id := chatgpt.Identity{ConversationID: fixture.ConversationID, URL: s.URL + "/c/" + fixture.ConversationID, UserMessageID: req.UserMessageID}
	reattached := chatgpt.New(tab)
	if e := reattached.Attach(ctx, id); e != nil {
		t.Fatal(e)
	}
	metadata, e := reattached.Metadata(ctx)
	if e != nil || metadata.ConversationID != fixture.ConversationID || metadata.CreatedAt.IsZero() || metadata.Title != "Fixture chat" || metadata.ProjectID != "" {
		t.Fatalf("server metadata: %+v %v", metadata, e)
	}
	if e := reattached.VerifyProject(ctx, s.URL+"/g/g-p-other/project"); e == nil {
		t.Fatal("incorrect project membership accepted")
	}
	recovered, e := reattached.Observe(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	select {
	case v := <-recovered:
		if v.Kind != chatgpt.StreamComplete || v.AssistantMessageID != complete.AssistantMessageID {
			t.Fatal(v)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if e := reattached.Rename(ctx, "1114｜DES｜Fixture naming"); e != nil {
		t.Fatal(e)
	}
	if e := reattached.VerifyIdentity(ctx, chatgpt.Identity{ConversationID: "different", URL: id.URL}); e == nil {
		t.Fatal("wrong conversation accepted")
	}
}
func TestHiddenARIAThumbInVisiblePowerControl(t *testing.T) {
	m, ctx := browser(t)
	fixture := fixture.New(fixture.Options{})
	defer fixture.Close()
	tab, err := m.NewTab(ctx, fixture.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	p := chatgpt.New(tab)
	if err = p.Open(ctx, fixture.URL+"/"); err != nil {
		t.Fatal(err)
	}
	if err = tab.Evaluate(ctx, `(()=>{const s=document.querySelector('[role=slider]');s.setAttribute('aria-hidden','true');s.removeAttribute('aria-describedby');
 const toggle=document.querySelector('[data-model-picker-view-toggle]');
 const original=toggle.onclick;toggle.onclick=()=>{original();if(!document.querySelector('#advanced').hidden)toggle.hidden=true};
 document.querySelector('#advanced [aria-checked=true]').onclick=()=>{document.querySelector('#advanced').hidden=true;document.querySelector('#simple').hidden=false;toggle.hidden=false;toggle.setAttribute('aria-expanded','false')};return true})()`, nil); err != nil {
		t.Fatal(err)
	}
	if err = p.EnsureModel(ctx, "latest-pro", 1); err != nil {
		t.Fatal(err)
	}
	if err = p.EnsureModel(ctx, "latest-pro", 5); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Requests()) != 0 {
		t.Fatal("model validation sent a message")
	}
}

func TestNetworkFaultsAndDoctor(t *testing.T) {
	m, ctx := browser(t)
	for _, test := range []struct {
		name    string
		options fixture.Options
		kind    chatgpt.SubmissionKind
		status  int
	}{{"403", fixture.Options{Forbidden: true}, chatgpt.HTTPStatus, 403}, {"cut before input", fixture.Options{CutBeforeInputMessage: true}, chatgpt.StreamAborted, 0}, {"slow reply", fixture.Options{SlowReply: 550 * time.Millisecond}, chatgpt.StreamComplete, 0}, {"resumed DOM completion", fixture.Options{OmitStreamComplete: true}, chatgpt.StreamComplete, 0}} {
		t.Run(test.name, func(t *testing.T) {
			s := fixture.New(test.options)
			defer s.Close()
			p, _ := newPage(t, m, ctx, s)
			events := send(t, p, ctx, "OK")
			v := event(t, events, test.kind)
			if test.status != 0 && v.Status != test.status {
				t.Fatal(v)
			}
			if test.kind == chatgpt.StreamAborted && !strings.Contains(v.Error, "delivery_unknown") {
				t.Fatal(v)
			}
			if test.status == 403 {
				for _, v := range events {
					if v.Kind == chatgpt.StreamAborted || v.Kind == chatgpt.InputMessage {
						t.Fatalf("rejection classified incorrectly: %+v", events)
					}
				}
			}
			if len(s.Requests()) != 1 {
				t.Fatal("fault caused resend")
			}
		})
	}
	s := fixture.New(fixture.Options{MissingSendButton: true, HiddenExtraForm: true})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	if e := tab.Navigate(ctx, s.URL+"/c/"+fixture.ConversationID); e != nil {
		t.Fatal(e)
	}
	// New instance reflects an independently attached diagnostic tab.
	p = chatgpt.New(tab)
	report, e := p.SelfCheck(ctx)
	if e != nil || report.OK || report.Send.OK || report.Send.Count != 0 || !strings.Contains(report.Send.Detail, "send") {
		t.Fatalf("missing Send: %+v, %v", report, e)
	}
	if !report.Composer.OK || !report.ModelMenu.OK || !report.EffortSlider.OK || !report.Rename.OK {
		t.Fatalf("unrelated check failed: %+v", report)
	}
	if len(s.Requests()) != 0 {
		t.Fatal("doctor sent a request")
	}
	if e := tab.Evaluate(ctx, `(()=>{document.querySelector('[role=slider]').setAttribute('aria-disabled','true');return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	report, e = p.SelfCheck(ctx)
	if e != nil || report.OK || report.EffortSlider.OK || !strings.Contains(report.EffortSlider.Detail, "disabled") {
		t.Fatalf("disabled slider: %+v %v", report, e)
	}
}
func TestContentEditableFollowupWithHiddenForm(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{HiddenExtraForm: true, ContentEditable: true})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	first := send(t, p, ctx, "first prompt\n世界 😀\n")
	firstReply := event(t, first, chatgpt.StreamComplete)
	if _, e := p.ReadReply(ctx, firstReply.AssistantMessageID); e != nil {
		t.Fatal(e)
	}
	followup := chatgpt.New(tab)
	id := chatgpt.Identity{ConversationID: fixture.ConversationID, URL: s.URL + "/c/" + fixture.ConversationID}
	if e := followup.Attach(ctx, id); e != nil {
		t.Fatal(e)
	}
	second := send(t, followup, ctx, "second prompt\n\nexact followup\n")
	secondReply := event(t, second, chatgpt.StreamComplete)
	if secondReply.AssistantMessageID == firstReply.AssistantMessageID {
		t.Fatal("followup reused old assistant identity")
	}
	requests := s.Requests()
	if len(requests) != 2 || requests[1].ConversationID != fixture.ConversationID || requests[1].ParentMessageID != firstReply.AssistantMessageID || requests[1].Prompt != "second prompt\n\nexact followup\n" {
		t.Fatalf("followup requests: %+v", requests)
	}
	reply, e := followup.ReadReply(ctx, secondReply.AssistantMessageID)
	if e != nil || reply.Markdown != fixture.Markdown {
		t.Fatalf("followup copy: %+v %v", reply, e)
	}
}

func TestEffortAndFailClosedControls(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{HiddenExtraForm: true})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	for _, effort := range []int{5, 1, 2, 3, 4} {
		if e := p.EnsureModel(ctx, "GPT-6 Pro", effort); e != nil {
			t.Fatal(e)
		}
		var value string
		if e := tab.Evaluate(ctx, `document.querySelector('[role=slider]').getAttribute('aria-valuenow')`, &value); e != nil || value != string(rune('0'+effort-1)) {
			t.Fatalf("effort %d: %q, %v", effort, value, e)
		}
	}
	if e := p.EnsureModel(ctx, "GPT-5 Pro", 1); e == nil {
		t.Fatal("model mismatch accepted")
	}
	if e := p.FillComposer(ctx, "prompt"); e != nil {
		t.Fatal(e)
	}
	if _, e := p.Send(ctx); e == nil {
		t.Fatal("send allowed without verified model")
	}
	if len(s.Requests()) != 0 {
		t.Fatal("mismatch sent")
	}
	if e := p.EnsureModel(ctx, "GPT-6 Pro", 1); e != nil {
		t.Fatal(e)
	}
	if e := tab.Evaluate(ctx, `(()=>{document.querySelector('#model-trigger').textContent='Thinking effort Pro';return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	if _, e := p.Send(ctx); e == nil || !strings.Contains(e.Error(), "MODEL_UNVERIFIED") {
		t.Fatalf("changed effort allowed send: %v", e)
	}

	// Duplicate visible controls must stop before modifying either draft.
	if e := tab.Evaluate(ctx, `(()=>{const f=document.querySelector('main form:not([style])');f.after(f.cloneNode(true));return true})()`, nil); e != nil {
		t.Fatal(e)
	}
	if e := p.FillComposer(ctx, "second prompt"); e == nil || !strings.Contains(e.Error(), "composer") {
		t.Fatalf("ambiguous composer: %v", e)
	}
}

func TestProjectCreationAndPlacementVerification(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{ProjectID: "g-p-fixture", HiddenExtraForm: true})
	defer s.Close()
	p, _ := newPage(t, m, ctx, s)
	projectURL := s.URL + "/g/g-p-fixture-review/project"
	if e := p.Open(ctx, projectURL); e != nil {
		t.Fatal(e)
	}
	events := send(t, p, ctx, "project prompt")
	if _, e := p.ReadReply(ctx, event(t, events, chatgpt.StreamComplete).AssistantMessageID); e != nil {
		t.Fatal(e)
	}
	if e := p.VerifyProject(ctx, projectURL); e != nil {
		t.Fatal(e)
	}
	if e := p.Rename(ctx, "1114｜DES｜Project title"); e != nil {
		t.Fatal(e)
	}
	metadata, e := p.Metadata(ctx)
	if e != nil || metadata.ProjectID != "g-p-fixture" || metadata.Title != "1114｜DES｜Project title" {
		t.Fatalf("project metadata: %+v %v", metadata, e)
	}
	// A changed server membership must stop a later rename, preserving its title.
	s.SetOptions(fixture.Options{ProjectID: "g-p-other"})
	if e := p.Rename(ctx, "must not save"); e == nil {
		t.Fatal("rename accepted changed project membership")
	}
	metadata, e = p.Metadata(ctx)
	if e != nil || metadata.Title != "1114｜DES｜Project title" {
		t.Fatalf("project mismatch changed title: %+v %v", metadata, e)
	}
}

func TestNativeSidebarActionsBesideSubmenu(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{})
	defer s.Close()
	_, tab := newPage(t, m, ctx, s)
	script := `(()=>{history.replaceState(null,'','/c/fixture-conversation');const b=document.querySelector('#conversation-options-fixture-conversation');b.removeAttribute('data-conversation-options-trigger');b.removeAttribute('data-testid');b.id='native-actions';b.setAttribute('aria-label','Chat actions');document.querySelector('#options-menu').setAttribute('aria-labelledby',b.id);const extra=document.createElement('button');extra.setAttribute('aria-haspopup','menu');extra.textContent='Unrelated submenu';b.parentElement.append(extra);return true})()`
	if err := tab.Evaluate(ctx, script, nil); err != nil {
		t.Fatal(err)
	}
	report, err := chatgpt.New(tab).SelfCheck(ctx)
	if err != nil || !report.Rename.OK {
		t.Fatalf("native options: %+v %v", report, err)
	}
	if len(s.Requests()) != 0 {
		t.Fatal("doctor sent a message")
	}
}

func TestExplicitIdentityRebindAfterProvisionalURL(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	if err := tab.Evaluate(ctx, `history.replaceState(null,'','/c/fixture-conversation')`, nil); err != nil {
		t.Fatal(err)
	}
	if err := p.Attach(ctx, chatgpt.Identity{URL: s.URL + "/c/fixture-conversation", ConversationID: fixture.ConversationID}); err != nil {
		t.Fatal("stale pre-send guard blocked explicit identity", err)
	}
	if err := p.VerifyIdentity(ctx, chatgpt.Identity{URL: s.URL + "/c/wrong", ConversationID: "wrong"}); err == nil {
		t.Fatal("accepted wrong explicit identity")
	}
	if _, err := p.Snapshot(ctx); err != nil {
		t.Fatal("reattachment did not update snapshot guard", err)
	}
}

func TestMetadataUsesAuthenticatedPageGETAndAcknowledgedRename(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{RequirePageAuth: true, WrappedOptions: true})
	defer s.Close()
	p, _ := newPage(t, m, ctx, s)
	events := send(t, p, ctx, "Only reply OK")
	complete := event(t, events, chatgpt.StreamComplete)
	if _, err := p.ReadReply(ctx, complete.AssistantMessageID); err != nil {
		t.Fatal(err)
	}
	metadata, err := p.Metadata(ctx)
	if err != nil || metadata.ConversationID != fixture.ConversationID {
		t.Fatalf("app metadata: %+v %v", metadata, err)
	}
	if err = p.Rename(ctx, "1114｜EXP｜Observed metadata"); err != nil {
		t.Fatal(err)
	}
	metadata, err = p.Metadata(ctx)
	if err != nil || metadata.Title != "1114｜EXP｜Observed metadata" {
		t.Fatal(metadata, err)
	}
	if len(s.Requests()) != 1 {
		t.Fatal("metadata/rename sent a message")
	}
}

func TestRecoveryRejectsAbsentMarkerAndConflictingIdentity(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{BeforeInputDelay: time.Millisecond})
	defer s.Close()
	p, _ := newPage(t, m, ctx, s)
	events := send(t, p, ctx, "[CONVOREL:fixture-marker]\n\nOnly reply OK")
	complete := event(t, events, chatgpt.StreamComplete)
	if _, err := p.ReadReply(ctx, complete.AssistantMessageID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		marker, cid, uid string
		since            time.Time
	}{
		{"[CONVOREL:wrong-marker]", "", "", time.Now().Add(-time.Minute)},
		{"[CONVOREL:fixture-marker]", "wrong-conversation", "", time.Now().Add(-time.Minute)},
		{"[CONVOREL:fixture-marker]", "", "wrong-user", time.Now().Add(-time.Minute)},
		{"[CONVOREL:fixture-marker]", "", "", time.Now().Add(time.Minute)},
	} {
		if _, err := p.RecoverFirst(ctx, s.URL+"/", tc.marker, tc.since, tc.cid, tc.uid); err == nil {
			t.Fatal("unsafe adoption", tc)
		}
	}
	if len(s.Requests()) != 1 {
		t.Fatal("recovery resent")
	}
}

func TestRenameRequiresSaveAcknowledgement(t *testing.T) {
	m, ctx := browser(t)
	s := fixture.New(fixture.Options{UnacknowledgedRename: true})
	defer s.Close()
	p, tab := newPage(t, m, ctx, s)
	events := send(t, p, ctx, "Only reply OK")
	complete := event(t, events, chatgpt.StreamComplete)
	if _, err := p.ReadReply(ctx, complete.AssistantMessageID); err != nil {
		t.Fatal(err)
	}
	// Simulate optimistic UI success even though the backend rejects the save.
	if err := tab.Evaluate(ctx, `document.querySelector('[role=dialog] form').addEventListener('submit',()=>{document.querySelector('nav a').textContent=document.querySelector('[name=title-editor]').value})`, nil); err != nil {
		t.Fatal(err)
	}
	renameCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := p.Rename(renameCtx, "1114｜EXP｜No acknowledgement"); err == nil {
		t.Fatal("optimistic sidebar accepted without 2xx acknowledgement")
	}
}

func TestDraftIsClearedOnlyWhenUnchangedAndNeverArmsSend(t *testing.T) {
	for _, editable := range []bool{false, true} {
		m, ctx := browser(t)
		s := fixture.New(fixture.Options{ContentEditable: editable})
		p, _ := newPage(t, m, ctx, s)
		if e := p.EnsureModel(ctx, "latest-pro", 1); e != nil {
			t.Fatal(e)
		}
		if e := p.RestoreDraft(ctx, "my unsent note"); e != nil {
			t.Fatal(e)
		}
		if draft, e := p.Draft(ctx); e != nil || draft != "my unsent note" {
			t.Fatalf("draft: %q %v", draft, e)
		}
		// A put-back draft is not a prompt, and a prompt never types over it.
		if _, e := p.Send(ctx); e == nil {
			t.Fatal("restored draft armed a send")
		}
		if e := p.FillComposer(ctx, "prompt"); e == nil || !strings.Contains(e.Error(), "existing draft") {
			t.Fatalf("typed over a draft: %v", e)
		}
		if e := p.ClearDraft(ctx, "another text"); e == nil || !strings.Contains(e.Error(), "draft changed") {
			t.Fatalf("cleared an unsaved draft: %v", e)
		}
		if draft, _ := p.Draft(ctx); draft != "my unsent note" {
			t.Fatalf("draft lost: %q", draft)
		}
		if e := p.ClearDraft(ctx, "my unsent note"); e != nil {
			t.Fatal(e)
		}
		if draft, e := p.Draft(ctx); e != nil || draft != "" {
			t.Fatalf("draft after clear: %q %v", draft, e)
		}
		if e := p.FillComposer(ctx, "prompt"); e != nil {
			t.Fatal(e)
		}
		if len(s.Requests()) != 0 {
			t.Fatal("draft handling sent a message")
		}
		s.Close()
	}
}
