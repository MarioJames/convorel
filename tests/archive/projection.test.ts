import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive/store.ts";
import { publishTask } from "../../src/archive/post-archive.ts";
import { State } from "../../src/storage/state.ts";
import { sha } from "../../src/hash.ts";
import { RENDERED, taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("publishes content once and treats lifecycle churn as no content drift", () => {
  const a = new Archive(root);
  const first = a.publish(taskDoc(), "fh-1");
  expect(first).toMatchObject({ runs: 1, versions: 2 });
  expect(first.gaps).toEqual([{ runId: "r1", code: "markdown_missing" }]);
  expect(a.publish(taskDoc(), "fh-1").unchanged).toBe(true);
  const churn = structuredClone(taskDoc());
  churn.attemptId = "a2";
  churn.binding = { target: "T", epoch: "e", owned: true };
  churn.runs[0].lastObservedAt = "2026-09-21T09:00:00.000Z";
  expect(a.publish(churn, "fh-2").versions).toBe(0);
  expect(a.stats().versions).toBe(2);
  a.close();
});

test("a regenerated reply appends an immutable version and keeps the old one citable", () => {
  const a = new Archive(root);
  const first = structuredClone(taskDoc());
  first.runs[0].reply.markdown = "## 裁定\n\n**推荐 A**";
  a.publish(first, "fh-1");
  const before = a.history("review").turns[0].reply_version_id as string;
  expect(before).toBeTruthy();
  const changed = structuredClone(first);
  changed.runs[0].reply.text = "结论 改推荐 B";
  changed.runs[0].replyHash = sha("结论 改推荐 B");
  changed.runs[0].reply.markdown = "## 裁定\n\n**改推荐 B**";
  expect(a.publish(changed, "fh-2").versions).toBe(2);
  const after = a.history("review");
  expect(after.turns[0].reply_version_id).not.toBe(before);
  expect(
    after.versions.find((v: any) => v.version_id === before).superseded_at,
  ).toContain("2026-");
  // The superseded body is still readable, which is what makes an old citation checkable.
  expect(a.contentVersion(before)).toMatchObject({
    format: "markdown",
    selected_by: 0,
    text: "## 裁定\n\n**推荐 A**",
  });
  expect(
    after.versions.filter(
      (v: any) => v.role === "assistant" && v.format === "rendered-text",
    ).length,
  ).toBe(2);
  expect(after.versions.find((v: any) => v.version_id === before).bytes).toBe(
    Buffer.byteLength("## 裁定\n\n**推荐 A**"),
  );
  a.close();
});

test("rendered text is retained but never selected as the reply body", async () => {
  const a = new Archive(root);
  a.publish(taskDoc(), "fh-1");
  const turn = a.history("review").turns[0];
  expect(turn).toMatchObject({
    capture_status: "pending",
    reply_format: null,
    reply_source: null,
  });
  expect(turn.reply).toBeNull();
  expect(turn.reply_rendered).toBe(RENDERED);
  // It stays reachable as the best available body, disclosed by its format.
  const hit = a.search({ query: "推荐 A", role: "assistant" })[0];
  expect(hit).toMatchObject({
    format: "rendered-text",
    source: "page-observation",
  });
  expect(a.publish(taskDoc(), "fh-1")).toMatchObject({
    unchanged: true,
    gaps: [{ runId: "r1", code: "markdown_missing" }],
  });
  new State(root).write("task-review", taskDoc());
  expect((await publishTask(root, "review")).status).toBe("partial");
  a.close();
});

test("a re-capture of the same rendered turn archives the new Markdown", () => {
  const a = new Archive(root);
  const withMarkdown = structuredClone(taskDoc());
  withMarkdown.runs[0].reply.markdown =
    "## 裁定\n\n推荐 [A](https://example.com/a)";
  a.publish(withMarkdown, "fh-1");
  // Same rendered text, same message id, only the copied source differs.
  const recaptured = structuredClone(withMarkdown);
  recaptured.runs[0].reply.markdown =
    "## 裁定\n\n推荐 [A](https://example.com/b)";
  expect(a.publish(recaptured, "fh-2").versions).toBe(1);
  const turn = a.history("review").turns[0];
  expect(turn.reply).toBe("## 裁定\n\n推荐 [A](https://example.com/b)");
  expect(a.stats().markdownVersions).toBe(2);
  a.close();
});

test("run metadata refreshes even when no content version is created", () => {
  const a = new Archive(root);
  const withMarkdown = structuredClone(taskDoc());
  withMarkdown.runs[0].reply.markdown = "## 裁定";
  a.publish(withMarkdown, "fh-1");
  const churn = structuredClone(withMarkdown);
  churn.runs[0].state = "blocked";
  churn.runs[0].error = "OBSERVATION_FAILED";
  churn.runs[0].lastObservedAt = "2026-09-21T09:00:00.000Z";
  expect(a.publish(churn, "fh-2").versions).toBe(0);
  expect(a.history("review").turns[0]).toMatchObject({
    run_state: "blocked",
    run_error: "OBSERVATION_FAILED",
    last_observed_at: "2026-09-21T09:00:00.000Z",
  });
  a.close();
});

test("a colliding run from another task rejects the whole publication without changing archived history", async () => {
  const state = new State(root),
    archive = new Archive(root);
  const first = taskDoc();
  first.runs[0].reply.markdown = "Answer A";
  state.write("task-review", first);
  expect((await publishTask(root, first.id)).status).toBe("stored");
  const before = archive.history(first.id),
    stats = archive.stats();
  const second = structuredClone(first);
  second.id = "other";
  second.runs[0].reply.markdown = "Answer B";
  // One valid run precedes the conflict, so rejection must also roll it back.
  second.runs.unshift({
    ...structuredClone(second.runs[0]),
    id: "unique",
    requestId: "unique",
  });
  state.write("task-other", second);
  const result = await publishTask(root, second.id);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("ARCHIVE_RUN_TASK_CONFLICT");
  expect(archive.history(first.id)).toEqual(before);
  expect(archive.stats()).toEqual(stats);
  archive.close();
});

test("A-B-A reactivation preserves content IDs while updating active metadata and the next predecessor", () => {
  const archive = new Archive(root),
    task = taskDoc();
  const publish = (text: string, hash: string) => {
    task.runs[0].reply.markdown = text;
    task.runs[0].reply.text = text;
    task.runs[0].replyHash = sha(text);
    archive.publish(task, hash);
    return archive.history(task.id).turns[0];
  };
  const a = publish("A", "a"),
    b = publish("B", "b"),
    reverted = publish("A", "a-again");
  for (const key of ["reply_version_id", "rendered_version_id"] as const) {
    expect(reverted[key]).toBe(a[key]);
    expect(archive.contentVersion(a[key])).toMatchObject({
      selected_by: 1,
      superseded_at: null,
      text: "A",
    });
    expect(archive.contentVersion(b[key]).superseded_at).toBeTruthy();
    expect(archive.contentVersion(b[key]).selected_by).toBe(0);
  }
  const c = publish("C", "c");
  expect(archive.contentVersion(c.reply_version_id).supersedes).toBe(
    a.reply_version_id,
  );
  expect(archive.contentVersion(c.rendered_version_id).supersedes).toBe(
    a.rendered_version_id,
  );
  expect(archive.contentVersion(b.reply_version_id).supersedes).toBe(
    a.reply_version_id,
  );
  archive.close();
});
