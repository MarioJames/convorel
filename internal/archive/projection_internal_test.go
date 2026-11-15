package archive

import (
	"testing"

	"github.com/MarioJames/convorel/internal/store"
)

// Fingerprints written by 0.9 must keep comparing equal; coverage reads them
// directly. The expected strings are JSON.stringify output, including key order and
// the use of null for absent optional fields.
func TestFingerprintMatchesLegacyJSON(t *testing.T) {
	remote := "abc-123"
	run := store.Run{
		ID:            "r1",
		PromptHash:    "ph",
		UserMessageID: "u1",
		ReplyHash:     "rh",
		Reply:         &store.Reply{ID: "m1"},
	}
	want := shaHex(`{"version":1,"taskId":"review","runId":"r1","remoteId":"abc-123","promptHash":"ph","userMessageId":"u1","replyId":"m1","renderedHash":"rh"}`)
	if got := runContentFingerprint("review", &remote, run); got != want {
		t.Fatalf("with values: %s != %s", got, want)
	}
	empty := store.Run{ID: "r2"}
	want = shaHex(`{"version":1,"taskId":"task","runId":"r2","remoteId":null,"promptHash":null,"userMessageId":null,"replyId":null,"renderedHash":null}`)
	if got := runContentFingerprint("task", nil, empty); got != want {
		t.Fatalf("absent values: %s != %s", got, want)
	}
	// Quotes and non-ASCII text must use JSON.stringify's escaping, not Go's HTML
	// escaping or a different unicode encoding.
	run = store.Run{ID: "r3", PromptHash: `a"<b>`}
	want = shaHex(`{"version":1,"taskId":"任务","runId":"r3","remoteId":null,"promptHash":"a\"<b>","userMessageId":null,"replyId":null,"renderedHash":null}`)
	if got := runContentFingerprint("任务", nil, run); got != want {
		t.Fatalf("escaped values: %s != %s", got, want)
	}
}
