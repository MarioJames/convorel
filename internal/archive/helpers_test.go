package archive_test

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/config"
	"github.com/MarioJames/convorel/internal/store"
	_ "modernc.org/sqlite"
)

const (
	chatGPTURL   = "https://chatgpt.com/g/g-p-1/proj/c/abc-123"
	renderedText = "结论 推荐 A"
)

func sha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// taskDoc mirrors tests/support/archive.ts from 0.9: one complete run with a
// selected prompt and a rendered reply, but no copied Markdown yet.
func taskDoc() store.Task {
	prompt := "[M1]\n\n注册入口防枚举方案"
	return store.Task{
		Version: 1,
		ID:      "review",
		Config: config.Config{
			Version:     1,
			Workspace:   "/home/mocha/project",
			CDP:         "http://127.0.0.1:9222",
			ProjectName: "proj",
		},
		WorkspaceID: "w1",
		CurrentRun:  "r1",
		AttemptID:   "a1",
		URL:         chatGPTURL,
		Naming:      &store.Naming{Type: "DES", Topic: "注册防枚举"},
		Runs: []store.Run{
			{
				ID:             "r1",
				RequestID:      "initial",
				Prompt:         prompt,
				PromptHash:     sha(prompt),
				Marker:         "[M1]",
				State:          store.Complete,
				UserMessageID:  "u1",
				CreatedAt:      "2026-09-20T01:00:00.000Z",
				LastObservedAt: "2026-09-20T01:05:00.000Z",
				Reply: &store.Reply{
					ID:    "m1",
					Role:  "assistant",
					Text:  renderedText,
					Final: true,
				},
				ReplyHash:     sha(renderedText),
				ObservedModel: "6 Pro",
			},
		},
	}
}

func cloneTask(task store.Task) store.Task {
	out := task
	out.Runs = append([]store.Run(nil), task.Runs...)
	for i := range out.Runs {
		if task.Runs[i].Reply != nil {
			reply := *task.Runs[i].Reply
			out.Runs[i].Reply = &reply
		}
	}
	if task.Naming != nil {
		naming := *task.Naming
		out.Naming = &naming
	}
	return out
}

func openArchive(t *testing.T, dir string) *archive.Archive {
	t.Helper()
	a, err := archive.Open(dir)
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func openExisting(t *testing.T, path string) *archive.Archive {
	t.Helper()
	a, err := archive.OpenExisting(path)
	if err != nil {
		t.Fatalf("open existing archive: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}

func rawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// Version IDs used by the legacy fixture; the shape is the RFC 4122 UUID the
// 0.9 implementation generated.
const (
	promptVersionID     = "11111111-1111-4111-8111-111111111111"
	renderedVersionID   = "22222222-2222-4222-8222-222222222222"
	markdownVersionID   = "33333333-3333-4333-8333-333333333333"
	supersededVersionID = "44444444-4444-4444-8444-444444444444"
)

const (
	fixturePrompt   = "[M1]\n\n注册入口防枚举方案与多租户隔离 \"A\""
	fixtureRendered = "结论 推荐 A；多租户需要审批"
	fixtureMarkdown = "## 裁定\n\n推荐 [A](https://example.com/a)；多租户需要审批"
)

// createLegacyFixture builds a version-1 database from the 0.9 DDL and fills it
// with rows exactly as the previous implementation stored them. It returns the
// database path and leaves the file closed and ready to be opened by the archive.
func createLegacyFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "conversations.db")
	ddl, err := os.ReadFile(filepath.Join("testdata", "legacy-0.9-schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	db := rawDB(t, path)
	if _, err := db.Exec(string(ddl)); err != nil {
		t.Fatalf("apply 0.9 DDL: %v", err)
	}
	mustExec(t, db, "insert into meta (key, value) values ('dbKind', ?)", archive.DBKind)
	mustExec(t, db, "insert into meta (key, value) values ('createdAt', ?)", "2026-09-20T00:00:00.000Z")
	mustExec(t, db, "pragma user_version = 1")
	mustExec(t, db, `insert into workspace (id, root, first_seen_at, last_seen_at)
		values ('w1', '/home/mocha/project', '2026-09-20T00:00:00.000Z', '2026-09-20T01:00:00.000Z')`)
	mustExec(t, db, `insert into conversation (provider, scope, remote_id, url, workspace_id, project_name, opened_at)
		values ('chatgpt', 'https://chatgpt.com/g/g-p-1/proj', 'abc-123', ?, 'w1', 'proj', '2026-09-20T01:00:00.000Z')`, chatGPTURL)
	mustExec(t, db, `insert into task (id, conversation_id, workspace_id, naming_type, topic, state, origin, first_run_at, updated_at)
		values ('review', 1, 'w1', 'DES', '注册防枚举', 'complete', 'convorel', '2026-09-20T01:00:00.000Z', '2026-09-20T01:05:00.000Z')`)
	mustExec(t, db, `insert into run (id, task_id, seq, request_key, state, observed_model, created_at, last_observed_at)
		values ('r1', 'review', 0, 'initial', 'complete', '6 Pro', '2026-09-20T01:00:00.000Z', '2026-09-20T01:05:00.000Z')`)
	mustExec(t, db, `insert into content_version
		(version_id, task_id, run_id, role, message_key, format, text, content_hash, source, captured_at)
		values (?, 'review', 'r1', 'user', 'run:r1', 'prompt-source', ?, ?, 'convorel-submit', '2026-09-20T01:00:00.000Z')`,
		promptVersionID, fixturePrompt, sha(fixturePrompt))
	mustExec(t, db, `insert into content_version
		(version_id, task_id, run_id, role, message_key, format, text, content_hash, source, captured_at)
		values (?, 'review', 'r1', 'assistant', 'm1', 'rendered-text', ?, ?, 'page-observation', '2026-09-20T01:05:00.000Z')`,
		renderedVersionID, fixtureRendered, sha(fixtureRendered))
	mustExec(t, db, `insert into content_version
		(version_id, task_id, run_id, role, message_key, format, text, content_hash, source, captured_at)
		values (?, 'review', 'r1', 'assistant', 'm1', 'markdown', ?, ?, 'copy-button', '2026-09-20T01:06:00.000Z')`,
		markdownVersionID, fixtureMarkdown, sha(fixtureMarkdown))
	mustExec(t, db, `insert into content_version
		(version_id, task_id, run_id, role, message_key, format, text, content_hash, source, captured_at, superseded_at, supersedes)
		values (?, 'review', 'r1', 'assistant', 'm1', 'markdown', '## 旧裁定：多租户遗留', ?, 'copy-button', '2026-09-20T01:04:00.000Z', '2026-09-20T01:06:00.000Z', null)`,
		supersededVersionID, sha("## 旧裁定：多租户遗留"))
	mustExec(t, db, `insert into run_selection
		(run_id, task_id, prompt_version_id, reply_version_id, rendered_version_id,
		 capture_status, source_reply_hash, content_fingerprint, task_file_hash, indexed_at)
		values ('r1', 'review', ?, ?, ?, 'captured', ?, 'legacy-fingerprint', 'legacy-task-hash', '2026-09-20T01:06:00.000Z')`,
		promptVersionID, markdownVersionID, renderedVersionID, sha(fixtureRendered))
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
