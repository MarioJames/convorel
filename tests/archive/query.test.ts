import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive/store.ts";
import { sha } from "../../src/hash.ts";
import { taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("Chinese search uses trigrams, short queries scan literally, terms stay literal", () => {
  const a = new Archive(root);
  a.publish(taskDoc(), "fh-1");
  const hits = a.search({ query: "防枚举" });
  expect(hits.length).toBe(1);
  expect(hits[0]).toMatchObject({ engine: "trigram", role: "user" });
  expect(hits[0].excerpt).toContain("[防枚举]");
  const short = a.search({ query: "入口", role: "assistant" });
  expect(short.length).toBe(0);
  expect(a.search({ query: "入口", role: "user" })[0]?.engine).toBe(
    "literal-scan",
  );
  // Quotes and FTS operators are literal text, never caller-supplied query syntax.
  expect(() => a.search({ query: 'NEAR "abc" * x' })).not.toThrow();
  expect(a.search({ query: "NEAR" })).toEqual([]);
  expect(() => a.search({ query: "   " })).toThrow("INVALID_SEARCH_QUERY");
  expect(() => a.search({ query: "推荐", role: "root" })).toThrow(
    "INVALID_ROLE",
  );
  expect(() => a.search({ query: "推荐", limit: 500 })).toThrow(
    "INVALID_LIMIT",
  );
  a.close();
});

test("search reports the version a run selected, not every historical copy", () => {
  const a = new Archive(root);
  a.publish(taskDoc(), "fh-1");
  const withMarkdown = structuredClone(taskDoc());
  withMarkdown.runs[0].reply.markdown =
    "## 裁定\n\n**推荐 A**\n\n| 文件 | 哈希 |\n| --- | --- |\n| route.ts | 2d89 |";
  expect(a.publish(withMarkdown, "fh-2").versions).toBe(1);
  const hits = a.search({ query: "route.ts" });
  expect(hits.length).toBe(1);
  expect(hits[0]).toMatchObject({ format: "markdown", role: "assistant" });
  // The rendered copy holds the same words but is no longer what the run selected.
  const shared = a.search({ query: "推荐 A" });
  expect(shared.length).toBe(1);
  expect(shared[0].version_id).toBe(hits[0].version_id);
  expect(a.coverage(withMarkdown, "fh-2")).toMatchObject({
    state: "current",
    markdownMissingRuns: [],
  });
  a.close();
});

test("coverage separates current, markdown-incomplete, incomplete and unknown", () => {
  const a = new Archive(root);
  const task = taskDoc();
  a.publish(task, "fh-1");
  expect(a.coverage(task, "fh-1").state).toBe("markdown-incomplete");
  const captured = structuredClone(task);
  captured.runs[0].reply.markdown = "## 裁定\n\n独立标题";
  a.publish(captured, "fh-2");
  expect(a.search({ query: "独立标题" })[0]?.format).toBe("markdown");
  expect(a.coverage(captured, "fh-2").state).toBe("current");
  const second = structuredClone(captured);
  second.runs.push({
    id: "r2",
    requestId: "round-2",
    prompt: "P2",
    promptHash: sha("P2"),
    state: "waiting",
    createdAt: "2026-09-20T02:00:00.000Z",
  });
  expect(a.coverage(second, "fh-3")).toMatchObject({
    state: "incomplete",
    missingRuns: ["r2"],
  });
  expect(a.coverage(null, null)).toMatchObject({
    state: "unknown",
    reason: "task_document_unavailable",
  });
  a.close();
});

test("coverage detects unpublished Markdown and missing attached prompts", () => {
  const a = new Archive(root);
  try {
    const task = taskDoc();
    task.runs[0].reply.markdown = "[A](https://example.com/old)";
    a.publish(task, "fh-1");
    task.runs[0].reply.markdown = "[A](https://example.com/new)";
    expect(a.coverage(task, "fh-2")).toMatchObject({
      state: "incomplete",
      missingRuns: ["r1"],
    });
    a.publish(task, "fh-2");
    expect(a.coverage(task, "fh-2").state).toBe("current");
    task.runs[0].requestId = "import";
    delete task.runs[0].prompt;
    delete task.runs[0].promptHash;
    expect(a.publish(task, "fh-3").gaps).toEqual([
      { runId: "r1", code: "prompt_not_captured" },
    ]);
    expect(a.coverage(task, "fh-3")).toMatchObject({
      state: "incomplete",
      promptMissingRuns: ["r1"],
    });
  } finally {
    a.close();
  }
});
