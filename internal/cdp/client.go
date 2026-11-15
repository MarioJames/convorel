package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/coder/websocket"
)

// Event is a raw CDP event, scoped to a flattened target session when present.
type Event struct {
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId,omitempty"`
}
type reply struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *ProtocolError  `json:"error,omitempty"`
	Event
}
type ProtocolError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *ProtocolError) Error() string { return fmt.Sprintf("CDP %d: %s", e.Code, e.Message) }

// queue keeps the websocket reader independent of slow event consumers. Events
// are never silently dropped: consumers must unsubscribe when no longer needed.
type queue[T any] struct {
	mu    sync.Mutex
	items []T
	wake  chan struct{}
	done  chan struct{}
	out   chan T
	once  sync.Once
}

func newQueue[T any]() *queue[T] {
	q := &queue[T]{wake: make(chan struct{}, 1), done: make(chan struct{}), out: make(chan T)}
	go q.run()
	return q
}
func (q *queue[T]) push(v T) {
	q.mu.Lock()
	select {
	case <-q.done:
		q.mu.Unlock()
		return
	default:
	}
	q.items = append(q.items, v)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}
func (q *queue[T]) close() { q.once.Do(func() { close(q.done) }) }
func (q *queue[T]) run() {
	defer close(q.out)
	for {
		q.mu.Lock()
		if len(q.items) == 0 {
			q.mu.Unlock()
			select {
			case <-q.done:
				return
			case <-q.wake:
			}
			continue
		}
		v := q.items[0]
		var zero T
		q.items[0] = zero
		q.items = q.items[1:]
		q.mu.Unlock()
		select {
		case <-q.done:
			return
		case q.out <- v:
		}
	}
}

type subscription struct {
	session string
	q       *queue[Event]
}
type Client struct {
	ws      *websocket.Conn
	mu      sync.Mutex
	next    uint64
	pending map[uint64]chan reply
	subs    map[*subscription]struct{}
	done    chan struct{}
	once    sync.Once
	err     error
}

func Endpoint(endpoint string) (string, error) {
	if !strings.Contains(endpoint, ":") {
		endpoint = "http://127.0.0.1:" + endpoint
	}
	u, e := url.Parse(endpoint)
	if e != nil {
		return "", e
	}
	if u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("INVALID_CDP: expected loopback HTTP endpoint")
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}
func version(ctx context.Context, endpoint string) (string, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", endpoint+"/json/version", nil)
	if e != nil {
		return "", e
	}
	h := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, e := h.Do(req)
	if e != nil {
		return "", e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return "", fmt.Errorf("CDP metadata HTTP %d", r.StatusCode)
	}
	var v struct {
		URL string `json:"webSocketDebuggerUrl"`
	}
	if e = json.NewDecoder(r.Body).Decode(&v); e != nil {
		return "", e
	}
	u, e := url.Parse(v.URL)
	if e != nil || u.Host == "" || u.Scheme != "ws" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return "", errors.New("invalid CDP websocket URL")
	}
	return v.URL, nil
}
func Dial(ctx context.Context, endpoint string) (*Client, error) {
	ep, e := Endpoint(endpoint)
	if e != nil {
		return nil, e
	}
	wsURL, e := version(ctx, ep)
	if e != nil {
		return nil, e
	}
	ws, _, e := websocket.Dial(ctx, wsURL, nil)
	if e != nil {
		return nil, e
	}
	ws.SetReadLimit(64 << 20)
	c := &Client{ws: ws, pending: map[uint64]chan reply{}, subs: map[*subscription]struct{}{}, done: make(chan struct{})}
	go c.read()
	return c, nil
}
func (c *Client) read() {
	for {
		_, b, e := c.ws.Read(context.Background())
		if e != nil {
			c.shutdown(e)
			return
		}
		var r reply
		if e = json.Unmarshal(b, &r); e != nil {
			c.shutdown(e)
			return
		}
		c.mu.Lock()
		if r.ID != 0 {
			if ch := c.pending[r.ID]; ch != nil {
				ch <- r
				delete(c.pending, r.ID)
			}
		} else {
			for s := range c.subs {
				if s.session == r.SessionID || s.session == "*" {
					s.q.push(r.Event)
				}
			}
		}
		c.mu.Unlock()
	}
}
func (c *Client) shutdown(e error) {
	c.once.Do(func() {
		c.mu.Lock()
		c.err = e
		close(c.done)
		for s := range c.subs {
			s.q.close()
		}
		c.mu.Unlock()
		c.ws.CloseNow()
	})
}
func (c *Client) Close() error          { c.shutdown(errors.New("CDP closed")); return nil }
func (c *Client) Done() <-chan struct{} { return c.done }

// Subscribe fans out events in wire order; cancel releases the subscription.
func (c *Client) Subscribe(session string) (<-chan Event, func()) {
	s := &subscription{session: session, q: newQueue[Event]()}
	c.mu.Lock()
	select {
	case <-c.done:
		s.q.close()
	default:
		c.subs[s] = struct{}{}
	}
	c.mu.Unlock()
	return s.q.out, func() { c.mu.Lock(); delete(c.subs, s); s.q.close(); c.mu.Unlock() }
}

// Call sends exactly once. Cancellation after writing is an uncertain action;
// this transport never retries commands.
func (c *Client) Call(ctx context.Context, session, method string, params, out any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	select {
	case <-c.done:
		e := c.err
		c.mu.Unlock()
		return e
	default:
	}
	c.next++
	id := c.next
	ch := make(chan reply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	b, e := json.Marshal(struct {
		ID      uint64 `json:"id"`
		Session string `json:"sessionId,omitempty"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{id, session, method, params})
	if e != nil {
		return e
	}
	if e = c.ws.Write(ctx, websocket.MessageText, b); e != nil {
		return e
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		c.mu.Lock()
		e = c.err
		c.mu.Unlock()
		return e
	case r := <-ch:
		if r.Error != nil {
			return r.Error
		}
		if out != nil {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	}
}

type Target struct {
	ID    string `json:"targetId"`
	Type  string `json:"type"`
	URL   string `json:"url"`
	Title string `json:"title"`
}

func (c *Client) Targets(ctx context.Context) ([]Target, error) {
	var r struct {
		Targets []Target `json:"targetInfos"`
	}
	e := c.Call(ctx, "", "Target.getTargets", nil, &r)
	return r.Targets, e
}
