package archive

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/MarioJames/convorel/internal/store"
)

var conversationIDPattern = regexp.MustCompile(`(?:^|/)c/([a-zA-Z0-9-]+)$`)

// ConversationID extracts the remote conversation id from a persisted ChatGPT
// URL. A draft URL or another origin is not a conversation identity.
func ConversationID(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" ||
		!strings.EqualFold(u.Hostname(), "chatgpt.com") ||
		(u.Port() != "" && u.Port() != "443") {
		return "", errors.New("CONVERSATION_URL_INVALID")
	}
	match := conversationIDPattern.FindStringSubmatch(u.Path)
	if match == nil {
		return "", errors.New("CONVERSATION_URL_INVALID")
	}
	return match[1], nil
}

func remoteConversationID(task store.Task) *string {
	if task.URL == "" {
		return nil
	}
	id, err := ConversationID(task.URL)
	if err != nil {
		return nil
	}
	return &id
}

// runContentFingerprint covers only facts that change archived content. Attempt,
// binding, cleanup and observation times move on their own and must not look like
// content drift. The JSON shape and key order match 0.9, so fingerprints stored by
// the previous implementation continue to compare equal during coverage checks.
func runContentFingerprint(taskID string, remoteID *string, run store.Run) string {
	var b strings.Builder
	b.WriteString(`{"version":`)
	b.WriteString(fmt.Sprintf("%d", fingerprintVersion))
	b.WriteString(`,"taskId":`)
	b.WriteString(jsonString(taskID))
	b.WriteString(`,"runId":`)
	b.WriteString(jsonString(run.ID))
	b.WriteString(`,"remoteId":`)
	b.WriteString(nullableJSONString(remoteID))
	b.WriteString(`,"promptHash":`)
	b.WriteString(nullableJSONString(stringPointer(run.PromptHash)))
	b.WriteString(`,"userMessageId":`)
	b.WriteString(nullableJSONString(stringPointer(run.UserMessageID)))
	b.WriteString(`,"replyId":`)
	if run.Reply == nil {
		b.WriteString("null")
	} else {
		// Message.id is required in 0.9, so an empty id is still an id, not null.
		b.WriteString(jsonString(run.Reply.ID))
	}
	b.WriteString(`,"renderedHash":`)
	b.WriteString(nullableJSONString(stringPointer(run.ReplyHash)))
	b.WriteString(`}`)
	return shaHex(b.String())
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func nullableJSONString(value *string) string {
	if value == nil {
		return "null"
	}
	return jsonString(*value)
}

// jsonString matches JSON.stringify for the values that appear in a fingerprint
// (identifiers, hashes and URLs). HTML escaping is deliberately disabled: 0.9 did
// not escape <, > and & in these strings.
func jsonString(value string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// Gap is a run whose archived content is knowingly incomplete. Gaps are reported
// beside a publication; they never make the run failed or deliverable again.
type Gap struct {
	RunID string `json:"runId"`
	Code  string `json:"code"`
}

// runGaps judges incompleteness from the task document being archived, so a
// re-import of an unchanged partial task keeps reporting the same gap instead of
// making the archive look complete.
func runGaps(task store.Task) []Gap {
	gaps := make([]Gap, 0)
	for _, run := range task.Runs {
		if run.Prompt == "" && run.UserMessageID != "" {
			// An attach anchor proves a user turn existed, not what it said.
			gaps = append(gaps, Gap{RunID: run.ID, Code: "prompt_not_captured"})
		}
		if run.Reply != nil && run.Reply.Markdown == "" {
			// store.Reply does not carry the 0.9 markdownError field. A missing
			// capture is therefore reported as missing rather than failed; the
			// rendered body remains archived for traceability.
			gaps = append(gaps, Gap{RunID: run.ID, Code: "markdown_missing"})
		}
	}
	return gaps
}

// PublishResult describes one projection. Unchanged means the task file hash
// matched the stored projection and no row was rewritten.
type PublishResult struct {
	TaskID    string `json:"taskId"`
	Unchanged bool   `json:"unchanged"`
	Runs      int    `json:"runs"`
	Versions  int    `json:"versions"`
	Gaps      []Gap  `json:"gaps"`
}

// Publish projects one task document in a single short transaction. Browser work
// stays outside: no transaction may span a page interaction.
//
// taskFileHash is the digest of the exact serialized task document the caller read
// (the same bytes tasks.db stores). The archive treats it as opaque: it only
// detects whether the document changed since the previous projection.
//
// The engine records the run's rendered prompt (which carries the frozen guidance
// snapshot), the rendered reply text and, when present, the Markdown captured
// through the page's own copy control. An error must be reported as an archive
// notice, never as a delivery, completion or retry outcome.
func (a *Archive) Publish(ctx context.Context, task store.Task, taskFileHash string) (PublishResult, error) {
	result := PublishResult{TaskID: task.ID, Gaps: runGaps(task)}
	if !a.writable {
		return result, archiveReadOnly
	}
	at := nowISO()
	remoteID := remoteConversationID(task)
	err := a.write(ctx, func(q queryer) error {
		var stored sql.NullString
		err := q.QueryRowContext(ctx,
			"select task_file_hash from run_selection where task_id = ? limit 1",
			task.ID).Scan(&stored)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var exists int
		err = q.QueryRowContext(ctx, "select 1 from task where id = ?", task.ID).Scan(&exists)
		taskExists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if taskExists && stored.Valid && stored.String == taskFileHash {
			result.Unchanged = true
			return nil
		}
		if err := upsertWorkspace(ctx, q, task.Config.Workspace, task.WorkspaceID, at); err != nil {
			return err
		}
		conversationKey, err := upsertConversation(ctx, q, task, at)
		if err != nil {
			return err
		}
		origin := "convorel"
		for _, run := range task.Runs {
			if run.RequestID == "import" {
				origin = "attach"
				break
			}
		}
		state := "unknown"
		if len(task.Runs) > 0 {
			state = string(task.Runs[len(task.Runs)-1].State)
		}
		var namingType, namingTopic any
		if task.Naming != nil {
			namingType = task.Naming.Type
			namingTopic = task.Naming.Topic
		}
		var firstRunAt any
		if len(task.Runs) > 0 {
			firstRunAt = task.Runs[0].CreatedAt
		}
		if taskExists {
			if _, err = q.ExecContext(ctx, `update task set conversation_id = ?,
				workspace_id = ?, naming_type = ?, topic = ?, state = ?, updated_at = ?
				where id = ?`,
				conversationKey, task.WorkspaceID, namingType, namingTopic,
				state, at, task.ID); err != nil {
				return err
			}
		} else if _, err = q.ExecContext(ctx, `insert into task
			(id, conversation_id, workspace_id, naming_type, topic, state, origin,
			 first_run_at, updated_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			task.ID, conversationKey, task.WorkspaceID, namingType, namingTopic,
			state, origin, firstRunAt, at); err != nil {
			return err
		}
		// No per-run skip: the fingerprint excludes captured Markdown on purpose,
		// so comparing it alone would drop a re-capture. addVersion deduplicates by
		// hash, so re-importing costs no new content rows.
		for index, run := range task.Runs {
			result.Runs++
			var owner string
			err := q.QueryRowContext(ctx, "select task_id from run where id = ?", run.ID).Scan(&owner)
			if err == nil && owner != task.ID {
				return fmt.Errorf("ARCHIVE_RUN_TASK_CONFLICT: %s", run.ID)
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			fingerprint := runContentFingerprint(task.ID, remoteID, run)
			if _, err = q.ExecContext(ctx, `insert into run
				(id, task_id, seq, request_key, state, observed_model, created_at,
				 submitted_at, last_observed_at, error)
				values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				on conflict (id) do update set seq = excluded.seq,
				 request_key = excluded.request_key, state = excluded.state,
				 observed_model = excluded.observed_model,
				 created_at = excluded.created_at,
				 submitted_at = excluded.submitted_at,
				 last_observed_at = excluded.last_observed_at,
				 error = excluded.error`,
				run.ID, task.ID, index, run.RequestID, string(run.State),
				nullString(run.ObservedModel), nullString(run.CreatedAt),
				nullString(run.SubmittedAt), nullString(run.LastObservedAt),
				nullString(run.Error)); err != nil {
				return err
			}
			var promptVersionID any
			if run.Prompt != "" {
				source := "convorel-submit"
				if origin == "attach" {
					source = "attach"
				}
				capturedAt := run.CreatedAt
				if capturedAt == "" {
					capturedAt = at
				}
				versionID, created, err := addVersion(ctx, q, task.ID, run.ID,
					"user", "run:"+run.ID, "prompt-source", run.Prompt, source, capturedAt)
				if err != nil {
					return err
				}
				promptVersionID = versionID
				if created {
					result.Versions++
				}
			}
			var replyVersionID, renderedVersionID any
			captureStatus := "not-applicable"
			if run.Reply != nil {
				observedAt := run.LastObservedAt
				if observedAt == "" {
					observedAt = at
				}
				versionID, created, err := addVersion(ctx, q, task.ID, run.ID,
					"assistant", run.Reply.ID, "rendered-text", run.Reply.Text,
					"page-observation", observedAt)
				if err != nil {
					return err
				}
				renderedVersionID = versionID
				if created {
					result.Versions++
				}
				if run.Reply.Markdown != "" {
					added, created, err := addVersion(ctx, q, task.ID, run.ID,
						"assistant", run.Reply.ID, "markdown", run.Reply.Markdown,
						"copy-button", at)
					if err != nil {
						return err
					}
					replyVersionID = added
					if created {
						result.Versions++
					}
					captureStatus = "captured"
				} else if run.State == store.Complete {
					// The rendered copy is retained for traceability, but it is never
					// selected as the reply body: the archived reply is the Markdown
					// the page produced.
					captureStatus = "pending"
				}
			}
			var attemptAt any
			if run.Reply != nil {
				attemptAt = at
			}
			if _, err = q.ExecContext(ctx, `insert into run_selection
				(run_id, task_id, prompt_version_id, reply_version_id,
				 rendered_version_id, capture_status, capture_error,
				 last_capture_attempt_at, source_reply_hash, content_fingerprint,
				 task_file_hash, indexed_at)
				values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?)
				on conflict (run_id) do update set
				 prompt_version_id = excluded.prompt_version_id,
				 reply_version_id = excluded.reply_version_id,
				 rendered_version_id = excluded.rendered_version_id,
				 capture_status = excluded.capture_status,
				 capture_error = excluded.capture_error,
				 last_capture_attempt_at = excluded.last_capture_attempt_at,
				 source_reply_hash = excluded.source_reply_hash,
				 content_fingerprint = excluded.content_fingerprint,
				 task_file_hash = excluded.task_file_hash,
				 indexed_at = excluded.indexed_at`,
				run.ID, task.ID, promptVersionID, replyVersionID, renderedVersionID,
				captureStatus, attemptAt, nullString(run.ReplyHash), fingerprint,
				taskFileHash, at); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return PublishResult{TaskID: task.ID, Gaps: runGaps(task)}, err
	}
	if err := a.harden(); err != nil {
		return result, err
	}
	return result, nil
}

func upsertWorkspace(ctx context.Context, q queryer, root, id, at string) error {
	var existing string
	err := q.QueryRowContext(ctx, "select id from workspace where id = ?", id).Scan(&existing)
	if err == nil {
		_, err = q.ExecContext(ctx, "update workspace set last_seen_at = ? where id = ?", at, id)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx, `insert into workspace (id, root, first_seen_at, last_seen_at)
		values (?, ?, ?, ?)`, id, root, at, at)
	return err
}

// upsertConversation keys on provider, scope and remote id. The scope keeps the
// project prefix so a project conversation and a plain one never collide.
func upsertConversation(ctx context.Context, q queryer, task store.Task, at string) (*int64, error) {
	remoteID := remoteConversationID(task)
	if task.URL == "" || remoteID == nil {
		return nil, nil
	}
	scope := task.URL[:len(task.URL)-len(*remoteID)-len("/c/")]
	var existing int64
	err := q.QueryRowContext(ctx, `select id from conversation
		where provider = 'chatgpt' and scope = ? and remote_id = ?`,
		scope, *remoteID).Scan(&existing)
	if err == nil {
		_, err = q.ExecContext(ctx, `update conversation set url = ?, workspace_id = ?,
			project_name = ?, closed_at = null where id = ?`,
			task.URL, task.WorkspaceID, nullString(task.Config.ProjectName), existing)
		return &existing, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	openedAt := at
	if len(task.Runs) > 0 && task.Runs[0].CreatedAt != "" {
		openedAt = task.Runs[0].CreatedAt
	}
	var created int64
	err = q.QueryRowContext(ctx, `insert into conversation
		(provider, scope, remote_id, url, workspace_id, project_name, opened_at)
		values ('chatgpt', ?, ?, ?, ?, ?, ?) returning id`,
		scope, *remoteID, task.URL, task.WorkspaceID,
		nullString(task.Config.ProjectName), openedAt).Scan(&created)
	if err != nil {
		return nil, err
	}
	return &created, nil
}

// addVersion keeps content IDs and their original predecessor immutable.
// Re-selecting known content reactivates it; superseded_at describes the current
// selection, not an append-only event log.
func addVersion(ctx context.Context, q queryer, taskID, runID, role, messageKey,
	format, text, source, at string) (string, bool, error) {
	contentHash := shaHex(text)
	var known string
	err := q.QueryRowContext(ctx, `select version_id from content_version
		where task_id = ? and run_id = ? and role = ? and message_key = ?
		  and format = ? and content_hash = ?`,
		taskID, runID, role, messageKey, format, contentHash).Scan(&known)
	knownExists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	var prior string
	err = q.QueryRowContext(ctx, `select version_id from content_version
		where task_id = ? and run_id = ? and role = ? and format = ?
		  and superseded_at is null order by id desc limit 1`,
		taskID, runID, role, format).Scan(&prior)
	priorExists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	if knownExists && priorExists && known == prior {
		return known, false, nil
	}
	if priorExists {
		if _, err = q.ExecContext(ctx,
			"update content_version set superseded_at = ? where version_id = ?",
			at, prior); err != nil {
			return "", false, err
		}
	}
	if knownExists {
		if _, err = q.ExecContext(ctx,
			"update content_version set superseded_at = null where version_id = ?",
			known); err != nil {
			return "", false, err
		}
		return known, false, nil
	}
	versionID, err := newUUID()
	if err != nil {
		return "", false, err
	}
	var supersedes any
	if priorExists {
		supersedes = prior
	}
	if _, err = q.ExecContext(ctx, `insert into content_version
		(version_id, task_id, run_id, role, message_key, format, text,
		 content_hash, source, captured_at, supersedes)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		versionID, taskID, runID, role, messageKey, format, text,
		contentHash, source, at, supersedes); err != nil {
		return "", false, err
	}
	return versionID, true, nil
}
