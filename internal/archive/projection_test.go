package archive_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
	"github.com/MarioJames/convorel/internal/store"
)

func TestPublishOnceAndLifecycleChurnIsNotContentDrift(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	first, err := a.Publish(ctx, taskDoc(), "fh-1")
	if err != nil {
		t.Fatal(err)
	}
	if first.Runs != 1 || first.Versions != 2 || first.Unchanged {
		t.Fatalf("first publish: %+v", first)
	}
	wantGaps := []archive.Gap{{RunID: "r1", Code: "markdown_missing"}}
	if !reflect.DeepEqual(first.Gaps, wantGaps) {
		t.Fatalf("gaps: %+v", first.Gaps)
	}
	second, err := a.Publish(ctx, taskDoc(), "fh-1")
	if err != nil {
		t.Fatal(err)
	}
	if !second.Unchanged || second.Versions != 0 {
		t.Fatalf("repeat publish: %+v", second)
	}
	if !reflect.DeepEqual(second.Gaps, wantGaps) {
		t.Fatalf("repeat gaps: %+v", second.Gaps)
	}

	churn := cloneTask(taskDoc())
	churn.AttemptID = "a2"
	churn.Binding = &store.Binding{Target: "T", Epoch: "e", Owned: true}
	churn.Runs[0].LastObservedAt = "2026-09-21T09:00:00.000Z"
	third, err := a.Publish(ctx, churn, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if third.Unchanged || third.Versions != 0 {
		t.Fatalf("churn publish: %+v", third)
	}
	stats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Versions != 2 || stats.MarkdownVersions != 0 {
		t.Fatalf("stats: %+v", stats)
	}

	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	turn := history.Turns[0]
	if turn.CaptureStatus != "pending" || turn.Reply != nil || turn.ReplyFormat != nil {
		t.Fatalf("rendered reply was selected: %+v", turn)
	}
	if turn.ReplyRendered == nil || *turn.ReplyRendered != renderedText {
		t.Fatalf("rendered copy missing: %+v", turn.ReplyRendered)
	}
	if turn.LastObservedAt == nil || *turn.LastObservedAt != "2026-09-21T09:00:00.000Z" {
		t.Fatalf("run metadata did not refresh: %+v", turn.LastObservedAt)
	}
}

func TestRegeneratedReplyAppendsImmutableVersion(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	first := cloneTask(taskDoc())
	first.Runs[0].Reply.Markdown = "## 裁定\n\n**推荐 A**"
	if _, err := a.Publish(ctx, first, "fh-1"); err != nil {
		t.Fatal(err)
	}
	before, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	beforeID := before.Turns[0].ReplyVersionID
	if beforeID == nil {
		t.Fatal("captured markdown was not selected")
	}

	changed := cloneTask(first)
	changed.Runs[0].Reply.Text = "结论 改推荐 B"
	changed.Runs[0].ReplyHash = sha("结论 改推荐 B")
	changed.Runs[0].Reply.Markdown = "## 裁定\n\n**改推荐 B**"
	result, err := a.Publish(ctx, changed, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if result.Versions != 2 {
		t.Fatalf("regenerated reply versions: %+v", result)
	}
	after, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if after.Turns[0].ReplyVersionID == nil || *after.Turns[0].ReplyVersionID == *beforeID {
		t.Fatalf("reply version not replaced: %+v", after.Turns[0].ReplyVersionID)
	}
	var superseded *string
	for _, version := range after.Versions {
		if version.VersionID == *beforeID {
			superseded = version.SupersededAt
			if version.Bytes != int64(len("## 裁定\n\n**推荐 A**")) {
				t.Fatalf("superseded bytes: %+v", version)
			}
		}
	}
	if superseded == nil || !strings.HasPrefix(*superseded, "20") {
		t.Fatalf("old version was not superseded: %v", superseded)
	}
	// The superseded body is still readable, which is what makes an old citation checkable.
	old, err := a.ContentVersion(ctx, *beforeID)
	if err != nil {
		t.Fatal(err)
	}
	if old.Format != "markdown" || old.SelectedBy != 0 || old.Text != "## 裁定\n\n**推荐 A**" {
		t.Fatalf("superseded content: %+v", old)
	}
	renderedCount := 0
	for _, version := range after.Versions {
		if version.Role == "assistant" && version.Format == "rendered-text" {
			renderedCount++
		}
	}
	if renderedCount != 2 {
		t.Fatalf("rendered versions: %d", renderedCount)
	}
}

func TestRenderedTextIsRetainedButNeverSelected(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	if _, err := a.Publish(ctx, taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	turn := history.Turns[0]
	if turn.CaptureStatus != "pending" || turn.Reply != nil || turn.ReplyFormat != nil || turn.ReplySource != nil {
		t.Fatalf("rendered text became the reply: %+v", turn)
	}
	if turn.ReplyRendered == nil || *turn.ReplyRendered != renderedText {
		t.Fatalf("rendered text not archived: %+v", turn.ReplyRendered)
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "推荐 A", Role: "assistant"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 1 || hits.Hits[0].Format != "rendered-text" || hits.Hits[0].Source != "page-observation" {
		t.Fatalf("rendered search hit: %+v", hits.Hits)
	}
	again, err := a.Publish(ctx, taskDoc(), "fh-1")
	if err != nil {
		t.Fatal(err)
	}
	if !again.Unchanged || !reflect.DeepEqual(again.Gaps, []archive.Gap{{RunID: "r1", Code: "markdown_missing"}}) {
		t.Fatalf("unchanged partial publish: %+v", again)
	}

	notice := a.PublishNotice(ctx, taskDoc(), "fh-1")
	if notice.Status != "partial" || notice.Runs != 0 || notice.Versions != 0 || notice.Stats == nil {
		t.Fatalf("notice: %+v", notice)
	}
}

func TestRecaptureOfSameRenderedTurnArchivesNewMarkdown(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	withMarkdown := cloneTask(taskDoc())
	withMarkdown.Runs[0].Reply.Markdown = "## 裁定\n\n推荐 [A](https://example.com/a)"
	if _, err := a.Publish(ctx, withMarkdown, "fh-1"); err != nil {
		t.Fatal(err)
	}
	recaptured := cloneTask(withMarkdown)
	recaptured.Runs[0].Reply.Markdown = "## 裁定\n\n推荐 [A](https://example.com/b)"
	result, err := a.Publish(ctx, recaptured, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if result.Versions != 1 {
		t.Fatalf("recapture versions: %+v", result)
	}
	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if history.Turns[0].Reply == nil || *history.Turns[0].Reply != "## 裁定\n\n推荐 [A](https://example.com/b)" {
		t.Fatalf("recaptured reply: %+v", history.Turns[0].Reply)
	}
	stats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.MarkdownVersions != 2 {
		t.Fatalf("markdown versions: %+v", stats)
	}
}

func TestRunMetadataRefreshesWithoutContentVersion(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	withMarkdown := cloneTask(taskDoc())
	withMarkdown.Runs[0].Reply.Markdown = "## 裁定"
	if _, err := a.Publish(ctx, withMarkdown, "fh-1"); err != nil {
		t.Fatal(err)
	}
	churn := cloneTask(withMarkdown)
	churn.Runs[0].State = store.Blocked
	churn.Runs[0].Error = "OBSERVATION_FAILED"
	churn.Runs[0].LastObservedAt = "2026-09-21T09:00:00.000Z"
	result, err := a.Publish(ctx, churn, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if result.Versions != 0 {
		t.Fatalf("metadata churn versions: %+v", result)
	}
	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	turn := history.Turns[0]
	if turn.RunState != "blocked" || turn.RunError == nil || *turn.RunError != "OBSERVATION_FAILED" {
		t.Fatalf("run metadata: %+v", turn)
	}
	if turn.LastObservedAt == nil || *turn.LastObservedAt != "2026-09-21T09:00:00.000Z" {
		t.Fatalf("observed time: %+v", turn.LastObservedAt)
	}
}

func TestCollidingRunRollsBackWholePublication(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	first := cloneTask(taskDoc())
	first.Runs[0].Reply.Markdown = "Answer A"
	if _, err := a.Publish(ctx, first, "fh-1"); err != nil {
		t.Fatal(err)
	}
	before, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	beforeStats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}

	second := cloneTask(first)
	second.ID = "other"
	second.Runs[0].Reply.Markdown = "Answer B"
	unique := cloneTask(first).Runs[0]
	unique.ID = "unique"
	unique.RequestID = "unique"
	second.Runs = append([]store.Run{unique}, second.Runs...)
	// One valid run precedes the conflict, so rejection must also roll it back.
	_, err = a.Publish(ctx, second, "fh-2")
	if err == nil || !strings.Contains(err.Error(), "ARCHIVE_RUN_TASK_CONFLICT") {
		t.Fatalf("conflict error: %v", err)
	}
	after, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("failed publication changed history")
	}
	afterStats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeStats, afterStats) {
		t.Fatalf("failed publication changed stats: %+v != %+v", beforeStats, afterStats)
	}
}

func TestReactivationPreservesContentIDs(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	task := taskDoc()
	publish := func(text, hash string) archive.Turn {
		task.Runs[0].Reply.Markdown = text
		task.Runs[0].Reply.Text = text
		task.Runs[0].ReplyHash = sha(text)
		if _, err := a.Publish(ctx, task, hash); err != nil {
			t.Fatal(err)
		}
		history, err := a.History(ctx, "review", archive.HistoryOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return history.Turns[0]
	}
	aTurn := publish("A", "a")
	bTurn := publish("B", "b")
	reverted := publish("A", "a-again")

	for key, aID := range map[string]*string{
		"reply":    aTurn.ReplyVersionID,
		"rendered": aTurn.RenderedVersionID,
	} {
		var revertedID *string
		if key == "reply" {
			revertedID = reverted.ReplyVersionID
		} else {
			revertedID = reverted.RenderedVersionID
		}
		if aID == nil || revertedID == nil || *aID != *revertedID {
			t.Fatalf("%s version id was not reactivated: %v vs %v", key, aID, revertedID)
		}
		content, err := a.ContentVersion(ctx, *aID)
		if err != nil {
			t.Fatal(err)
		}
		if content.SelectedBy != 1 || content.SupersededAt != nil || content.Text != "A" {
			t.Fatalf("%s reactivated content: %+v", key, content)
		}
	}
	for _, bID := range []*string{bTurn.ReplyVersionID, bTurn.RenderedVersionID} {
		if bID == nil {
			t.Fatal("B version missing")
		}
		content, err := a.ContentVersion(ctx, *bID)
		if err != nil {
			t.Fatal(err)
		}
		if content.SupersededAt == nil || content.SelectedBy != 0 {
			t.Fatalf("B was not superseded: %+v", content)
		}
	}
	cTurn := publish("C", "c")
	for _, pair := range [][2]*string{
		{cTurn.ReplyVersionID, aTurn.ReplyVersionID},
		{cTurn.RenderedVersionID, aTurn.RenderedVersionID},
		{bTurn.ReplyVersionID, aTurn.ReplyVersionID},
		{bTurn.RenderedVersionID, aTurn.RenderedVersionID},
	} {
		if pair[0] == nil || pair[1] == nil {
			t.Fatal("version missing")
		}
		content, err := a.ContentVersion(ctx, *pair[0])
		if err != nil {
			t.Fatal(err)
		}
		if content.Supersedes == nil || *content.Supersedes != *pair[1] {
			t.Fatalf("predecessor: %+v", content)
		}
	}
}

func TestMultipleRunsKeepSequenceAndDeduplicateContent(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	task := taskDoc()
	if _, err := a.Publish(ctx, task, "fh-1"); err != nil {
		t.Fatal(err)
	}
	second := cloneTask(task).Runs[0]
	second.ID = "r2"
	second.RequestID = "followup"
	second.Prompt = "[M2]\n\n第二轮：多租户审计"
	second.PromptHash = sha(second.Prompt)
	second.Marker = "[M2]"
	second.UserMessageID = "u2"
	second.CreatedAt = "2026-09-20T02:00:00.000Z"
	second.LastObservedAt = "2026-09-20T02:05:00.000Z"
	second.Reply = &store.Reply{ID: "m2", Role: "assistant", Text: "第二轮结论", Markdown: "## 第二轮\n\n多租户审计完成", Final: true}
	second.ReplyHash = sha("第二轮结论")
	task.Runs = append(task.Runs, second)
	result, err := a.Publish(ctx, task, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if result.Runs != 2 || result.Versions != 3 {
		t.Fatalf("second publication: %+v", result)
	}
	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Turns) != 2 || history.Turns[0].RunID != "r1" || history.Turns[1].RunID != "r2" {
		t.Fatalf("turns: %+v", history.Turns)
	}
	if history.Turns[1].Reply == nil || *history.Turns[1].Reply != "## 第二轮\n\n多租户审计完成" {
		t.Fatalf("second reply: %+v", history.Turns[1].Reply)
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "多租户审计", Role: "assistant"})
	if err != nil || hits.Total != 1 || hits.Hits[0].RunID != "r2" {
		t.Fatalf("second run search: %+v %v", hits, err)
	}
	stats, err := a.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Runs != 2 || stats.Versions != 5 || stats.MarkdownVersions != 1 {
		t.Fatalf("stats: %+v", stats)
	}
}

func TestAttachedTaskKeepsImportOriginAndPromptSource(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	task := taskDoc()
	task.URL = ""
	task.Runs[0].RequestID = "import"
	if _, err := a.Publish(ctx, task, "fh-import"); err != nil {
		t.Fatal(err)
	}
	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if history.Task.Origin != "attach" || history.Task.URL != nil || history.Task.ConversationID != nil {
		t.Fatalf("attached task: %+v", history.Task)
	}
	for _, version := range history.Versions {
		if version.Format == "prompt-source" && version.Source != "attach" {
			t.Fatalf("attached prompt source: %+v", version)
		}
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "防枚举"})
	if err != nil || hits.Total != 1 {
		t.Fatalf("attached search: %+v %v", hits, err)
	}
}

func TestCoverageSeparatesStates(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	task := taskDoc()
	if _, err := a.Publish(ctx, task, "fh-1"); err != nil {
		t.Fatal(err)
	}
	coverage, err := a.Coverage(ctx, &task, "fh-1")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "markdown-incomplete" || len(coverage.MarkdownMissingRuns) != 1 {
		t.Fatalf("markdown coverage: %+v", coverage)
	}
	captured := cloneTask(task)
	captured.Runs[0].Reply.Markdown = "## 裁定\n\n独立标题"
	if _, err := a.Publish(ctx, captured, "fh-2"); err != nil {
		t.Fatal(err)
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "独立标题"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 1 || hits.Hits[0].Format != "markdown" {
		t.Fatalf("captured markdown search: %+v", hits.Hits)
	}
	coverage, err = a.Coverage(ctx, &captured, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "current" {
		t.Fatalf("current coverage: %+v", coverage)
	}
	second := cloneTask(captured)
	second.Runs = append(second.Runs, store.Run{
		ID:         "r2",
		RequestID:  "round-2",
		Prompt:     "P2",
		PromptHash: sha("P2"),
		State:      store.Delivered,
		CreatedAt:  "2026-09-20T02:00:00.000Z",
	})
	coverage, err = a.Coverage(ctx, &second, "fh-3")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "incomplete" || !reflect.DeepEqual(coverage.MissingRuns, []string{"r2"}) {
		t.Fatalf("missing run coverage: %+v", coverage)
	}
	unknown, err := a.Coverage(ctx, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if unknown.State != "unknown" || unknown.Reason != "task_document_unavailable" || unknown.RemoteHistory != "unknown" {
		t.Fatalf("unknown coverage: %+v", unknown)
	}
}

func TestCoverageDetectsUnpublishedMarkdownAndMissingPrompt(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	task := cloneTask(taskDoc())
	task.Runs[0].Reply.Markdown = "[A](https://example.com/old)"
	if _, err := a.Publish(ctx, task, "fh-1"); err != nil {
		t.Fatal(err)
	}
	task.Runs[0].Reply.Markdown = "[A](https://example.com/new)"
	coverage, err := a.Coverage(ctx, &task, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "incomplete" || !reflect.DeepEqual(coverage.MissingRuns, []string{"r1"}) {
		t.Fatalf("drift coverage: %+v", coverage)
	}
	if _, err := a.Publish(ctx, task, "fh-2"); err != nil {
		t.Fatal(err)
	}
	coverage, err = a.Coverage(ctx, &task, "fh-2")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "current" {
		t.Fatalf("after republish: %+v", coverage)
	}
	task.Runs[0].RequestID = "import"
	task.Runs[0].Prompt = ""
	task.Runs[0].PromptHash = ""
	result, err := a.Publish(ctx, task, "fh-3")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Gaps, []archive.Gap{{RunID: "r1", Code: "prompt_not_captured"}}) {
		t.Fatalf("prompt gap: %+v", result.Gaps)
	}
	coverage, err = a.Coverage(ctx, &task, "fh-3")
	if err != nil {
		t.Fatal(err)
	}
	if coverage.State != "incomplete" || !reflect.DeepEqual(coverage.PromptMissingRuns, []string{"r1"}) {
		t.Fatalf("prompt coverage: %+v", coverage)
	}
}
