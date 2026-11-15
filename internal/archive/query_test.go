package archive_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/MarioJames/convorel/internal/archive"
)

func TestSearchChineseShortAndSpecialTerms(t *testing.T) {
	ctx := context.Background()
	a := openExisting(t, createLegacyFixture(t))

	hits, err := a.Search(ctx, archive.SearchInput{Query: "多租户", Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if hits.Engine != "trigram" || hits.Total != 2 || len(hits.Hits) != 2 {
		t.Fatalf("Chinese trigram search: %+v", hits)
	}
	if !strings.Contains(hits.Hits[0].Excerpt, "[多租户]") {
		t.Fatalf("snippet: %q", hits.Hits[0].Excerpt)
	}
	if hits.Hits[0].Role != "user" || hits.Hits[1].Role != "assistant" {
		t.Fatalf("roles: %+v", hits.Hits)
	}
	if hits.Hits[0].RemoteID == nil || *hits.Hits[0].RemoteID != "abc-123" {
		t.Fatalf("remote id: %+v", hits.Hits[0].RemoteID)
	}

	short, err := a.Search(ctx, archive.SearchInput{Query: "入口", Role: "user"})
	if err != nil {
		t.Fatal(err)
	}
	if short.Engine != "literal-scan" || short.Total != 1 || len(short.Hits) != 1 {
		t.Fatalf("short literal scan: %+v", short)
	}
	if short.Hits[0].Rank != nil {
		t.Fatalf("literal scan reported an FTS rank: %+v", short.Hits[0].Rank)
	}
	shortAssistant, err := a.Search(ctx, archive.SearchInput{Query: "入口", Role: "assistant"})
	if err != nil {
		t.Fatal(err)
	}
	if shortAssistant.Total != 0 {
		t.Fatalf("short assistant search: %+v", shortAssistant)
	}

	// Quotes and FTS operators are literal text, never caller-supplied syntax.
	for _, query := range []string{`NEAR "abc" *`, `多%租户`, `*`, `OR`} {
		result, err := a.Search(ctx, archive.SearchInput{Query: query})
		if err != nil {
			t.Fatalf("query %q: %v", query, err)
		}
		if result.Total != 0 {
			t.Fatalf("query %q matched unexpectedly: %+v", query, result)
		}
	}
	// A single quote is an ordinary one-character literal, not query syntax.
	if result, err := a.Search(ctx, archive.SearchInput{Query: `"`}); err != nil {
		t.Fatalf("literal quote: %v", err)
	} else if result.Total != 1 || result.Hits[0].Role != "user" || result.Engine != "literal-scan" {
		t.Fatalf("literal quote: %+v", result)
	}
	// A quoted three-character term is still an ordinary phrase.
	if result, err := a.Search(ctx, archive.SearchInput{Query: `"A"`}); err != nil {
		t.Fatalf("quoted term: %v", err)
	} else if result.Total != 1 || result.Engine != "trigram" {
		t.Fatalf("quoted term: %+v", result)
	}

	for _, input := range []archive.SearchInput{
		{Query: "   "},
		{Query: "x\x00y"},
		{Query: strings.Repeat("x", 513)},
		{Query: "推荐", Role: "root"},
		{Query: "推荐", Limit: 101},
		{Query: "推荐", Limit: -1},
		{Query: "推荐", Offset: -1},
	} {
		if _, err := a.Search(ctx, input); err == nil {
			t.Fatalf("search accepted invalid input: %+v", input)
		}
	}
}

func TestSearchReportsSelectedVersionOnly(t *testing.T) {
	ctx := context.Background()
	a := openArchive(t, t.TempDir())
	if _, err := a.Publish(ctx, taskDoc(), "fh-1"); err != nil {
		t.Fatal(err)
	}
	withMarkdown := cloneTask(taskDoc())
	withMarkdown.Runs[0].Reply.Markdown = "## 裁定\n\n**推荐 A**\n\n| 文件 | 哈希 |\n| --- | --- |\n| route.ts | 2d89 |"
	if _, err := a.Publish(ctx, withMarkdown, "fh-2"); err != nil {
		t.Fatal(err)
	}
	hits, err := a.Search(ctx, archive.SearchInput{Query: "route.ts"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits.Hits) != 1 || hits.Hits[0].Format != "markdown" || hits.Hits[0].Role != "assistant" {
		t.Fatalf("markdown hit: %+v", hits.Hits)
	}
	// The rendered copy holds the same words but is no longer what the run selected.
	shared, err := a.Search(ctx, archive.SearchInput{Query: "推荐 A"})
	if err != nil {
		t.Fatal(err)
	}
	if len(shared.Hits) != 1 || shared.Hits[0].VersionID != hits.Hits[0].VersionID {
		t.Fatalf("rendered copy was selected too: %+v", shared.Hits)
	}
}

func TestSearchPaginationAndTotal(t *testing.T) {
	ctx := context.Background()
	a := openExisting(t, createLegacyFixture(t))
	first, err := a.Search(ctx, archive.SearchInput{Query: "多租户", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 2 || len(first.Hits) != 1 {
		t.Fatalf("first page: %+v", first)
	}
	second, err := a.Search(ctx, archive.SearchInput{Query: "多租户", Limit: 1, Offset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if second.Total != 2 || len(second.Hits) != 1 || second.Hits[0].VersionID == first.Hits[0].VersionID {
		t.Fatalf("second page: %+v", second)
	}
	empty, err := a.Search(ctx, archive.SearchInput{Query: "多租户", Offset: 2})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Total != 2 || len(empty.Hits) != 0 {
		t.Fatalf("past the end: %+v", empty)
	}
}

func TestHistoryAndImmutableContent(t *testing.T) {
	ctx := context.Background()
	path := createLegacyFixture(t)
	a := openExisting(t, path)

	history, err := a.History(ctx, "review", archive.HistoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if history.Task.ID != "review" || history.Task.State != "complete" ||
		history.Task.URL == nil || *history.Task.URL != chatGPTURL ||
		history.Task.RemoteID == nil || *history.Task.RemoteID != "abc-123" ||
		history.Task.ProjectName == nil || *history.Task.ProjectName != "proj" ||
		history.Task.NamingType == nil || *history.Task.NamingType != "DES" ||
		history.Task.Topic == nil || *history.Task.Topic != "注册防枚举" ||
		history.Task.Origin != "convorel" {
		t.Fatalf("task: %+v", history.Task)
	}
	if len(history.Turns) != 1 {
		t.Fatalf("turns: %+v", history.Turns)
	}
	turn := history.Turns[0]
	if turn.RunID != "r1" || turn.Prompt == nil || *turn.Prompt != fixturePrompt ||
		turn.Reply == nil || *turn.Reply != fixtureMarkdown ||
		turn.ReplyRendered == nil || *turn.ReplyRendered != fixtureRendered ||
		turn.CaptureStatus != "captured" {
		t.Fatalf("turn: %+v", turn)
	}
	if turn.PromptVersionID == nil || *turn.PromptVersionID != promptVersionID {
		t.Fatalf("prompt version: %+v", turn.PromptVersionID)
	}
	if len(history.Versions) != 4 {
		t.Fatalf("versions: %+v", history.Versions)
	}

	prompt, err := a.ContentVersion(ctx, promptVersionID)
	if err != nil {
		t.Fatal(err)
	}
	if prompt.Role != "user" || prompt.Format != "prompt-source" ||
		prompt.Text != fixturePrompt || prompt.SelectedBy != 1 ||
		prompt.Bytes != len([]byte(fixturePrompt)) ||
		prompt.Characters != int64(len([]rune(fixturePrompt))) {
		t.Fatalf("prompt content: %+v", prompt)
	}
	old, err := a.ContentVersion(ctx, supersededVersionID)
	if err != nil {
		t.Fatal(err)
	}
	if old.SupersededAt == nil || old.SelectedBy != 0 {
		t.Fatalf("superseded content: %+v", old)
	}
	if _, err := a.ContentVersion(ctx, "not-a-uuid"); err == nil {
		t.Fatal("invalid version id accepted")
	}
	if _, err := a.ContentVersion(ctx, "99999999-9999-4999-8999-999999999999"); err == nil {
		t.Fatal("missing version accepted")
	}
	if _, err := a.History(ctx, "missing", archive.HistoryOptions{}); err == nil {
		t.Fatal("missing task accepted")
	}
	filtered, err := a.History(ctx, "review", archive.HistoryOptions{RunID: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Turns) != 1 || len(filtered.Versions) != 4 {
		t.Fatalf("run filter: %+v", filtered)
	}
	none, err := a.History(ctx, "review", archive.HistoryOptions{RunID: "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(none.Turns) != 0 || len(none.Versions) != 0 {
		t.Fatalf("missing run filter: %+v", none)
	}
}

func TestLegacyReadDoesNotMutateFiles(t *testing.T) {
	path := createLegacyFixture(t)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	entriesBefore, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := openExisting(t, path)
	if _, err := a.Search(context.Background(), archive.SearchInput{Query: "多租户"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("read-only open changed the database bytes")
	}
	entriesAfter, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entriesAfter) != len(entriesBefore) {
		t.Fatalf("read-only open left sidecars: before %v after %v", entriesBefore, entriesAfter)
	}
}

func TestConversationIDExtraction(t *testing.T) {
	for raw, want := range map[string]string{
		"https://chatgpt.com/c/abc-123":                  "abc-123",
		"https://chatgpt.com/g/g-p-1/proj/c/abc-123":     "abc-123",
		"https://chatgpt.com:443/g/g-p-1/proj/c/abc-123": "abc-123",
		"https://CHATGPT.COM/g/g-p-1/proj/c/abc-123":     "abc-123",
	} {
		got, err := archive.ConversationID(raw)
		if err != nil || got != want {
			t.Fatalf("%q: %q %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		"",
		"https://chatgpt.com/",
		"https://chatgpt.com/c/",
		"https://example.com/c/abc-123",
		"http://chatgpt.com/c/abc-123",
		"not a url",
	} {
		if _, err := archive.ConversationID(raw); err == nil {
			t.Fatalf("%q was accepted", raw)
		}
	}
}
