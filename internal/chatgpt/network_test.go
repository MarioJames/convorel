package chatgpt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/convorel/internal/cdp"
)

func TestNetworkChunksAndDeltaEnvelopes(t *testing.T) {
	s := networkState{}
	params := json.RawMessage(`{"requestId":"cdp-1","request":{"url":"http://127.0.0.1/backend-api/f/conversation","method":"POST","postData":"{\"model\":\"gpt-6\",\"parent_message_id\":\"parent\",\"conversation_id\":\"conversation\",\"messages\":[{\"id\":\"user\",\"author\":{\"role\":\"user\"}}]}"}}`)
	r, ok := s.request(cdp.NetworkEvent{Method: "Network.requestWillBeSent", RequestID: "cdp-1", Params: params})
	if !ok || r.ParentMessageID != "parent" || r.UserMessageID != "user" || r.Model != "gpt-6" {
		t.Fatal(r, ok)
	}
	wire := ": keepalive\r\n\r\nevent: delta\r\ndata: {\"type\":\"delta\",\"v\":{\"type\":\"input_message\",\"conversation_id\":\"conversation\",\"message\":{\"id\":\"user\",\"author\":{\"role\":\"user\"}}}}\r\n\r\n" +
		`event: delta
 data: ignored

` + "event: delta\ndata: {\"type\":\"message\",\"message\":{\"id\":\"assistant\",\"author\":{\"role\":\"assistant\"},\"content\":{\"parts\":[\"世界 😀\"]}}}\n\n" +
		"data: {\"type\":\"message_stream_complete\"}\n\ndata: [DONE]\n\n"
	var events []SubmissionEvent
	for _, b := range []byte(wire) {
		events = append(events, s.stream([]byte{b})...)
	}
	if len(events) != 3 || events[0].Kind != InputMessage || events[1].Kind != StreamComplete || events[2].Kind != StreamDone || events[1].AssistantMessageID != "assistant" || events[1].UserMessageID != "user" {
		t.Fatalf("stream events: %+v", events)
	}
	if got := s.stream([]byte("data: {\"type\":\"message_stream_complete\"}\n\n")); len(got) != 0 {
		t.Fatalf("duplicate completion: %+v", got)
	}
}
func TestSSEMultilineAndSplitUTF8(t *testing.T) {
	var d SSEDecoder
	wire := "event: custom\r\ndata: 世界\r\ndata: 😀\r\n\r\n"
	var got []SSE
	for _, b := range []byte(wire) {
		got = append(got, d.Feed([]byte{b})...)
	}
	if len(got) != 1 || got[0].Event != "custom" || got[0].Data != "世界\n😀" {
		t.Fatalf("decoded: %+v", got)
	}
	if got = d.Feed([]byte("data: unfinished")); len(got) != 0 {
		t.Fatal(got)
	}
}
func TestTitleUsesConversationCreationTimezone(t *testing.T) {
	created := time.Date(2026, 11, 13, 23, 30, 0, 0, time.UTC)
	title, e := ConversationTitle(created, "DES", " topic ", "Asia/Shanghai", "en")
	if e != nil || title != "1114｜DES｜topic" {
		t.Fatal(title, e)
	}
	if _, e = ConversationTitle(created, "DES", "bad\nline", "UTC", "en"); e == nil {
		t.Fatal("multiline topic accepted")
	}
	if _, e = ConversationTitle(created, "DES", strings.Repeat("x", 101), "UTC", "zh"); e == nil {
		t.Fatal("long topic accepted")
	}
}

func TestProjectURLValidation(t *testing.T) {
	for _, raw := range []string{"https://chatgpt.com/g/g-p-123abc/project", "https://chatgpt.com/g/g-p-123abc-review-notes/project"} {
		if id, e := ProjectID(raw); e != nil || id != "g-p-123abc" {
			t.Fatalf("project URL %q: %q %v", raw, id, e)
		}
	}
	for _, raw := range []string{"https://chatgpt.com/g/g-p-123abc/project?foo=1", "https://chatgpt.com/g/g-p-123abc/project#other", "https://chatgpt.com.evil/g/g-p-123abc/project", "https://user@chatgpt.com/g/g-p-123abc/project", "https://chatgpt.com/c/123abc"} {
		if _, e := ProjectID(raw); e == nil {
			t.Fatalf("invalid project URL accepted: %q", raw)
		}
	}
}

func TestDOMFallbackRequiresCurrentUnambiguousTurn(t *testing.T) {
	user := Message{ID: "this-user", Role: "user"}
	reply := Message{ID: "this-reply", Role: "assistant", Final: true}
	for _, tc := range []struct {
		name       string
		messages   []Message
		generating bool
		want       string
		wantError  bool
	}{
		{"complete", []Message{user, reply}, false, reply.ID, false},
		{"not hydrated", []Message{reply}, false, "", false},
		{"still generating", []Message{user, reply}, true, "", false},
		{"later human turn", []Message{user, reply, {ID: "other-user", Role: "user"}}, false, "", true},
		{"two final replies", []Message{user, reply, {ID: "other-reply", Role: "assistant", Final: true}}, false, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id, err := finalResponse(Snapshot{Messages: tc.messages, Generating: tc.generating}, user.ID)
			if id != tc.want || (err != nil) != tc.wantError {
				t.Fatalf("final response: %q %v", id, err)
			}
		})
	}
}

func TestStreamPersistsIdentityBeforeInputEvent(t *testing.T) {
	s := networkState{}
	got := s.stream([]byte("data: {\"type\":\"conversation_detail\",\"conversation_id\":\"early-id\"}\n\n"))
	if len(got) != 1 || got[0].Kind != IdentityObserved || got[0].ConversationID != "early-id" || s.confirmed {
		t.Fatal(got)
	}
}
