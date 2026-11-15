package chatgpt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/MarioJames/convorel/internal/cdp"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ConversationMetadata comes from a fresh, identity-checked server read. Naming
// uses CreatedAt rather than the local task's creation time.
type ConversationMetadata struct {
	ConversationID string
	Title          string
	CreatedAt      time.Time
	ProjectID      string
	Archived       bool
	Starred        *bool
	PinnedTime     json.RawMessage
}

func (p *BrowserPage) Metadata(ctx context.Context) (ConversationMetadata, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.metadata(ctx)
}

type responseReader interface {
	Responses() []cdp.NetworkResponse
	ResponseBody(context.Context, string) ([]byte, error)
}

// metadata reloads only this conversation and observes the authenticated GET
// issued by the application. It never constructs a backend fetch or reads auth.
func (p *BrowserPage) metadata(ctx context.Context) (ConversationMetadata, error) {
	return p.readMetadata(ctx, time.Time{}, true)
}
func (p *BrowserPage) readMetadata(ctx context.Context, since time.Time, reload bool) (ConversationMetadata, error) {
	var before Snapshot
	if err := p.eval(ctx, "snapshot", nil, &before); err != nil {
		return ConversationMetadata{}, err
	}
	id := before.ConversationID
	if id == "" || strings.HasPrefix(id, "local-") {
		return ConversationMetadata{}, errors.New("metadata: server identity missing")
	}
	reader, ok := p.tab.(responseReader)
	if !ok {
		return ConversationMetadata{}, errors.New("metadata: network response reader unavailable")
	}
	if reload {
		since = time.Now()
		var reloadErr error
		if reload, ok := p.tab.(interface{ Reload(context.Context) error }); ok {
			reloadErr = reload.Reload(ctx)
		} else {
			reloadErr = p.tab.Navigate(ctx, before.URL)
		}
		if reloadErr != nil {
			return ConversationMetadata{}, reloadErr
		}
	}
	for {
		for _, r := range reader.Responses() {
			u, e := url.Parse(r.URL)
			if e != nil || r.At.Before(since) || r.Method != "GET" || r.Status != 200 || (u.Path != "/backend-api/conversation/"+id && u.Path != "/backend-api/conversations/"+id) {
				continue
			}
			body, err := reader.ResponseBody(ctx, r.RequestID)
			if err != nil {
				continue
			}
			var raw struct {
				ID         string          `json:"conversation_id"`
				Title      *string         `json:"title"`
				Created    float64         `json:"create_time"`
				Project    string          `json:"gizmo_id"`
				Archived   *bool           `json:"is_archived"`
				Starred    *bool           `json:"is_starred"`
				PinnedTime json.RawMessage `json:"pinned_time"`
			}
			if json.Unmarshal(body, &raw) != nil || raw.ID != id || raw.Title == nil || raw.Created <= 0 || raw.Archived == nil {
				return ConversationMetadata{}, errors.New("metadata: missing or mismatched target")
			}
			if err = p.verify(ctx, Identity{URL: before.URL, ConversationID: id}); err != nil {
				return ConversationMetadata{}, err
			}
			return ConversationMetadata{ConversationID: id, Title: *raw.Title, CreatedAt: time.Unix(int64(raw.Created), int64((raw.Created-float64(int64(raw.Created)))*1e9)).UTC(), ProjectID: raw.Project, Archived: *raw.Archived, Starred: raw.Starred, PinnedTime: raw.PinnedTime}, nil
		}
		if err := pause(ctx, 100*time.Millisecond); err != nil {
			return ConversationMetadata{}, fmt.Errorf("metadata: page GET not observed: %w", err)
		}
	}
}

// ProjectID validates the observed project composer URL, including its optional
// human-readable slug. Loopback origins are accepted for disposable fixtures.
func ProjectID(raw string) (string, error) {
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || !allowedOrigin(u) || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New("invalid ChatGPT project URL")
	}
	match := regexp.MustCompile(`(?i)^/g/(g-p-[a-z0-9]+)(?:-[^/]+)?/project/?$`).FindStringSubmatch(u.Path)
	if len(match) != 2 {
		return "", errors.New("invalid ChatGPT project URL")
	}
	return match[1], nil
}

// VerifyProject checks existing placement without moving the conversation. It
// also binds that expectation for later Rename calls after a reattachment.
func (p *BrowserPage) VerifyProject(ctx context.Context, projectURL string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	want, e := ProjectID(projectURL)
	if e != nil {
		return e
	}
	m, e := p.metadata(ctx)
	if e != nil {
		return e
	}
	if m.ProjectID != want {
		return errors.New("project membership does not match; create inside configured project")
	}
	p.projectURL = projectURL
	return nil
}

// ConversationTitle uses the server's actual creation time, matching 0.9 naming.
func ConversationTitle(created time.Time, kind, topic, timezone, language string) (string, error) {
	types := map[string]string{"FEA": "功能", "DES": "设计", "FIX": "修复", "OPT": "优化", "REL": "发布", "EXP": "探索", "DOC": "文档", "RES": "研究"}
	label, ok := types[kind]
	if !ok {
		return "", errors.New("invalid title type")
	}
	if created.IsZero() {
		return "", errors.New("conversation creation time required")
	}
	topic = strings.TrimSpace(topic)
	if topic == "" || len([]rune(topic)) > 100 || strings.ContainsAny(topic, "\r\n｜") {
		return "", errors.New("invalid title topic")
	}
	if language != "en" && language != "zh" {
		return "", errors.New("title language must be en or zh")
	}
	loc, e := time.LoadLocation(timezone)
	if e != nil {
		return "", e
	}
	if language == "en" {
		label = kind
	}
	return created.In(loc).Format("0102") + "｜" + label + "｜" + topic, nil
}
func (p *BrowserPage) Rename(ctx context.Context, title string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if strings.TrimSpace(title) == "" || strings.ContainsAny(title, "\r\n") {
		return errors.New("invalid conversation title")
	}
	before, err := p.metadata(ctx)
	if err != nil {
		return err
	}
	if before.Archived {
		return errors.New("conversation is archived")
	}
	if p.projectURL != "" {
		project, e := ProjectID(p.projectURL)
		if e != nil || before.ProjectID != project {
			return errors.New("project membership does not match; create inside configured project")
		}
	}
	if before.Title == title {
		var sidebar string
		if err = p.eval(ctx, "sidebarTitle", nil, &sidebar); err != nil {
			return err
		}
		if sidebar != title {
			return errors.New("rename: sidebar title not verified")
		}
		return nil
	}
	if e := p.click(ctx, "options"); e != nil {
		return e
	}
	if e := p.wait(ctx, "rename", nil); e != nil {
		return e
	}
	if e := p.click(ctx, "rename"); e != nil {
		return e
	}
	if e := p.wait(ctx, "titleFocus", nil); e != nil {
		return e
	}
	if e := p.tab.InsertText(ctx, title); e != nil {
		return e
	}
	var actual string
	if e := p.eval(ctx, "titleValue", nil, &actual); e != nil {
		return e
	}
	if actual != title {
		return errors.New("rename: exact draft verification failed")
	}
	savedAfter := time.Now()
	if e := p.key(ctx, "Enter"); e != nil {
		return fmt.Errorf("rename save unknown: %w", e)
	}
	// A successful page-owned mutation response and the exact sidebar text are
	// both required. Never submit the rename a second time after uncertainty.
	reader := p.tab.(responseReader)
	for {
		ack := false
		for _, r := range reader.Responses() {
			u, err := url.Parse(r.URL)
			if err == nil && !r.At.Before(savedAfter) && r.Status >= 200 && r.Status < 300 && (r.Method == "POST" || r.Method == "PATCH") && strings.HasPrefix(u.Path, "/backend-api/") {
				for _, part := range strings.Split(u.Path, "/") {
					if part == before.ConversationID {
						ack = true
					}
				}
			}
		}
		var sidebar string
		if ack && p.eval(ctx, "sidebarTitle", nil, &sidebar) == nil && sidebar == title {
			after, err := p.metadata(ctx)
			if err != nil {
				return err
			}
			a, b := before, after
			a.Title = ""
			b.Title = ""
			av, _ := json.Marshal(a)
			bv, _ := json.Marshal(b)
			if string(av) != string(bv) {
				return errors.New("rename: unrelated metadata changed")
			}
			if after.Title != title {
				return errors.New("rename: server title not verified")
			}
			return nil
		}
		if err := pause(ctx, 100*time.Millisecond); err != nil {
			return fmt.Errorf("rename save unconfirmed; inspect before retrying: %w", err)
		}
	}
}
