package archive

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/MarioJames/convorel/internal/store"
)

const (
	// FTS5 trigram needs three code points; shorter queries scan literally.
	matchMin           = 3
	snippetTokens      = 32
	searchDefaultLimit = 20
	searchMaxLimit     = 100
	queryMaxBytes      = 512
)

// SearchInput accepts one literal phrase. TaskID, Role, Limit and Offset are
// optional; Limit defaults to 20 and is bounded at 100 like 0.9.
type SearchInput struct {
	Query  string
	TaskID string
	Role   string
	Limit  int
	Offset int
}

// Hit is one selected content version. Excerpt is the FTS snippet (or the literal
// window for short queries); Text is the complete archived body.
type Hit struct {
	VersionID    string   `json:"versionId"`
	TaskID       string   `json:"taskId"`
	RunID        string   `json:"runId"`
	Role         string   `json:"role"`
	MessageKey   string   `json:"messageKey"`
	Format       string   `json:"format"`
	ContentHash  string   `json:"contentHash"`
	Source       string   `json:"source"`
	CapturedAt   string   `json:"capturedAt"`
	SupersededAt *string  `json:"supersededAt"`
	TaskState    string   `json:"taskState"`
	URL          *string  `json:"url"`
	RemoteID     *string  `json:"remoteId"`
	WorkspaceID  *string  `json:"workspaceId"`
	Excerpt      string   `json:"excerpt"`
	Rank         *float64 `json:"rank"`
	Text         string   `json:"text"`
	Engine       string   `json:"engine"`
}

// SearchResult carries the page of hits plus the total number of matches before
// limit/offset. Total lets a caller compare 0.9 counts even when the page is short.
type SearchResult struct {
	Hits   []Hit  `json:"hits"`
	Total  int    `json:"total"`
	Engine string `json:"engine"`
}

type searchTerm struct {
	query  string
	engine string
	match  string
}

// literalQuery is one literal phrase: NEAR, wildcards and quotes are not syntax a
// caller gets to inject.
func literalQuery(input string) (searchTerm, error) {
	query := strings.TrimSpace(input)
	if query == "" || strings.ContainsRune(query, 0) {
		return searchTerm{}, errors.New("INVALID_SEARCH_QUERY")
	}
	if len([]byte(query)) > queryMaxBytes {
		return searchTerm{}, errors.New("SEARCH_QUERY_TOO_LONG")
	}
	engine := "trigram"
	if utf8.RuneCountInString(query) < matchMin {
		engine = "literal-scan"
	}
	return searchTerm{
		query:  query,
		engine: engine,
		match:  `"` + strings.ReplaceAll(query, `"`, `""`) + `"`,
	}, nil
}

// selectionFilter reports what each run currently represents: its selected prompt
// and its best available reply body (captured Markdown when present, rendered text
// until then). Superseded versions stay citable through History and ContentVersion,
// not through search.
const selectionFilter = `v.version_id in (
  select prompt_version_id from run_selection where prompt_version_id is not null
  union select coalesce(reply_version_id, rendered_version_id) from run_selection
    where coalesce(reply_version_id, rendered_version_id) is not null)`

// Search returns selected versions matching one literal phrase, ranked by bm25
// exactly as 0.9 did. Short terms scan literally because a trigram index cannot
// answer them.
func (a *Archive) Search(ctx context.Context, input SearchInput) (SearchResult, error) {
	term, err := literalQuery(input.Query)
	if err != nil {
		return SearchResult{}, err
	}
	if input.Role != "" && input.Role != "user" && input.Role != "assistant" {
		return SearchResult{}, errors.New("INVALID_ROLE")
	}
	limit := input.Limit
	if limit == 0 {
		limit = searchDefaultLimit
	}
	if limit < 1 || limit > searchMaxLimit {
		return SearchResult{}, fmt.Errorf("INVALID_LIMIT: 1..%d", searchMaxLimit)
	}
	if input.Offset < 0 {
		return SearchResult{}, errors.New("INVALID_OFFSET")
	}
	scan := term.engine == "literal-scan"

	from := "from content_version v"
	if !scan {
		from += " join content_fts on content_fts.rowid = v.id"
	}
	from += ` join task t on t.id = v.task_id
		left join conversation c on c.id = t.conversation_id`

	filters := make([]string, 0, 4)
	whereArgs := make([]any, 0, 3)
	if scan {
		filters = append(filters, "instr(lower(v.text), lower(?)) > 0")
		whereArgs = append(whereArgs, term.query)
	} else {
		filters = append(filters, "content_fts match ?")
		whereArgs = append(whereArgs, term.match)
	}
	filters = append(filters, selectionFilter)
	if input.TaskID != "" {
		filters = append(filters, "v.task_id = ?")
		whereArgs = append(whereArgs, input.TaskID)
	}
	if input.Role != "" {
		filters = append(filters, "v.role = ?")
		whereArgs = append(whereArgs, input.Role)
	}
	where := strings.Join(filters, " and ")

	a.mu.RLock()
	defer a.mu.RUnlock()
	var total int64
	if err := a.db.QueryRowContext(ctx,
		"select count(*) "+from+" where "+where, whereArgs...).Scan(&total); err != nil {
		return SearchResult{}, err
	}

	excerptExpr := fmt.Sprintf("snippet(content_fts, 0, '[', ']', ' ... ', %d)", snippetTokens)
	rankExpr := "bm25(content_fts)"
	orderBy := "order by rank asc, v.id asc"
	selectArgs := make([]any, 0, 1)
	if scan {
		excerptExpr = "substr(v.text, max(1, instr(lower(v.text), lower(?)) - 40), 240)"
		rankExpr = "null"
		orderBy = "order by v.id"
		// The literal form references the term twice: the window and the predicate.
		selectArgs = append(selectArgs, term.query)
	}
	args := append(selectArgs, whereArgs...)
	args = append(args, limit, input.Offset)

	rows, err := a.db.QueryContext(ctx, `select v.version_id, v.task_id, v.run_id,
		v.role, v.message_key, v.format, v.content_hash, v.source, v.captured_at,
		v.superseded_at, t.state as task_state, c.url, c.remote_id, c.workspace_id,
		`+excerptExpr+` as excerpt, `+rankExpr+` as rank, v.text
		`+from+` where `+where+` `+orderBy+` limit ? offset ?`, args...)
	if err != nil {
		return SearchResult{}, err
	}
	defer rows.Close()

	result := SearchResult{Hits: make([]Hit, 0, limit), Total: int(total), Engine: term.engine}
	for rows.Next() {
		var hit Hit
		var superseded, url, remoteID, workspaceID sql.NullString
		var rank sql.NullFloat64
		if err := rows.Scan(&hit.VersionID, &hit.TaskID, &hit.RunID, &hit.Role,
			&hit.MessageKey, &hit.Format, &hit.ContentHash, &hit.Source,
			&hit.CapturedAt, &superseded, &hit.TaskState, &url, &remoteID,
			&workspaceID, &hit.Excerpt, &rank, &hit.Text); err != nil {
			return SearchResult{}, err
		}
		hit.SupersededAt = stringPtr(superseded)
		hit.URL = stringPtr(url)
		hit.RemoteID = stringPtr(remoteID)
		hit.WorkspaceID = stringPtr(workspaceID)
		hit.Rank = float64Ptr(rank)
		hit.Engine = term.engine
		result.Hits = append(result.Hits, hit)
	}
	if err := rows.Err(); err != nil {
		return SearchResult{}, err
	}
	return result, nil
}

// HistoryOptions selects one run or every run of the archived task.
type HistoryOptions struct {
	RunID string
}

// ArchivedTask is the archived task record joined with its remote conversation.
type ArchivedTask struct {
	ID             string  `json:"id"`
	ConversationID *int64  `json:"conversationId"`
	WorkspaceID    *string `json:"workspaceId"`
	NamingType     *string `json:"namingType"`
	Topic          *string `json:"topic"`
	State          string  `json:"state"`
	Origin         string  `json:"origin"`
	FirstRunAt     *string `json:"firstRunAt"`
	UpdatedAt      string  `json:"updatedAt"`
	URL            *string `json:"url"`
	Scope          *string `json:"scope"`
	RemoteID       *string `json:"remoteId"`
	ProjectName    *string `json:"projectName"`
}

// Turn joins archived run metadata with the versions the run selected.
type Turn struct {
	Seq                int     `json:"seq"`
	RunID              string  `json:"runId"`
	RequestKey         string  `json:"requestKey"`
	RunState           string  `json:"runState"`
	ObservedModel      *string `json:"observedModel"`
	CreatedAt          *string `json:"createdAt"`
	SubmittedAt        *string `json:"submittedAt"`
	LastObservedAt     *string `json:"lastObservedAt"`
	RunError           *string `json:"runError"`
	CaptureStatus      string  `json:"captureStatus"`
	CaptureError       *string `json:"captureError"`
	SourceReplyHash    *string `json:"sourceReplyHash"`
	ContentFingerprint string  `json:"contentFingerprint"`
	TaskFileHash       *string `json:"taskFileHash"`
	IndexedAt          string  `json:"indexedAt"`
	Prompt             *string `json:"prompt"`
	PromptVersionID    *string `json:"promptVersionId"`
	PromptContentHash  *string `json:"promptContentHash"`
	Reply              *string `json:"reply"`
	ReplyVersionID     *string `json:"replyVersionId"`
	ReplyFormat        *string `json:"replyFormat"`
	ReplyContentHash   *string `json:"replyContentHash"`
	ReplySource        *string `json:"replySource"`
	ReplyCapturedAt    *string `json:"replyCapturedAt"`
	ReplyRendered      *string `json:"replyRendered"`
	RenderedVersionID  *string `json:"renderedVersionId"`
}

// VersionSummary describes an immutable content version without its body.
type VersionSummary struct {
	VersionID    string  `json:"versionId"`
	RunID        string  `json:"runId"`
	Role         string  `json:"role"`
	MessageKey   string  `json:"messageKey"`
	Format       string  `json:"format"`
	ContentHash  string  `json:"contentHash"`
	Source       string  `json:"source"`
	CapturedAt   string  `json:"capturedAt"`
	SupersededAt *string `json:"supersededAt"`
	Supersedes   *string `json:"supersedes"`
	Bytes        int64   `json:"bytes"`
}

// History is the archived view of one task: its selected prompt and best reply
// body per run, plus every immutable version so citations stay checkable.
type History struct {
	Task     ArchivedTask     `json:"task"`
	Turns    []Turn           `json:"turns"`
	Versions []VersionSummary `json:"versions"`
}

// History reads one task's archived conversation content. It fails only for an
// unknown task; an archived run may legitimately have no reply body yet.
func (a *Archive) History(ctx context.Context, taskID string, options HistoryOptions) (History, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	var task ArchivedTask
	var conversationID sql.NullInt64
	var workspaceID, namingType, topic, firstRunAt sql.NullString
	var url, scope, remoteID, projectName sql.NullString
	err := a.db.QueryRowContext(ctx, `select t.id, t.conversation_id, t.workspace_id,
		t.naming_type, t.topic, t.state, t.origin, t.first_run_at, t.updated_at,
		c.url, c.scope, c.remote_id, c.project_name
		from task t left join conversation c on c.id = t.conversation_id
		where t.id = ?`, taskID).Scan(&task.ID, &conversationID, &workspaceID,
		&namingType, &topic, &task.State, &task.Origin, &firstRunAt,
		&task.UpdatedAt, &url, &scope, &remoteID, &projectName)
	if errors.Is(err, sql.ErrNoRows) {
		return History{}, errors.New("TASK_NOT_ARCHIVED")
	}
	if err != nil {
		return History{}, err
	}
	task.ConversationID = int64Ptr(conversationID)
	task.WorkspaceID = stringPtr(workspaceID)
	task.NamingType = stringPtr(namingType)
	task.Topic = stringPtr(topic)
	task.FirstRunAt = stringPtr(firstRunAt)
	task.URL = stringPtr(url)
	task.Scope = stringPtr(scope)
	task.RemoteID = stringPtr(remoteID)
	task.ProjectName = stringPtr(projectName)

	turnArgs := []any{taskID}
	runFilter := ""
	if options.RunID != "" {
		runFilter = " and r.id = ?"
		turnArgs = append(turnArgs, options.RunID)
	}
	rows, err := a.db.QueryContext(ctx, `select r.seq, r.id, r.request_key, r.state,
		r.observed_model, r.created_at, r.submitted_at, r.last_observed_at, r.error,
		s.capture_status, s.capture_error, s.source_reply_hash,
		s.content_fingerprint, s.task_file_hash, s.indexed_at,
		pu.text, pu.version_id, pu.content_hash,
		rv.text, rv.version_id, rv.format, rv.content_hash, rv.source, rv.captured_at,
		dv.text, dv.version_id
		from run r
		  join run_selection s on s.run_id = r.id
		  left join content_version pu on pu.version_id = s.prompt_version_id
		  left join content_version rv on rv.version_id = s.reply_version_id
		  left join content_version dv on dv.version_id = s.rendered_version_id
		where r.task_id = ?`+runFilter+` order by r.seq`, turnArgs...)
	if err != nil {
		return History{}, err
	}
	defer rows.Close()
	turns := make([]Turn, 0, 4)
	for rows.Next() {
		var turn Turn
		var observedModel, createdAt, submittedAt, lastObservedAt, runError sql.NullString
		var captureError, sourceReplyHash, taskFileHash sql.NullString
		var prompt, promptVersion, promptHash sql.NullString
		var reply, replyVersion, replyFormat, replyHash, replySource sql.NullString
		var replyCapturedAt, rendered, renderedVersion sql.NullString
		if err := rows.Scan(&turn.Seq, &turn.RunID, &turn.RequestKey, &turn.RunState,
			&observedModel, &createdAt, &submittedAt, &lastObservedAt, &runError,
			&turn.CaptureStatus, &captureError, &sourceReplyHash,
			&turn.ContentFingerprint, &taskFileHash, &turn.IndexedAt,
			&prompt, &promptVersion, &promptHash,
			&reply, &replyVersion, &replyFormat, &replyHash, &replySource,
			&replyCapturedAt, &rendered, &renderedVersion); err != nil {
			return History{}, err
		}
		turn.ObservedModel = stringPtr(observedModel)
		turn.CreatedAt = stringPtr(createdAt)
		turn.SubmittedAt = stringPtr(submittedAt)
		turn.LastObservedAt = stringPtr(lastObservedAt)
		turn.RunError = stringPtr(runError)
		turn.CaptureError = stringPtr(captureError)
		turn.SourceReplyHash = stringPtr(sourceReplyHash)
		turn.TaskFileHash = stringPtr(taskFileHash)
		turn.Prompt = stringPtr(prompt)
		turn.PromptVersionID = stringPtr(promptVersion)
		turn.PromptContentHash = stringPtr(promptHash)
		turn.Reply = stringPtr(reply)
		turn.ReplyVersionID = stringPtr(replyVersion)
		turn.ReplyFormat = stringPtr(replyFormat)
		turn.ReplyContentHash = stringPtr(replyHash)
		turn.ReplySource = stringPtr(replySource)
		turn.ReplyCapturedAt = stringPtr(replyCapturedAt)
		turn.ReplyRendered = stringPtr(rendered)
		turn.RenderedVersionID = stringPtr(renderedVersion)
		turns = append(turns, turn)
	}
	if err := rows.Err(); err != nil {
		return History{}, err
	}

	versionArgs := []any{taskID}
	versionFilter := ""
	if options.RunID != "" {
		versionFilter = " and run_id = ?"
		versionArgs = append(versionArgs, options.RunID)
	}
	versionRows, err := a.db.QueryContext(ctx, `select version_id, run_id, role,
		message_key, format, content_hash, source, captured_at, superseded_at,
		supersedes, length(cast(text as blob)) as bytes
		from content_version where task_id = ?`+versionFilter+` order by id`,
		versionArgs...)
	if err != nil {
		return History{}, err
	}
	defer versionRows.Close()
	versions := make([]VersionSummary, 0, 8)
	for versionRows.Next() {
		var version VersionSummary
		var supersededAt, supersedes sql.NullString
		if err := versionRows.Scan(&version.VersionID, &version.RunID,
			&version.Role, &version.MessageKey, &version.Format,
			&version.ContentHash, &version.Source, &version.CapturedAt,
			&supersededAt, &supersedes, &version.Bytes); err != nil {
			return History{}, err
		}
		version.SupersededAt = stringPtr(supersededAt)
		version.Supersedes = stringPtr(supersedes)
		versions = append(versions, version)
	}
	if err := versionRows.Err(); err != nil {
		return History{}, err
	}
	return History{Task: task, Turns: turns, Versions: versions}, nil
}

// Coverage describes how completely the archive reflects one task document. The
// remote page is not observable from here, so remoteHistory stays unknown.
type Coverage struct {
	State               string   `json:"state"`
	Reason              string   `json:"reason,omitempty"`
	Scope               string   `json:"scope,omitempty"`
	RemoteHistory       string   `json:"remoteHistory"`
	SourceReadable      bool     `json:"sourceReadable,omitempty"`
	ExpectedRuns        int      `json:"expectedRuns,omitempty"`
	ArchivedRuns        int      `json:"archivedRuns,omitempty"`
	MissingRuns         []string `json:"missingRuns,omitempty"`
	MarkdownMissingRuns []string `json:"markdownMissingRuns,omitempty"`
	PromptMissingRuns   []string `json:"promptMissingRuns,omitempty"`
}

type storedSelection struct {
	runID              string
	contentFingerprint string
	captureStatus      string
	promptHash         *string
	markdownHash       *string
	renderedHash       *string
}

// Coverage compares the task document read this time with the stored projection.
// It reports drift and known gaps; it never repairs either side.
func (a *Archive) Coverage(ctx context.Context, task *store.Task, taskFileHash string) (Coverage, error) {
	if task == nil {
		return Coverage{State: "unknown", Reason: "task_document_unavailable", RemoteHistory: "unknown"}, nil
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	rows, err := a.db.QueryContext(ctx, `select s.run_id, s.content_fingerprint,
		s.capture_status, pu.content_hash as prompt_hash,
		rv.content_hash as markdown_hash, dv.content_hash as rendered_hash
		from run_selection s
		  left join content_version pu on pu.version_id = s.prompt_version_id
		  left join content_version rv on rv.version_id = s.reply_version_id
		  left join content_version dv on dv.version_id = s.rendered_version_id
		where s.task_id = ?`, task.ID)
	if err != nil {
		return Coverage{}, err
	}
	defer rows.Close()
	stored := make([]storedSelection, 0, len(task.Runs))
	for rows.Next() {
		var item storedSelection
		var promptHash, markdownHash, renderedHash sql.NullString
		if err := rows.Scan(&item.runID, &item.contentFingerprint, &item.captureStatus,
			&promptHash, &markdownHash, &renderedHash); err != nil {
			return Coverage{}, err
		}
		item.promptHash = stringPtr(promptHash)
		item.markdownHash = stringPtr(markdownHash)
		item.renderedHash = stringPtr(renderedHash)
		stored = append(stored, item)
	}
	if err := rows.Err(); err != nil {
		return Coverage{}, err
	}

	remoteID := remoteConversationID(*task)
	missing := make([]string, 0)
	markdownGaps := make([]string, 0)
	promptGaps := make([]string, 0)
	for _, run := range task.Runs {
		var found *storedSelection
		for i := range stored {
			item := &stored[i]
			if item.runID == run.ID &&
				item.contentFingerprint == runContentFingerprint(task.ID, remoteID, run) &&
				equalNullable(item.promptHash, run.Prompt) &&
				equalNullable(item.markdownHash, replyMarkdown(run)) &&
				equalRendered(item.renderedHash, run) {
				found = item
				break
			}
		}
		if found == nil {
			missing = append(missing, run.ID)
		} else if found.captureStatus == "pending" {
			markdownGaps = append(markdownGaps, run.ID)
		}
		if run.Prompt == "" && run.UserMessageID != "" {
			promptGaps = append(promptGaps, run.ID)
		}
	}
	state := "current"
	if len(missing) > 0 || len(promptGaps) > 0 {
		state = "incomplete"
	} else if len(markdownGaps) > 0 {
		state = "markdown-incomplete"
	}
	return Coverage{
		State:               state,
		Scope:               "convorel-recorded-runs",
		RemoteHistory:       "unknown",
		SourceReadable:      taskFileHash != "",
		ExpectedRuns:        len(task.Runs),
		ArchivedRuns:        len(stored),
		MissingRuns:         missing,
		MarkdownMissingRuns: markdownGaps,
		PromptMissingRuns:   promptGaps,
	}, nil
}

// equalNullable compares a stored hash with the hash of a value that is absent
// when empty. Both sides must agree on presence as well as bytes.
func equalNullable(stored *string, value string) bool {
	if value == "" {
		return stored == nil
	}
	return stored != nil && *stored == shaHex(value)
}

func replyMarkdown(run store.Run) string {
	if run.Reply == nil {
		return ""
	}
	return run.Reply.Markdown
}

func equalRendered(stored *string, run store.Run) bool {
	if run.Reply == nil {
		return stored == nil
	}
	return stored != nil && *stored == shaHex(run.Reply.Text)
}

// ContentVersion is one immutable body by version id, selected or superseded. A
// citation has to stay readable, otherwise keeping the version proves nothing.
type ContentVersion struct {
	VersionID    string  `json:"versionId"`
	TaskID       string  `json:"taskId"`
	RunID        string  `json:"runId"`
	Role         string  `json:"role"`
	MessageKey   string  `json:"messageKey"`
	Format       string  `json:"format"`
	Text         string  `json:"text"`
	ContentHash  string  `json:"contentHash"`
	Source       string  `json:"source"`
	CapturedAt   string  `json:"capturedAt"`
	SupersededAt *string `json:"supersededAt"`
	Supersedes   *string `json:"supersedes"`
	SelectedBy   int64   `json:"selectedBy"`
	Characters   int64   `json:"characters"`
	Bytes        int     `json:"bytes"`
}

var versionIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ContentVersion reads one archived body, including a superseded version. It is
// the read path behind "show archived conversation content".
func (a *Archive) ContentVersion(ctx context.Context, versionID string) (ContentVersion, error) {
	if !versionIDPattern.MatchString(versionID) {
		return ContentVersion{}, errors.New("INVALID_VERSION_ID")
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	var version ContentVersion
	var supersededAt, supersedes sql.NullString
	err := a.db.QueryRowContext(ctx, `select v.version_id, v.task_id, v.run_id,
		v.role, v.message_key, v.format, v.text, v.content_hash, v.source,
		v.captured_at, v.superseded_at, v.supersedes,
		(select count(*) from run_selection s
		  where s.prompt_version_id = v.version_id
		     or s.reply_version_id = v.version_id
		     or s.rendered_version_id = v.version_id) as selected_by,
		length(v.text) as characters
		from content_version v where v.version_id = ?`, versionID).Scan(
		&version.VersionID, &version.TaskID, &version.RunID, &version.Role,
		&version.MessageKey, &version.Format, &version.Text, &version.ContentHash,
		&version.Source, &version.CapturedAt, &supersededAt, &supersedes,
		&version.SelectedBy, &version.Characters)
	if errors.Is(err, sql.ErrNoRows) {
		return ContentVersion{}, errors.New("VERSION_NOT_ARCHIVED")
	}
	if err != nil {
		return ContentVersion{}, err
	}
	version.SupersededAt = stringPtr(supersededAt)
	version.Supersedes = stringPtr(supersedes)
	version.Bytes = len([]byte(version.Text))
	return version, nil
}
