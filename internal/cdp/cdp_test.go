package cdp

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func browserForTest(t *testing.T) (*Manager, context.Context) {
	t.Helper()
	if _, e := os.Stat("/usr/bin/google-chrome"); e != nil {
		t.Skip("headless Chrome absent: /usr/bin/google-chrome")
	}
	// Isolate the Chrome wrapper's XDG files as well as the browser profile.
	isolatedHome := t.TempDir()
	t.Setenv("HOME", isolatedHome)
	t.Setenv("XDG_CONFIG_HOME", isolatedHome+"/config")
	t.Setenv("XDG_CACHE_HOME", isolatedHome+"/cache")
	t.Setenv("XDG_DATA_HOME", isolatedHome+"/data")
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	endpoint := "http://" + l.Addr().String()
	_ = l.Close()
	m, e := New(Options{ActionInterval: -1, NavigationWait: -1, Mode: "managed", Endpoint: endpoint, Executable: "/usr/bin/google-chrome", UserDataDir: t.TempDir(), Headless: true, ExtraArgs: []string{"--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"}, StartupTimeout: 60 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(func() {
		cancel()
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
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
func page(t *testing.T, m *Manager, ctx context.Context) *PageTab {
	t.Helper()
	tab, e := m.NewTab(ctx, "about:blank")
	if e != nil {
		t.Fatal(e)
	}
	return tab.(*PageTab)
}
func eval(t *testing.T, tab *PageTab, ctx context.Context, expression string, out any) {
	t.Helper()
	if e := tab.Evaluate(ctx, expression, out); e != nil {
		t.Fatal(e)
	}
}

func TestChromeLifecycleAndActions(t *testing.T) {
	m, ctx := browserForTest(t)
	initialPID := m.process.Process.Pid
	initial := m.client
	if e := m.Ensure(ctx); e != nil || m.process.Process.Pid != initialPID || m.client != initial {
		t.Fatalf("ensure launched twice: %v", e)
	}
	// A second manager may attach, but must never stop the first's Chrome.
	other, e := New(m.opts)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = other.Stop(context.Background()) })
	if e = other.Ensure(ctx); e != nil {
		t.Fatal(e)
	}
	if other.process != nil {
		t.Fatal("second manager launched Chrome")
	}
	if e = other.Stop(ctx); e != nil {
		t.Fatal(e)
	}
	var version map[string]any
	if e = m.client.Call(ctx, "", "Browser.getVersion", nil, &version); e != nil {
		t.Fatalf("attacher stopped original: %v", e)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<textarea style="position:absolute;left:10px;top:10px;width:200px;height:80px"></textarea><button style="position:absolute;left:10px;top:120px;width:100px;height:40px" onclick="window.clicked=true">Click</button>`)
	}))
	defer server.Close()
	tab := page(t, m, ctx)
	if e = tab.Navigate(ctx, server.URL); e != nil {
		t.Fatal(e)
	}
	var n int
	eval(t, tab, ctx, "Promise.resolve(42)", &n)
	if n != 42 {
		t.Fatal(n)
	}
	if e = tab.Click(ctx, 50, 30); e != nil {
		t.Fatal(e)
	}
	if e = tab.InsertText(ctx, "hello 世界"); e != nil {
		t.Fatal(e)
	}
	if e = tab.KeyPress(ctx, "Enter", 0); e != nil {
		t.Fatal(e)
	}
	var text string
	eval(t, tab, ctx, "document.querySelector('textarea').value", &text)
	if text != "hello 世界\n" {
		t.Fatalf("text=%q", text)
	}
	if e = tab.Click(ctx, 50, 140); e != nil {
		t.Fatal(e)
	}
	var clicked bool
	eval(t, tab, ctx, "window.clicked", &clicked)
	if !clicked {
		t.Fatal("click did not fire")
	}
	// Layout moves while this click waits for the pacing lease.
	eval(t, tab, ctx, `(()=>{window.clicked=false;setTimeout(()=>document.querySelector('button').style.top='300px',30);return true})()`, nil)
	m.pacing.next = time.Now().Add(100 * time.Millisecond)
	if err := tab.ClickEvaluated(ctx, `(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); err != nil {
		t.Fatal(err)
	}
	eval(t, tab, ctx, "window.clicked", &clicked)
	if !clicked {
		t.Fatal("queued click used stale coordinates")
	}
	png, e := tab.Screenshot(ctx)
	if e != nil || len(png) < 8 || string(png[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("screenshot: %v", e)
	}
	if e = tab.Evaluate(ctx, "throw new Error('fixture')", nil); e == nil {
		t.Fatal("JS error lost")
	}
	id := tab.ID()
	if e = tab.Release(ctx); e != nil {
		t.Fatal(e)
	}
	again, e := m.AttachTab(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if !again.(*PageTab).Owned() {
		t.Fatal("lost ownership on session release")
	}
	if e = again.Close(ctx); e != nil {
		t.Fatal(e)
	}
	targets, e := m.Targets(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, target := range targets {
		if target.ID == id {
			t.Fatal("owned tab left open")
		}
	}
	// Bind a preexisting tab; close must leave it intact.
	var borrowedID string
	for _, target := range targets {
		if target.Type == "page" {
			borrowedID = target.ID
			break
		}
	}
	borrowed, e := m.AttachTab(ctx, borrowedID)
	if e != nil {
		t.Fatal(e)
	}
	if e = borrowed.Close(ctx); e != nil {
		t.Fatal(e)
	}
	targets, e = m.Targets(ctx)
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, target := range targets {
		found = found || target.ID == borrowedID
	}
	if !found {
		t.Fatal("borrowed tab was destroyed")
	}
	// Last owned tab closure creates a keepalive rather than closing Chrome.
	for _, target := range targets {
		if target.Type == "page" {
			if e = m.client.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": target.ID}, nil); e != nil {
				t.Fatal(e)
			}
		}
	}
	last := page(t, m, ctx)
	if e = last.Close(ctx); e != nil {
		t.Fatal(e)
	}
	targets, e = m.Targets(ctx)
	if e != nil || len(targets) == 0 {
		t.Fatalf("keepalive missing: %v", e)
	}
	// Idle stop cannot happen while a reply is pending, and Ensure relaunches.
	now := time.Unix(1000, 0)
	idle := NewIdle(time.Minute, func() time.Time { return now }, m.Stop)
	release := idle.Begin()
	now = now.Add(2 * time.Minute)
	if e = idle.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if m.process == nil {
		t.Fatal("idle stopped in-flight run")
	}
	release()
	release()
	now = now.Add(time.Minute)
	if e = idle.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	if m.process != nil || m.IdleInfo().Running {
		t.Fatal("idle did not stop Chrome")
	}
	if e = m.Ensure(ctx); e != nil {
		t.Fatal(e)
	}
	if m.process.Process.Pid == initialPID {
		t.Fatal("did not relaunch")
	}
}

func TestStreamingAbortedPOSTAndFetch403(t *testing.T) {
	m, ctx := browserForTest(t)
	tab := page(t, m, ctx)
	streamCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	posts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stream" {
			mu.Lock()
			posts++
			mu.Unlock()
			w.Header().Set("Content-Type", "text/event-stream")
			f := w.(http.Flusher)
			for _, chunk := range []string{"data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"} {
				fmt.Fprint(w, chunk)
				f.Flush()
				select {
				case <-r.Context().Done():
					return
				case <-time.After(60 * time.Millisecond):
				}
			}
			select {
			case <-r.Context().Done():
			case <-streamCtx.Done():
			}
			return
		}
		if r.URL.Path == "/reject" {
			t.Error("interception reached server")
		}
		fmt.Fprint(w, "<textarea></textarea>")
	}))
	defer server.Close()
	if e := tab.Navigate(ctx, server.URL); e != nil {
		t.Fatal(e)
	}
	if e := tab.EnableNetworkStreaming(ctx, "/stream"); e != nil {
		t.Fatal(e)
	}
	eval(t, tab, ctx, `(()=>{window.streamDone=false; const c=new AbortController(); fetch('/stream',{method:'POST',body:'original prompt',signal:c.signal}).then(async r=>{const reader=r.body.getReader();let all='';try{for(;;){const v=await reader.read();if(v.done)break;all+=new TextDecoder().decode(v.value);if(all.includes('[DONE]')){c.abort();break}}}finally{window.streamDone=true}});return true})()`, nil)
	var body strings.Builder
	request, failed, status := false, false, 0
	for !failed {
		select {
		case <-ctx.Done():
			t.Fatalf("stream timeout: body=%q", body.String())
		case e, ok := <-tab.NetworkEvents():
			if !ok {
				t.Fatal("event stream closed")
			}
			if e.Method == "Convorel.streamError" {
				t.Fatalf("stream subscription failed: %s", e.Params)
			}
			body.Write(e.Data)
			switch e.Method {
			case "Network.requestWillBeSent":
				var p struct {
					Request struct {
						Method string `json:"method"`
						Body   string `json:"postData"`
					} `json:"request"`
				}
				if err := json.Unmarshal(e.Params, &p); err != nil {
					t.Fatal(err)
				}
				request = p.Request.Method == "POST" && p.Request.Body == "original prompt"
			case "Network.responseReceived":
				var p struct {
					Response struct {
						Status int `json:"status"`
					} `json:"response"`
				}
				if err := json.Unmarshal(e.Params, &p); err != nil {
					t.Fatal(err)
				}
				status = p.Response.Status
			case "Network.loadingFailed":
				var p struct {
					Error string `json:"errorText"`
				}
				_ = json.Unmarshal(e.Params, &p)
				if p.Error != "net::ERR_ABORTED" {
					t.Fatalf("failure=%q", p.Error)
				}
				failed = true
			}
		}
	}
	if body.String() != "data: one\n\ndata: two\n\ndata: [DONE]\n\n" || !request || status != 200 {
		t.Fatalf("body=%q request=%v status=%d", body.String(), request, status)
	}
	mu.Lock()
	count := posts
	mu.Unlock()
	if count != 1 {
		t.Fatalf("POST sent %d times", count)
	}
	if e := tab.SetInterceptorPatterns(ctx, []string{"*/reject"}, func(ctx context.Context, r InterceptRequest) (*InterceptResponse, error) {
		if r.Method != "POST" {
			return nil, fmt.Errorf("unexpected method %s", r.Method)
		}
		return &InterceptResponse{Status: 403, Headers: map[string]string{"Content-Type": "text/plain"}, Body: []byte("denied")}, nil
	}); e != nil {
		t.Fatal(e)
	}
	var response struct {
		Status int    `json:"status"`
		Text   string `json:"text"`
	}
	eval(t, tab, ctx, `fetch('/reject',{method:'POST',body:'test'}).then(async r=>({status:r.status,text:await r.text()}))`, &response)
	if response.Status != 403 || response.Text != "denied" {
		t.Fatalf("interception=%+v", response)
	}
	if e := tab.SetInterceptor(ctx, nil); e != nil {
		t.Fatal(e)
	}
}

func TestManagedRefusesOtherProfile(t *testing.T) {
	m, ctx := browserForTest(t)
	opts := m.opts
	opts.UserDataDir = t.TempDir()
	other, e := New(opts)
	if e != nil {
		t.Fatal(e)
	}
	if e = other.Ensure(ctx); e == nil || !strings.Contains(e.Error(), "PORT_IN_USE") {
		t.Fatalf("foreign profile accepted: %v", e)
	}
	if other.process != nil {
		t.Fatal("launched on occupied port")
	}
}

func TestProtocolCancellationFanoutAndClose(t *testing.T) {
	m, ctx := browserForTest(t)
	tab := page(t, m, ctx)
	first, cancelFirst := m.client.Subscribe(tab.SessionID())
	defer cancelFirst()
	second, cancelSecond := m.client.Subscribe(tab.SessionID())
	defer cancelSecond()
	if e := tab.call(ctx, "Runtime.enable", nil, nil); e != nil {
		t.Fatal(e)
	}
	for _, events := range []<-chan Event{first, second} {
		select {
		case event := <-events:
			if event.Method != "Runtime.executionContextCreated" {
				t.Fatal(event.Method)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	pending, stop := context.WithCancel(ctx)
	result := make(chan error, 1)
	ready, unsubscribe := m.client.Subscribe(tab.SessionID())
	defer unsubscribe()
	go func() { result <- tab.Evaluate(pending, "new Promise(()=>{console.log('pending')})", nil) }()
waitReady:
	for {
		select {
		case e := <-ready:
			if e.Method == "Runtime.consoleAPICalled" {
				break waitReady
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	stop()
	select {
	case e := <-result:
		if e == nil {
			t.Fatal("cancelled evaluation succeeded")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Cancellation of a command awaiting its reply must leave other commands usable.
	var value int
	eval(t, tab, ctx, "41+1", &value)
	if value != 42 {
		t.Fatal(value)
	}
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func(want int) {
			defer group.Done()
			var got int
			if e := tab.Evaluate(ctx, fmt.Sprint(want), &got); e != nil || got != want {
				t.Errorf("concurrent response got=%d want=%d err=%v", got, want, e)
			}
		}(i)
	}
	group.Wait()
	if e := tab.call(ctx, "NoSuchDomain.noSuchMethod", nil, nil); e == nil {
		t.Fatal("protocol error lost")
	}
	blocked := make(chan error, 1)
	go func() { blocked <- tab.Evaluate(ctx, "new Promise(()=>{})", nil) }()
	if e := m.client.Close(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-blocked:
		if e == nil {
			t.Fatal("close did not fail pending command")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestFetchFailAndContinue(t *testing.T) {
	m, ctx := browserForTest(t)
	tab := page(t, m, ctx)
	var mu sync.Mutex
	paths := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths[r.URL.Path]++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "ok")
	}))
	defer server.Close()
	if e := tab.Navigate(ctx, server.URL); e != nil {
		t.Fatal(e)
	}
	if e := tab.SetInterceptorPatterns(ctx, []string{"*/fail", "*/pass"}, func(_ context.Context, r InterceptRequest) (*InterceptResponse, error) {
		if strings.HasSuffix(r.URL, "/fail") {
			return &InterceptResponse{FailReason: "BlockedByClient"}, nil
		}
		return nil, nil
	}); e != nil {
		t.Fatal(e)
	}
	var failed bool
	eval(t, tab, ctx, `fetch('/fail').then(()=>false,()=>true)`, &failed)
	if !failed {
		t.Fatal("Fetch.failRequest did not fail request")
	}
	var text string
	eval(t, tab, ctx, `fetch('/pass').then(r=>r.text())`, &text)
	if text != "ok" {
		t.Fatalf("continue response=%q", text)
	}
	mu.Lock()
	defer mu.Unlock()
	if paths["/fail"] != 0 || paths["/pass"] != 1 {
		t.Fatalf("server requests=%v", paths)
	}
}

func TestQueuedActionCancellation(t *testing.T) {
	p := newPacing(-1, -1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- p.run(context.Background(), false, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	queued := make(chan error, 1)
	go func() {
		queued <- p.run(ctx, false, func() error { t.Error("cancelled queued action dispatched"); return nil })
	}()
	cancel()
	if err := <-queued; err != context.Canceled {
		t.Fatalf("queued action error=%v", err)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	ran := false
	if err := p.run(context.Background(), false, func() error { ran = true; return nil }); err != nil || !ran {
		t.Fatalf("lease not released: %v", err)
	}
}
