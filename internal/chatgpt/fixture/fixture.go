// Package fixture serves a local ChatGPT-shaped page and SSE endpoint for
// disposable-browser integration tests. It never connects to ChatGPT.
package fixture

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Markdown = "# Fixture reply\n\n**OK** — source markdown.\n\n```go\nfmt.Println(\"OK\")\n```"
const ConversationID = "fixture-conversation"
const AssistantMessageID = "fixture-assistant"

type Options struct {
	ListDelay             time.Duration
	StaleSidebar          bool
	WrappedOptions        bool
	UnacknowledgedRename  bool
	BeforeInputDelay      time.Duration
	RequirePageAuth       bool
	OmitInputIdentity     bool
	Forbidden             bool
	CutBeforeInputMessage bool
	MissingSendButton     bool
	SlowReply             time.Duration
	HiddenExtraForm       bool
	OmitStreamComplete    bool
	ContentEditable       bool
	Markdown              string
	ProjectID             string
}
type Request struct{ UserMessageID, ConversationID, ParentMessageID, Model, Prompt string }
type Server struct {
	*httptest.Server
	mu       sync.Mutex
	options  Options
	requests []Request
	title    string
	created  float64
}

func New(options Options) *Server {
	if options.Markdown == "" {
		options.Markdown = Markdown
	}
	s := &Server{options: options, title: "Fixture chat", created: 1794661200}
	if options.BeforeInputDelay > 0 {
		s.created = float64(time.Now().UnixNano()) / 1e9
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}
func (s *Server) SetOptions(options Options) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if options.Markdown == "" {
		options.Markdown = Markdown
	}
	s.options = options
}
func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	o := s.options
	s.mu.Unlock()
	switch {
	case r.URL.Path == "/backend-api/f/conversation" && r.Method == "POST":
		var body struct {
			ConversationID string `json:"conversation_id"`
			Parent         string `json:"parent_message_id"`
			Model          string
			Messages       []struct {
				ID      string
				Content struct{ Parts []string }
			}
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Messages) != 1 {
			http.Error(w, "invalid fixture request", 400)
			return
		}
		user := body.Messages[0].ID
		s.mu.Lock()
		s.requests = append(s.requests, Request{user, body.ConversationID, body.Parent, body.Model, strings.Join(body.Messages[0].Content.Parts, "")})
		turn := len(s.requests)
		if turn == 1 && o.BeforeInputDelay > 0 {
			s.created = float64(time.Now().UnixNano()) / 1e9
		}
		s.mu.Unlock()
		assistant := AssistantMessageID
		if turn > 1 {
			assistant += "-" + strconv.Itoa(turn)
		}
		if o.Forbidden {
			http.Error(w, "forbidden", 403)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		f := w.(http.Flusher)
		send := func(event string, value any) {
			b, _ := json.Marshal(value)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
			f.Flush()
		}
		send("delta_encoding", map[string]any{"type": "delta", "v": 0})
		if o.CutBeforeInputMessage { // Abrupt transport close after HTTP 200, before confirmation.
			if h, ok := w.(http.Hijacker); ok {
				c, _, e := h.Hijack()
				if e == nil {
					_ = c.Close()
				}
			}
			return
		}
		if o.BeforeInputDelay > 0 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(o.BeforeInputDelay):
			}
		}
		send("delta", map[string]any{"type": "resume_conversation_token", "token": "fixture-resume"})
		if o.OmitInputIdentity {
			send("delta", map[string]any{"type": "input_message"})
		} else {
			send("delta", map[string]any{"type": "input_message", "conversation_id": ConversationID, "message": map[string]any{"id": user, "author": map[string]string{"role": "user"}}})
		}
		msg := map[string]any{"type": "message", "message": map[string]any{"id": assistant, "author": map[string]string{"role": "assistant"}, "status": "in_progress", "end_turn": false}}
		if !o.OmitInputIdentity {
			msg["conversation_id"] = ConversationID
		}
		send("delta", msg)
		delay := o.SlowReply
		if delay < 60*time.Millisecond {
			delay = 60 * time.Millisecond
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(delay):
		}
		if !o.OmitStreamComplete {
			send("delta", map[string]any{"type": "message_stream_complete", "conversation_id": ConversationID, "message_id": assistant})
		} else {
			send("delta", map[string]any{"type": "message", "conversation_id": ConversationID, "message": map[string]any{"id": assistant, "author": map[string]string{"role": "assistant"}, "status": "finished_successfully", "end_turn": true}})
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		f.Flush()
		// Leave the socket live briefly so Network.streamResourceContent can subscribe
		// even on fast loopback responses.
		select {
		case <-r.Context().Done():
		case <-time.After(120 * time.Millisecond):
		}
	case r.URL.Path == "/backend-api/conversations" || strings.HasSuffix(r.URL.Path, "/conversations") && strings.HasPrefix(r.URL.Path, "/backend-api/gizmos/"):
		if o.ListDelay > 0 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(o.ListDelay):
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"id": ConversationID, "create_time": time.Unix(0, int64(s.created*1e9)).UTC().Format(time.RFC3339Nano)}}})
	case strings.HasPrefix(r.URL.Path, "/backend-api/conversations/") || strings.HasPrefix(r.URL.Path, "/backend-api/conversation/"):
		if o.RequirePageAuth && r.Header.Get("Authorization") != "Bearer fixture-app-only" {
			http.Error(w, "not found", 404)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "PATCH" {
			var body struct{ Title string }
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				http.Error(w, "invalid", 400)
				return
			}
			s.title = body.Title
			if o.UnacknowledgedRename {
				http.Error(w, "save not acknowledged", 500)
				return
			}
		}
		var project any
		if o.ProjectID != "" {
			project = o.ProjectID
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"conversation_id": ConversationID, "title": s.title, "create_time": s.created, "gizmo_id": project, "is_archived": false, "is_starred": nil, "pinned_time": nil})
	default:
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		markdown, _ := json.Marshal(o.Markdown)
		hidden := ""
		if o.HiddenExtraForm {
			hidden = `<form data-chatgpt-composer style="display:none"><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></form>`
		}
		send := `<button type="button" data-testid="send-button" aria-label="Send">Send</button>`
		if o.MissingSendButton {
			send = ""
		}
		composer := `<textarea id="prompt-textarea"></textarea>`
		if o.ContentEditable {
			composer = `<div id="prompt-textarea" data-composer-markdown role="textbox" contenteditable="true" style="width:500px;min-height:100px;white-space:pre-wrap;border:1px solid"></div>`
		}
		html := strings.NewReplacer("{{HIDDEN}}", hidden, "{{SEND}}", send, "{{MARKDOWN}}", string(markdown), "{{COMPOSER}}", composer).Replace(pageHTML)
		if o.StaleSidebar && !strings.Contains(r.URL.Path, "/c/") {
			html = strings.Replace(html, `href="/c/fixture-conversation"`, `href="/c/stale-before-hydration"`, 1)
		}
		if o.WrappedOptions {
			html = strings.Replace(html, `<button id="conversation-options-fixture-conversation"`, `<div class="actions"><button id="conversation-options-fixture-conversation"`, 1)
			html = strings.Replace(html, `>Options</button>`, `>Options</button></div>`, 1)
		}
		if o.OmitInputIdentity {
			html = strings.ReplaceAll(html, `author:{role:'user'}`, `author:{role:'prepared'}`)
		}
		s.mu.Lock()
		var turns []map[string]string
		if strings.Contains(r.URL.Path, "/c/") {
			for i, req := range s.requests {
				if o.Forbidden {
					continue
				}
				assistant := AssistantMessageID
				if i > 0 {
					assistant += "-" + strconv.Itoa(i+1)
				}
				turns = append(turns, map[string]string{"user": req.UserMessageID, "prompt": req.Prompt, "assistant": assistant})
			}
		}
		s.mu.Unlock()
		data, _ := json.Marshal(turns)
		html = strings.Replace(html, "{{TURNS}}", string(data), 1)
		fmt.Fprint(w, html)
	}
}

const pageHTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif}textarea{width:500px;height:100px}[role=menu]{padding:20px;border:1px solid} [role=slider]{display:block;width:240px;height:30px;background:#ddd} [hidden]{display:none!important}</style></head><body>
<nav><div data-conversation-id="fixture-conversation"><a data-sidebar-item href="/c/fixture-conversation">Fixture chat</a><button id="conversation-options-fixture-conversation" data-testid="conversation-options-button" aria-haspopup="menu">Options</button></div></nav>
<main>{{HIDDEN}}<div id="messages"></div><form data-chatgpt-composer>{{COMPOSER}}{{SEND}}<button id="model-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Select model">Thinking effort Instant</button></form></main>
<div role="menu" id="model-menu" aria-labelledby="model-trigger" hidden><div data-model-picker-view data-explicit-model="false"><button data-model-picker-view-toggle="true" role="menuitem" aria-expanded="false">Select model</button><div id="simple"><div role="menuitem" tabindex="0" data-reasoning-slider="true" aria-describedby="power-description"><div role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0" aria-describedby="power-description"></div></div><p id="power-description">Instant, 1 of 5. Use Left and Right arrow keys to adjust power</p></div><div id="advanced" hidden><button role="menuitemradio" aria-checked="true">GPT-6</button><button role="menuitemradio" aria-checked="false">Pro</button></div></div></div>
<div id="options-menu" role="menu" aria-labelledby="conversation-options-fixture-conversation" hidden><button role="menuitem">Rename</button></div>
<div role="dialog" aria-modal="true" hidden><form><input name="title-editor"><button type="submit">Save</button></form></div>
<script>
const markdown={{MARKDOWN}};window.fixtureMarkdown=markdown;
const $=s=>document.querySelector(s), menu=$('#model-menu'), slider=$('[role=slider]'), trigger=$('#model-trigger');
const composer=$('main form:not([style]) textarea, main form:not([style]) [role=textbox]');
// Like ChatGPT, an unsent draft is kept per composer (new conversation or the
// open one) in the browser profile and shown again by every later page load.
const draftKey=()=>'fixture-draft:'+(location.pathname.includes('/c/')?'c':'new'), readDraft=()=>'value' in composer?composer.value:composer.innerText, savedDraft=localStorage.getItem(draftKey());
if(savedDraft){if('value' in composer)composer.value=savedDraft;else composer.textContent=savedDraft}
composer.addEventListener('input',()=>{const v=readDraft();if(v)localStorage.setItem(draftKey(),v);else localStorage.removeItem(draftKey())});
function escapeHTML(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function showReply(id){if(document.getElementById('reply-'+id))return;$('#messages').insertAdjacentHTML('beforeend','<article id="reply-'+id+'" data-turn="assistant" data-testid="conversation-turn-'+id+'"><div data-message-author-role="assistant" data-message-id="'+id+'" data-message-model-slug="gpt-6"><div class="markdown">Fixture reply\nOK — rendered text</div></div><div class="turn-action-controls"><button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button></div></article>');document.getElementById('reply-'+id).querySelector('button').onclick=()=>navigator.clipboard.writeText(markdown)}
function updatePower(value){slider.setAttribute('aria-valuenow',value);const label=['Instant','Light','Standard','High','Pro'][value];$('#power-description').textContent=label+', '+(value+1)+' of 5. Use Left and Right arrow keys to adjust power';trigger.textContent='Thinking effort '+label}
trigger.onclick=()=>{menu.hidden=!menu.hidden;trigger.setAttribute('aria-expanded',String(!menu.hidden))};
$('[data-model-picker-view-toggle]').onclick=()=>{const simple=$('#simple'),advanced=$('#advanced');simple.hidden=!simple.hidden;advanced.hidden=!advanced.hidden};
slider.parentElement.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();updatePower(Math.max(0,Math.min(4,Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1))))}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;trigger.setAttribute('aria-expanded','false');$('#options-menu').hidden=true}});
$('#conversation-options-fixture-conversation').onclick=()=>{$('#options-menu').hidden=!$('#options-menu').hidden};
$('#options-menu button').onclick=()=>{$('[role=dialog]').hidden=false;$('[name=title-editor]').value=$('nav a').textContent;$('#options-menu').hidden=true};
$('[role=dialog] form').onsubmit=async e=>{e.preventDefault();const title=$('[name=title-editor]').value;const r=await fetch('/backend-api/conversation/fixture-conversation',{method:'PATCH',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-app-only'},body:JSON.stringify({title})});if(r.ok){$('nav a').textContent=title;$('[role=dialog]').hidden=true}};
const savedTurns={{TURNS}}||[];
for(const turn of savedTurns){$('#messages').insertAdjacentHTML('beforeend','<div data-message-author-role="user" data-message-id="'+turn.user+'">'+escapeHTML(turn.prompt)+'</div>');showReply(turn.assistant)}
if(location.pathname.includes('/c/'))fetch('/backend-api/conversation/fixture-conversation',{headers:{Authorization:'Bearer fixture-app-only'}}).then(r=>r.json()).then(m=>{$('nav a').textContent=m.title});
else fetch(location.pathname.startsWith('/g/')?'/backend-api/gizmos/'+location.pathname.split('/')[2]+'/conversations?offset=0&limit=5':'/backend-api/conversations?offset=0&limit=5');
const send=$('main form:not([style]) [data-testid=send-button]');
if(send)send.onclick=async()=>{const prompt='value' in composer?composer.value:Array.from(composer.childNodes).map(n=>n.nodeType===Node.TEXT_NODE?n.textContent:n.innerHTML==='<br>'?'':n.innerText).join('\n'),user=crypto.randomUUID();if('value' in composer)composer.value='';else composer.replaceChildren();localStorage.removeItem(draftKey());const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.body.append(stop);const body={action:'next',model:'gpt-6',parent_message_id:Array.from(document.querySelectorAll('[data-message-author-role=assistant]')).at(-1)?.getAttribute('data-message-id')||'fixture-parent',messages:[{id:user,author:{role:'user'},content:{content_type:'text',parts:[prompt]}}]};if(location.pathname.includes('/c/'))body.conversation_id='fixture-conversation';try{const r=await fetch('/backend-api/f/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)return;const reader=r.body.getReader();let text='',responseID='';for(;;){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);if(text.includes('input_message')&&!$('[data-message-id="'+user+'"]')){$('#messages').insertAdjacentHTML('beforeend','<div data-message-author-role="user" data-message-id="'+user+'">'+escapeHTML(prompt)+'</div>');history.replaceState(null,'','/c/fixture-conversation')};for(const frame of text.split('\n\n')){const line=frame.split('\n').find(s=>s.startsWith('data: '));if(!line)continue;try{const data=JSON.parse(line.slice(6));if(data.message?.author?.role==='assistant')responseID=data.message.id;if(data.type==='message_stream_complete')responseID=data.message_id||responseID}catch{}};if((text.includes('message_stream_complete')||text.includes('finished_successfully'))&&responseID)showReply(responseID)}}catch(e){window.fixtureError=String(e)}finally{stop.remove()}};

</script></body></html>`
