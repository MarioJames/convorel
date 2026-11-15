// Package store defines operational truth. Implementations must preserve unknown legacy JSON fields.
package store

import (
	"context"
	"encoding/json"

	"github.com/MarioJames/convorel/internal/config"
)

type Phase string

const (
	Prepared        Phase = "prepared"
	Rejected        Phase = "rejected"
	Delivered       Phase = "delivered"
	DeliveryUnknown Phase = "delivery_unknown"
	Complete        Phase = "complete"
	Failed          Phase = "failed"
	Blocked         Phase = "blocked"
	Superseded      Phase = "superseded"
	Lost            Phase = "lost"
)

// Retry is permitted only after proof that the original send was not delivered.
func (p Phase) Retryable() bool { return p == Prepared || p == Rejected }

type DeliveryFacts struct {
	RequestUserMessageID string `json:"requestUserMessageId,omitempty"`
	RequestSent          bool   `json:"requestSent"`
	POSTStatus           int    `json:"postStatus,omitempty"`
	UserMessageID        string `json:"userMessageId,omitempty"`
	ConversationID       string `json:"conversationId,omitempty"`
	Model                string `json:"model,omitempty"`
	StreamComplete       bool   `json:"streamComplete,omitempty"`
	StreamAborted        bool   `json:"streamAborted,omitempty"`
}
type Reply struct {
	ID       string `json:"id"`
	Role     string `json:"role,omitempty"`
	Markdown string `json:"markdown"`
	Text     string `json:"text,omitempty"`
	Model    string `json:"model,omitempty"`
	Final    bool   `json:"final,omitempty"`
}
type Naming struct {
	Type     string `json:"type"`
	Topic    string `json:"topic"`
	Language string `json:"language,omitempty"`
}
type NamingState struct {
	State    string `json:"state"`
	Title    string `json:"title,omitempty"`
	Verified bool   `json:"verified"`
	Error    string `json:"error,omitempty"`
}
type Binding struct {
	Target  string `json:"target"`
	Epoch   string `json:"epoch"`
	Owned   bool   `json:"owned"`
	Closed  bool   `json:"closed,omitempty"`
	Opening bool   `json:"opening,omitempty"`
}
type Run struct {
	original       json.RawMessage
	ID             string          `json:"id"`
	RequestID      string          `json:"requestId"`
	InputHash      string          `json:"inputHash"`
	Input          string          `json:"input,omitempty"`
	PromptContext  json.RawMessage `json:"promptContext,omitempty"`
	Prompt         string          `json:"prompt"`
	PromptHash     string          `json:"promptHash"`
	Marker         string          `json:"marker"`
	State          Phase           `json:"state"`
	Delivery       DeliveryFacts   `json:"delivery,omitempty"`
	UserMessageID  string          `json:"userMessageId,omitempty"`
	Reply          *Reply          `json:"reply,omitempty"`
	ReplyHash      string          `json:"replyHash,omitempty"`
	ObservedModel  string          `json:"observedModel,omitempty"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	SubmittedAt    string          `json:"submittedAt,omitempty"`
	CompletedAt    string          `json:"completedAt,omitempty"`
	LastObservedAt string          `json:"lastObservedAt,omitempty"`
}
type Task struct {
	RuntimeVersion int `json:"runtimeVersion,omitempty"`
	// Legacy documents are normalized only in memory and are never auto-resumed.
	Legacy       bool `json:"-"`
	original     json.RawMessage
	Version      int             `json:"version"`
	ID           string          `json:"id"`
	Config       config.Config   `json:"config"`
	WorkspaceID  string          `json:"workspaceId"`
	URL          string          `json:"url,omitempty"`
	Binding      *Binding        `json:"binding,omitempty"`
	CurrentRun   string          `json:"currentRun"`
	AttemptID    string          `json:"attemptId"`
	Runs         []Run           `json:"runs"`
	Naming       *Naming         `json:"naming,omitempty"`
	NamingState  *NamingState    `json:"namingState,omitempty"`
	Organization json.RawMessage `json:"organization,omitempty"`
	Cleanup      json.RawMessage `json:"cleanup,omitempty"`
}

// CreateTask and AppendRun atomically claim explicit request IDs globally.
// The legacy default "initial" is scoped to its task. A replay with
// identical input returns its original run; different input returns REQUEST_CONFLICT.
// Transition compares the expected phase and atomically publishes the supplied run.
// Implementations must refuse transitions granting resend permission from unknown/delivered.
type Store interface {
	CreateTask(context.Context, Task) (Task, error)
	GetTask(context.Context, string) (Task, error)
	AppendRun(context.Context, string, Run) (Run, error)
	Transition(context.Context, string, string, Phase, Run) error
	// ByRequestID takes task ID then request ID, including task-scoped "initial".
	ByRequestID(context.Context, string, string) (Task, Run, error)
	List(context.Context) ([]Task, error)
	History(context.Context, string) ([]Run, error)
}
