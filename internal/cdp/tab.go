package cdp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

type PageTab struct {
	manager     *Manager
	client      *Client
	id, session string
	owned       bool
	ctx         context.Context
	cancel      context.CancelFunc
	unsubscribe func()
	responses   []NetworkResponse
	events      *queue[NetworkEvent]
	mu          sync.Mutex
	path        string
	interceptor Interceptor
	closeMu     sync.Mutex
	closed      bool
}

var _ Tab = (*PageTab)(nil)

func newTab(m *Manager, id, session string, owned bool) *PageTab {
	ctx, cancel := context.WithCancel(context.Background())
	t := &PageTab{manager: m, client: m.client, id: id, session: session, owned: owned, ctx: ctx, cancel: cancel, events: newQueue[NetworkEvent]()}
	events, unsubscribe := t.client.Subscribe(session)
	t.unsubscribe = unsubscribe
	go t.observe(events)
	return t
}
func (t *PageTab) ID() string        { return t.id }
func (t *PageTab) SessionID() string { return t.session }
func (t *PageTab) Owned() bool       { return t.owned }
func (t *PageTab) call(ctx context.Context, method string, params, out any) error {
	select {
	case <-t.ctx.Done():
		return errors.New("TAB_RELEASED")
	default:
	}
	return t.client.Call(ctx, t.session, method, params, out)
}
func (t *PageTab) Evaluate(ctx context.Context, expression string, out any) error {
	var r struct {
		Result struct {
			Value       json.RawMessage `json:"value"`
			Description string          `json:"description"`
			Subtype     string          `json:"subtype"`
		} `json:"result"`
		Exception json.RawMessage `json:"exceptionDetails"`
	}
	if e := t.call(ctx, "Runtime.evaluate", map[string]any{"expression": expression, "awaitPromise": true, "returnByValue": true}, &r); e != nil {
		return e
	}
	if len(r.Exception) > 0 {
		return fmt.Errorf("JAVASCRIPT_EXCEPTION: %s", r.Exception)
	}
	if r.Result.Subtype == "error" {
		return errors.New(r.Result.Description)
	}
	if out != nil && len(r.Result.Value) > 0 {
		return json.Unmarshal(r.Result.Value, out)
	}
	return nil
}
func (t *PageTab) InsertText(ctx context.Context, text string) error {
	return t.manager.pacing.run(ctx, false, func() error { return t.call(ctx, "Input.insertText", map[string]any{"text": text}, nil) })
}
func (t *PageTab) Click(ctx context.Context, x, y float64) error {
	return t.manager.pacing.run(ctx, false, func() error { return t.click(ctx, x, y) })
}

// ClickEvaluated locates a control after acquiring the mutation pacing lease.
// React layout changes during a queued delay cannot invalidate saved coordinates.
func (t *PageTab) ClickEvaluated(ctx context.Context, expression string) error {
	return t.manager.pacing.run(ctx, false, func() error {
		var c struct{ X, Y float64 }
		if err := t.Evaluate(ctx, expression, &c); err != nil {
			return err
		}
		return t.click(ctx, c.X, c.Y)
	})
}
func (t *PageTab) click(ctx context.Context, x, y float64) error {
	for _, kind := range []string{"mouseMoved", "mousePressed", "mouseReleased"} {
		p := map[string]any{"type": kind, "x": x, "y": y}
		if kind != "mouseMoved" {
			p["button"] = "left"
			p["clickCount"] = 1
		}
		if e := t.call(ctx, "Input.dispatchMouseEvent", p, nil); e != nil {
			return e
		}
	}
	return nil
}

// KeyPress sends one key down/up pair. modifiers is the CDP bitmask (Alt=1,
// Control=2, Meta=4, Shift=8). No action is retried on failure.
func (t *PageTab) KeyPress(ctx context.Context, key string, modifiers int) error {
	return t.manager.pacing.run(ctx, false, func() error { return t.keypress(ctx, key, modifiers) })
}
func (t *PageTab) keypress(ctx context.Context, key string, modifiers int) error {
	code := 0
	switch key {
	case "Enter":
		code = 13
	case "Tab":
		code = 9
	case "Escape":
		code = 27
	case "Backspace":
		code = 8
	case "Delete":
		code = 46
	case "ArrowLeft":
		code = 37
	case "ArrowUp":
		code = 38
	case "ArrowRight":
		code = 39
	case "ArrowDown":
		code = 40
	}
	for _, kind := range []string{"keyDown", "keyUp"} {
		p := map[string]any{"type": kind, "key": key, "modifiers": modifiers, "windowsVirtualKeyCode": code}
		if key == "Enter" && kind == "keyDown" {
			p["text"] = "\r"
		}
		if e := t.call(ctx, "Input.dispatchKeyEvent", p, nil); e != nil {
			return e
		}
	}
	return nil
}
func (t *PageTab) Navigate(ctx context.Context, rawURL string) error {
	return t.manager.pacing.run(ctx, true, func() error { return t.navigate(ctx, rawURL) })
}
func (t *PageTab) navigate(ctx context.Context, rawURL string) error {
	if err := t.call(ctx, "Network.enable", map[string]any{"maxPostDataSize": 16 << 20}, nil); err != nil {
		return err
	}
	if e := t.call(ctx, "Page.enable", nil, nil); e != nil {
		return e
	}
	if e := t.call(ctx, "Page.setLifecycleEventsEnabled", map[string]any{"enabled": true}, nil); e != nil {
		return e
	}
	events, cancel := t.client.Subscribe(t.session)
	defer cancel()
	var r struct {
		FrameID  string `json:"frameId"`
		LoaderID string `json:"loaderId"`
		Error    string `json:"errorText"`
	}
	if e := t.call(ctx, "Page.navigate", map[string]any{"url": rawURL}, &r); e != nil {
		return e
	}
	if r.Error != "" {
		return errors.New(r.Error)
	}
	if r.LoaderID == "" {
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.ctx.Done():
			return errors.New("TAB_RELEASED")
		case e, ok := <-events:
			if !ok {
				return errors.New("CDP disconnected during navigation")
			}
			if e.Method == "Page.lifecycleEvent" {
				var p struct {
					FrameID  string `json:"frameId"`
					LoaderID string `json:"loaderId"`
					Name     string `json:"name"`
				}
				if json.Unmarshal(e.Params, &p) == nil && p.FrameID == r.FrameID && p.LoaderID == r.LoaderID && p.Name == "load" {
					return nil
				}
			}
		}
	}
}
func (t *PageTab) Screenshot(ctx context.Context) ([]byte, error) {
	var r struct {
		Data string `json:"data"`
	}
	if e := t.call(ctx, "Page.captureScreenshot", map[string]any{"format": "png", "captureBeyondViewport": false}, &r); e != nil {
		return nil, e
	}
	return base64.StdEncoding.DecodeString(r.Data)
}
func (t *PageTab) NetworkEvents() <-chan NetworkEvent { return t.events.out }

// MatchURLPath excludes query strings and only matches an exact path.
func MatchURLPath(rawURL, path string) bool {
	u, e := url.Parse(rawURL)
	return e == nil && (path == "" || u.Path == path)
}
func (t *PageTab) EnableNetworkStreaming(ctx context.Context, path string) error {
	t.mu.Lock()
	t.path = path
	t.mu.Unlock()
	return t.call(ctx, "Network.enable", map[string]any{"maxPostDataSize": 16 << 20}, nil)
}
func (t *PageTab) SetInterceptor(ctx context.Context, fn Interceptor) error {
	return t.SetInterceptorPatterns(ctx, []string{"*"}, fn)
}
func (t *PageTab) SetInterceptorPatterns(ctx context.Context, patterns []string, fn Interceptor) error {
	t.mu.Lock()
	t.interceptor = fn
	t.mu.Unlock()
	if fn == nil {
		return t.call(ctx, "Fetch.disable", nil, nil)
	}
	p := make([]map[string]any, 0, len(patterns))
	for _, pattern := range patterns {
		p = append(p, map[string]any{"urlPattern": pattern, "requestStage": "Request"})
	}
	return t.call(ctx, "Fetch.enable", map[string]any{"patterns": p}, nil)
}
func (t *PageTab) intercept(e Event) {
	var p struct {
		ID      string `json:"requestId"`
		Request struct {
			URL    string `json:"url"`
			Method string `json:"method"`
			Body   string `json:"postData"`
		} `json:"request"`
	}
	if json.Unmarshal(e.Params, &p) != nil {
		return
	}
	t.mu.Lock()
	fn := t.interceptor
	t.mu.Unlock()
	ctx, cancel := context.WithTimeout(t.ctx, 30*time.Second)
	defer cancel()
	var r *InterceptResponse
	var err error
	if fn != nil {
		r, err = fn(ctx, InterceptRequest{p.ID, p.Request.URL, p.Request.Method, p.Request.Body})
	}
	method := "Fetch.continueRequest"
	params := map[string]any{"requestId": p.ID}
	if err != nil {
		method = "Fetch.failRequest"
		params["errorReason"] = "Failed"
	} else if r != nil {
		if r.FailReason != "" {
			method = "Fetch.failRequest"
			params["errorReason"] = r.FailReason
		} else {
			method = "Fetch.fulfillRequest"
			status := r.Status
			if status == 0 {
				status = 200
			}
			params["responseCode"] = status
			params["body"] = base64.StdEncoding.EncodeToString(r.Body)
			headers := make([]map[string]string, 0, len(r.Headers))
			for name, value := range r.Headers {
				headers = append(headers, map[string]string{"name": name, "value": value})
			}
			params["responseHeaders"] = headers
		}
	}
	if err = t.call(ctx, method, params, nil); err != nil {
		t.emitError("Convorel.interceptionError", p.ID, err)
	}
}
func (t *PageTab) emitError(method, requestID string, err error) {
	params, _ := json.Marshal(map[string]string{"error": err.Error()})
	t.events.push(NetworkEvent{Method: method, RequestID: requestID, Params: params})
}
func (t *PageTab) observe(events <-chan Event) {
	defer t.events.close()
	defer t.cancel()
	matched := map[string]bool{}
	methods := map[string]string{}
	for {
		select {
		case <-t.ctx.Done():
			return
		case e, ok := <-events:
			if !ok {
				return
			}
			if e.Method == "Fetch.requestPaused" {
				go t.intercept(e)
				continue
			}
			if !strings.HasPrefix(e.Method, "Network.") {
				continue
			}
			var p struct {
				ID      string `json:"requestId"`
				Data    string `json:"data"`
				Request struct {
					URL    string `json:"url"`
					Method string `json:"method"`
				} `json:"request"`
				Response struct {
					URL    string `json:"url"`
					Status int    `json:"status"`
				} `json:"response"`
			}
			if json.Unmarshal(e.Params, &p) != nil {
				continue
			}
			if e.Method == "Network.requestWillBeSent" {
				methods[p.ID] = p.Request.Method
			}
			if e.Method == "Network.responseReceived" {
				u, err := url.Parse(p.Response.URL)
				if err == nil && strings.HasPrefix(u.Path, "/backend-api/") {
					t.mu.Lock()
					t.responses = append(t.responses, NetworkResponse{RequestID: p.ID, URL: p.Response.URL, Method: methods[p.ID], Status: p.Response.Status, At: time.Now()})
					if len(t.responses) > 128 {
						t.responses = append([]NetworkResponse(nil), t.responses[len(t.responses)-128:]...)
					}
					t.mu.Unlock()
				}
				delete(methods, p.ID)
			}
			if e.Method == "Network.loadingFailed" || e.Method == "Network.loadingFinished" {
				delete(methods, p.ID)
			}
			t.mu.Lock()
			path := t.path
			t.mu.Unlock()
			if e.Method == "Network.requestWillBeSent" {
				matched[p.ID] = path != "" && MatchURLPath(p.Request.URL, path)
			}
			if e.Method == "Network.responseReceived" && !matched[p.ID] {
				matched[p.ID] = path != "" && MatchURLPath(p.Response.URL, path)
			}
			if !matched[p.ID] {
				if e.Method == "Network.loadingFinished" || e.Method == "Network.loadingFailed" {
					delete(matched, p.ID)
				}
				continue
			}
			n := NetworkEvent{Method: e.Method, Params: e.Params, RequestID: p.ID}
			if p.Data != "" {
				data, err := base64.StdEncoding.DecodeString(p.Data)
				if err != nil {
					t.emitError("Convorel.streamError", p.ID, err)
					continue
				}
				n.Data = data
			}
			t.events.push(n)
			if e.Method == "Network.responseReceived" {
				var r struct {
					Data string `json:"bufferedData"`
				}
				ctx, cancel := context.WithTimeout(t.ctx, 10*time.Second)
				err := t.call(ctx, "Network.streamResourceContent", map[string]any{"requestId": p.ID}, &r)
				cancel()
				if err != nil {
					t.emitError("Convorel.streamError", p.ID, err)
				} else if r.Data != "" {
					data, err := base64.StdEncoding.DecodeString(r.Data)
					if err != nil {
						t.emitError("Convorel.streamError", p.ID, err)
					} else {
						t.events.push(NetworkEvent{Method: "Network.streamResourceContent", RequestID: p.ID, Data: data})
					}
				}
			}
			if e.Method == "Network.loadingFinished" || e.Method == "Network.loadingFailed" {
				delete(matched, p.ID)
			}
		}
	}
}

// Release detaches this session, preserving the tab for later reattachment.
func (t *PageTab) Release(ctx context.Context) error { return t.finish(ctx, false) }

// Close destroys a created tab; on a borrowed tab it only detaches. The caller
// must check conversation identity, saved reply and empty draft before closing.
func (t *PageTab) Close(ctx context.Context) error {
	if !t.owned {
		return t.finish(ctx, false)
	}
	return t.manager.pacing.run(ctx, false, func() error { return t.finish(ctx, true) })
}
func (t *PageTab) finish(ctx context.Context, destroy bool) error {
	t.closeMu.Lock()
	defer t.closeMu.Unlock()
	if t.closed {
		return nil
	}
	m := t.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.tabs[t.id] != t {
		t.dispose()
		return nil
	}
	if destroy {
		targets, e := t.client.Targets(ctx)
		if e != nil {
			return e
		}
		pages := 0
		for _, target := range targets {
			if target.Type == "page" {
				pages++
			}
		}
		if pages <= 1 {
			if e = t.client.Call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, nil); e != nil {
				return e
			}
		}
		// The close command acknowledges before the target actually disappears.
		if e = t.client.Call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil); e != nil {
			return e
		}
		destroyed, cancel := t.client.Subscribe("")
		defer cancel()
		var r struct {
			Success bool `json:"success"`
		}
		if e = t.client.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.id}, &r); e != nil {
			return e
		}
		if !r.Success {
			return errors.New("TARGET_CLOSE_FAILED")
		}
	waitDestroyed:
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case event, ok := <-destroyed:
				if !ok {
					return errors.New("CDP disconnected while closing target")
				}
				var p struct {
					ID string `json:"targetId"`
				}
				if event.Method == "Target.targetDestroyed" && json.Unmarshal(event.Params, &p) == nil && p.ID == t.id {
					break waitDestroyed
				}
			}
		}
	} else {
		if e := t.client.Call(ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": t.session}, nil); e != nil {
			return e
		}
	}
	delete(m.tabs, t.id)
	if destroy {
		delete(m.owned, t.id)
	}
	t.dispose()
	return nil
}
func (t *PageTab) dispose() { t.closed = true; t.cancel(); t.unsubscribe(); t.events.close() }
