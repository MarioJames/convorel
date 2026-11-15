// Package cdp exposes direct Chrome transport without a browser-controller subprocess.
package cdp

import (
	"context"
	"encoding/json"
	"time"
)

type IdleInfo struct {
	Managed      bool
	Running      bool
	LastActivity time.Time
	InFlight     int
}
type Browser interface {
	EnsureStarted(context.Context) error
	Stop(context.Context) error
	IdleInfo() IdleInfo
	NewTab(context.Context, string) (Tab, error)
	AttachTab(context.Context, string) (Tab, error)
}
type NetworkEvent struct {
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	RequestID string          `json:"requestId,omitempty"`
	Data      []byte          `json:"data,omitempty"`
}
type InterceptRequest struct {
	RequestID string
	URL       string
	Method    string
	Body      string
}
type InterceptResponse struct {
	Status     int
	Headers    map[string]string
	Body       []byte
	FailReason string
}
type Interceptor func(context.Context, InterceptRequest) (*InterceptResponse, error)

// NetworkEvents includes streamResourceContent bufferedData and dataReceived.data,
// decoded in arrival order. Stream subscriptions must be enabled before sending.
type Tab interface {
	ID() string
	Evaluate(context.Context, string, any) error
	InsertText(context.Context, string) error
	Click(context.Context, float64, float64) error
	Navigate(context.Context, string) error
	NetworkEvents() <-chan NetworkEvent
	EnableNetworkStreaming(context.Context, string) error
	SetInterceptor(context.Context, Interceptor) error
	Close(context.Context) error
}
