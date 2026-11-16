// Package rpc implements bounded newline-delimited JSON over a private Unix socket.
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

const MaxFrameBytes = 8 << 20
const DefaultTimeout = 30 * time.Second
const Version = "1.0.1"

// readBufferBytes keeps per-connection buffering small; frames are accumulated
// and bounded explicitly in readFrame up to MaxFrameBytes.
const readBufferBytes = 64 << 10

// ErrFrameTooLarge reports a frame longer than MaxFrameBytes. The wire code is
// the error string, RPC_FRAME_TOO_LARGE.
var ErrFrameTooLarge = errors.New("RPC_FRAME_TOO_LARGE")

type Request struct {
	ID       string          `json:"id,omitempty"`
	Command  string          `json:"command"`
	Params   json.RawMessage `json:"params,omitempty"`
	Deadline time.Time       `json:"deadline,omitempty"`
	Stream   bool            `json:"stream,omitempty"`
}
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string             { return e.Code + ": " + e.Message }
func NewError(code, message string) *Error { return &Error{code, message} }

type Response struct {
	ID       string `json:"id,omitempty"`
	Result   any    `json:"result,omitempty"`
	Error    *Error `json:"error,omitempty"`
	ExitCode int    `json:"exitCode"`
	Done     bool   `json:"done"`
}

func ErrorResponse(err error) Response {
	var e *Error
	if !errors.As(err, &e) {
		e = NewError("INTERNAL_ERROR", err.Error())
		if code, message, ok := strings.Cut(err.Error(), ":"); ok && validCode(code) {
			e = NewError(code, strings.TrimSpace(message))
		}
		if validCode(err.Error()) {
			e = NewError(err.Error(), err.Error())
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			e = NewError("TIMEOUT", "request deadline exceeded")
		}
		if errors.Is(err, context.DeadlineExceeded) {
			e = NewError("TIMEOUT", "request deadline exceeded")
		}
	}
	code := 1
	if e.Code == "TIMEOUT" || e.Code == "PENDING" {
		code = 2
	}
	return Response{Error: e, ExitCode: code, Done: true}
}
func Read(r *bufio.Reader, v any) error {
	line, e := readFrame(r, MaxFrameBytes)
	if e != nil {
		return e
	}
	return json.Unmarshal(line, v)
}

// readFrame reads one newline-terminated frame without allocating a buffer the
// size of MaxFrameBytes. The payload (excluding the newline) may be at most
// max bytes; reading stops with ErrFrameTooLarge as soon as it is exceeded.
func readFrame(r *bufio.Reader, max int) ([]byte, error) {
	var frame []byte
	for {
		chunk, e := r.ReadSlice('\n')
		if len(frame)+len(chunk) > max+1 {
			return nil, ErrFrameTooLarge
		}
		frame = append(frame, chunk...)
		if errors.Is(e, bufio.ErrBufferFull) {
			continue
		}
		if e != nil {
			return nil, e
		}
		return frame, nil
	}
}

func Reader(c net.Conn) *bufio.Reader { return bufio.NewReaderSize(c, readBufferBytes) }
func Write(c net.Conn, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > MaxFrameBytes {
		return ErrFrameTooLarge
	}
	_, e = c.Write(append(b, '\n'))
	return e
}

type Client struct{ Socket string }

func (c Client) Call(ctx context.Context, req Request) (Response, error) {
	var last Response
	e := c.Stream(ctx, req, func(r Response) error { last = r; return nil })
	return last, e
}

// Stream permits progress frames internally; the CLI prints only the final frame.
// Closing a client does not cancel daemon-owned run execution.
func (c Client) Stream(ctx context.Context, req Request, receive func(Response) error) error {
	if req.Deadline.IsZero() {
		if d, ok := ctx.Deadline(); ok {
			req.Deadline = d
		} else {
			req.Deadline = time.Now().Add(DefaultTimeout)
		}
	}
	conn, e := (&net.Dialer{}).DialContext(ctx, "unix", c.Socket)
	if e != nil {
		return e
	}
	defer conn.Close()
	_ = conn.SetDeadline(req.Deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if e = Write(conn, req); e != nil {
		return e
	}
	r := Reader(conn)
	for {
		var res Response
		if e = Read(r, &res); e != nil {
			if errors.Is(e, ErrFrameTooLarge) {
				return e
			}
			return fmt.Errorf("RPC_READ_FAILED: %w", e)
		}
		if e = receive(res); e != nil {
			return e
		}
		if res.Done {
			return nil
		}
	}
}

func validCode(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}
