// Package chatgpt owns unique-visible page controls and submission observations.
package chatgpt

import (
	"context"
	"github.com/MarioJames/convorel/internal/cdp"
)

type Identity struct {
	ConversationID     string `json:"conversationId"`
	URL                string `json:"url"`
	UserMessageID      string `json:"userMessageId,omitempty"`
	AssistantMessageID string `json:"assistantMessageId,omitempty"`
}
type SubmissionKind string

const (
	IdentityObserved SubmissionKind = "identity_observed"
	RequestSent      SubmissionKind = "request_sent"
	HTTPStatus       SubmissionKind = "http_status"
	InputMessage     SubmissionKind = "input_message"
	StreamComplete   SubmissionKind = "stream_complete"
	StreamAborted    SubmissionKind = "stream_aborted"
	StreamDone       SubmissionKind = "stream_done"
)

type SubmissionEvent struct {
	Kind               SubmissionKind
	RequestID          string
	ParentMessageID    string
	Status             int
	UserMessageID      string
	ConversationID     string
	AssistantMessageID string
	Model              string
	Error              string
}
type Reply struct {
	ID       string `json:"id"`
	Markdown string `json:"markdown"`
	Model    string `json:"model,omitempty"`
}
type Check struct {
	OK     bool   `json:"ok"`
	Count  int    `json:"count"`
	Detail string `json:"detail,omitempty"`
}
type SelfCheckReport struct {
	OK           bool  `json:"ok"`
	Composer     Check `json:"composer"`
	Send         Check `json:"send"`
	ModelMenu    Check `json:"modelMenu"`
	EffortSlider Check `json:"effortSlider"`
	Rename       Check `json:"rename"`
	Effort       int   `json:"effort"`
}

// Open uses projectURL's dedicated composer; Attach and VerifyIdentity never
// silently substitute a different conversation. Send observes before dispatch.
// ReadReply returns the same Markdown as the page's Copy control. Draft,
// ClearDraft and RestoreDraft move an unsent draft aside and back; none of
// them can arm a send.
type Page interface {
	Open(context.Context, string) error
	Attach(context.Context, Identity) error
	VerifyIdentity(context.Context, Identity) error
	EnsureModel(context.Context, string, int) error
	FillComposer(context.Context, string) error
	Draft(context.Context) (string, error)
	ClearDraft(context.Context, string) error
	RestoreDraft(context.Context, string) error
	Send(context.Context) (<-chan SubmissionEvent, error)
	ReadReply(context.Context, string) (Reply, error)
	Rename(context.Context, string) error
	SelfCheck(context.Context) (SelfCheckReport, error)
}
type Factory func(cdp.Tab) Page
