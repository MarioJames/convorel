import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Archive } from "../src/archive.ts";
import {
  openArchive,
  publishTask,
  scanTasks,
  taskFileHash,
} from "../src/post-archive.ts";
import {
  conversationStatus,
  conversationExitCode,
} from "../src/conversation-status.ts";
import { writePreference } from "../src/user-config.ts";
import { State } from "../src/state.ts";
import { Conversation } from "../src/conversation.ts";
import { sha } from "../src/workspace.ts";
import { childEnv } from "../src/command.ts";
import { copyMarkdownScript } from "../src/chatgpt/copy.ts";
import { waitForConversation } from "../src/wait.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const URL = "https://chatgpt.com/g/g-p-1/proj/c/abc-123";
const RENDERED = "结论 推荐 A";
const taskDoc = (overrides: any = {}) =>
  ({
    version: 1,
    id: "review",
    url: URL,
    config: {
      version: 1,
      workspace: "/home/mocha/project",
      cdp: "http://127.0.0.1:9222",
      projectName: "proj",
    },
    workspaceId: "w1",
    currentRun: "r1",
    attemptId: "a1",
    naming: { type: "DES", topic: "注册防枚举" },
    runs: [
      {
        id: "r1",
        requestId: "initial",
        prompt: "[M1]\n\n注册入口防枚举方案",
        promptHash: sha("[M1]\n\n注册入口防枚举方案"),
        marker: "[M1]",
        state: "complete",
        userMessageId: "u1",
        createdAt: "2026-09-20T01:00:00.000Z",
        lastObservedAt: "2026-09-20T01:05:00.000Z",
        reply: { id: "m1", role: "assistant", text: RENDERED, final: true },
        replyHash: sha(RENDERED),
        observedModel: "6 Pro",
        branch: ["u1", "m1"],
      },
    ],
    ...overrides,
  }) as any;

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

test("archive and local doctor fail when the store cannot be opened", async () => {
  mkdirSync(root);
  const foreign = new Database(join(root, "conversations.db"));
  foreign.exec("create table other_app (value text)");
  foreign.close();
  const archived = await cli(["conversation", "archive", "--all", "true"]);
  expect(JSON.parse(archived.out).summary.status).toBe("failed");
  expect(archived.code).toBe(1);
  const doctor = await cli(["doctor", "--local", "true"]);
  expect(JSON.parse(doctor.out).archive.status).toBe("failed");
  expect(doctor.code).toBe(1);
});

test("an exported snapshot stands alone and refuses overwrite or impersonation", () => {
  const a = new Archive(root);
  a.publish(taskDoc(), "fh-1");
  const backup = join(base, "backup");
  const snapshot = a.exportSnapshot(backup);
  expect(snapshot.bytes).toBeGreaterThan(0);
  expect(snapshot.journalMode).toBe("delete");
  expect(lstatSync(backup + "/conversations.db").mode & 0o777).toBe(0o600);
  // Only the snapshot stays behind: the staging directory is this call's own scratch.
  expect(readdirSync(backup)).toEqual(["conversations.db"]);
  // The checksum must be the file's own bytes, so an independent sha256sum matches.
  expect(snapshot.sha256).toBe(sha(readFileSync(snapshot.path)));
  expect(() => a.exportSnapshot(backup)).toThrow("EXPORT_EXISTS");
  const reopened = new Archive(backup, { create: false });
  expect(reopened.history("review").turns.length).toBe(1);
  expect(reopened.search({ query: "防枚举" }).length).toBe(1);
  expect(() => reopened.exportSnapshot(join(base, "again"))).toThrow(
    "ARCHIVE_READONLY",
  );
  reopened.close();
  a.close();
  // A renamed snapshot is read at the path given, not at its directory's default name.
  const renamed = join(base, "backup", "review-2026-09-21.db");
  linkSync(join(backup, "conversations.db"), renamed);
  const byFile = openArchive(root, { from: renamed });
  expect(byFile.notice).toBeUndefined();
  expect(byFile.archive?.path).toBe(renamed);
  expect(byFile.archive?.search({ query: "防枚举" }).length).toBe(1);
  byFile.archive?.close();
  const imposter = join(base, "imposter");
  mkdirSync(imposter);
  new Database(join(imposter, "conversations.db")).exec(
    "create table something(a)",
  );
  expect(() => new Archive(imposter, { create: false })).toThrow(
    "NOT_A_CONVOREL_ARCHIVE",
  );
  // Opening a foreign file for writing must not extend it into a half-Convorel store.
  expect(() => new Archive(imposter)).toThrow(
    "NOT_A_CONVOREL_ARCHIVE: database already holds other objects",
  );
  const wrongKind = join(base, "wrong-kind");
  mkdirSync(wrongKind);
  const foreign = new Database(join(wrongKind, "conversations.db"));
  foreign.exec("create table meta (key text primary key, value text not null)");
  foreign
    .query("insert into meta (key, value) values ('dbKind', 'other-app-db')")
    .run();
  foreign.close();
  expect(() => new Archive(wrongKind, { create: false })).toThrow(
    "NOT_A_CONVOREL_ARCHIVE: dbKind",
  );
  const linked = join(base, "linked");
  mkdirSync(linked);
  symlinkSync(join(root, "conversations.db"), join(linked, "conversations.db"));
  expect(() => new Archive(linked)).toThrow("ARCHIVE_PATH_UNSAFE");
});

test("a corrupt task document is reported without blocking the others", async () => {
  const store = new State(root);
  store.write("config", {
    version: 1,
    workspace: "/home/mocha/project",
    cdp: "http://127.0.0.1:9222",
  });
  store.write("task-review", taskDoc());
  store.write("task-half", { version: 1, id: "half", runs: "not-an-array" });
  writeFileSync(join(root, "task-truncated.json"), "{");
  const scanned = scanTasks(root);
  expect(scanned.found.map((item) => item.taskId)).toEqual(["review"]);
  expect(scanned.errors.map((error) => error.taskId).sort()).toEqual([
    "half",
    "truncated",
  ]);
  expect(await publishTask(root, scanned.found[0].taskId)).toMatchObject({
    status: "partial",
    versions: 2,
  });
  // State.tasks() stays strict: it participates in the runtime conflict check, so a
  // bad document must fail loudly there instead of quietly disappearing.
  expect(() => store.tasks()).toThrow();
});

async function cli(args: string[], stateDir = root) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "--state-dir",
      stateDir,
      "--config-dir",
      join(base, "prefs"),
      ...args,
    ],
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = async (stream: ReadableStream) =>
    new TextDecoder().decode(
      new Uint8Array(await new Response(stream).arrayBuffer()),
    );
  const out = await text(child.stdout as ReadableStream);
  return { code: await child.exited, out: out.trim() };
}

test("the archive surface needs no config, workspace or browser", async () => {
  const store = new State(root);
  store.write("config", {
    version: 1,
    workspace: "/home/mocha/project",
    cdp: "http://127.0.0.1:9222",
  });
  store.write("task-review", taskDoc());
  const imported = await cli(["conversation", "archive", "--all", "true"]);
  expect(imported.code).toBe(2);
  expect(JSON.parse(imported.out).archived[0]).toMatchObject({
    taskId: "review",
    status: "partial",
  });
  rmSync(join(root, "config.json"), { force: true });
  const search = await cli([
    "conversation",
    "search",
    "--query",
    "防枚举",
    "--fields",
    "hits",
  ]);
  expect(search.code).toBe(0);
  expect(JSON.parse(search.out).hits.length).toBe(1);
  const history = await cli([
    "conversation",
    "history",
    "--id",
    "review",
    "--fields",
    "turns",
  ]);
  expect(history.code).toBe(0);
  expect(JSON.parse(history.out).turns[0].run_id).toBe("r1");
  const listed = await cli([
    "conversation",
    "history",
    "--id",
    "review",
    "--fields",
    "versions",
  ]);
  const versionId = JSON.parse(listed.out).versions[0].version_id as string;
  const content = await cli([
    "conversation",
    "content",
    "--version",
    versionId,
    "--fields",
    "version",
  ]);
  expect(content.code).toBe(0);
  expect(JSON.parse(content.out).version).toMatchObject({
    version_id: versionId,
    role: "user",
    format: "prompt-source",
  });
  expect(JSON.parse(content.out).version.text).toContain("防枚举");
  const badVersion = await cli([
    "conversation",
    "content",
    "--version",
    "not-a-uuid",
  ]);
  expect(badVersion.code).toBe(1);
  const doctor = await cli(["doctor", "--local", "true"]);
  expect(doctor.code).toBe(2);
  const report = JSON.parse(doctor.out);
  expect(report.archive.fts_integrity_check).toBe("ok");
  expect(report.archive.coverage[0].state).toBe("markdown-incomplete");
  const rejected = await cli([
    "conversation",
    "search",
    "--query",
    "x",
    "--nope",
    "y",
  ]);
  expect(rejected.code).toBe(1);
  const empty = join(base, "empty");
  mkdirSync(empty);
  const nothing = await cli(["conversation", "search", "--query", "x"], empty);
  expect(nothing.code).toBe(1);
  expect(JSON.parse(nothing.out).notice.error).toBe("ARCHIVE_MISSING");
  const badScope = await cli(["conversation", "archive"]);
  expect(badScope.code).toBe(1);
  // --all is a boolean flag: a truthy string must not widen a single-task import.
  // --all is read as a boolean: "false" must not widen a single-task import to everything.
  const falseAll = await cli([
    "conversation",
    "archive",
    "--id",
    "review",
    "--all",
    "false",
  ]);
  expect(falseAll.code).toBe(2);
  expect(JSON.parse(falseAll.out).archived.length).toBe(1);
  expect(JSON.parse(falseAll.out).scope).toBe("review");
  // Re-running the same import writes nothing but still reports the gap it holds.
  const again = await cli(["conversation", "archive", "--id", "review"]);
  expect(again.code).toBe(2);
  expect(JSON.parse(again.out).archived[0]).toMatchObject({
    taskId: "review",
    status: "partial",
    versions: 0,
  });
  const exported = await cli([
    "conversation",
    "export",
    "--directory",
    join(base, "cli-backup"),
  ]);
  expect(exported.code).toBe(0);
  const offline = await cli([
    "conversation",
    "search",
    "--query",
    "防枚举",
    "--from",
    join(base, "cli-backup", "conversations.db"),
    "--fields",
    "hits,source",
  ]);
  expect(offline.code).toBe(0);
  expect(JSON.parse(offline.out).hits.length).toBe(1);
});

class CaptureBrowser {
  evals: string[] = [];
  copyResult: any;
  releases = 0;
  reads = 0;
  constructor(
    private target: string,
    private pageState: any,
    private laterPages: any[] = [],
  ) {}
  async epoch() {
    return "epoch1";
  }
  async release() {
    this.releases++;
  }
  async tabs(...args: string[]) {
    if (args[0] === "list")
      return { tabs: [{ targetId: this.target, url: URL }] };
    return { closed: true };
  }
  async page() {
    const page = this.pageState;
    const later = this.laterPages;
    const browser = this;
    let afterClickReads = 1;
    return {
      session: "capture",
      run: async (...args: string[]) => {
        browser.evals.push(args[1] ?? "");
        return { result: browser.copyResult };
      },
      read: async () => {
        browser.reads++;
        return structuredClone(
          (browser.evals.length ? later[afterClickReads++] : later[0]) ?? page,
        );
      },
    };
  }
}

const pageFor = (text = RENDERED) => ({
  url: URL,
  title: "t",
  generating: false,
  blocked: null,
  hasComposer: true,
  draft: "",
  sendReady: true,
  messages: [
    { id: "u1", role: "user", text: "[M1] 注册入口防枚举方案", final: true },
    { id: "m1", role: "assistant", text, final: true, model: "6 Pro" },
  ],
});

const prepared = (
  directory: string,
  target: string,
  page: any,
  laterPages: any[] = [],
) => {
  const store = new State(directory);
  store.write("config", {
    version: 1,
    workspace: "/home/mocha/project",
    cdp: "http://127.0.0.1:9222",
  });
  store.write("task-review", taskDoc());
  const browser = new CaptureBrowser(target, page, laterPages);
  return {
    store,
    browser,
    conversation: new Conversation(store, browser as any),
  };
};

test("automatic archive failures reach status and completed resume repairs the projection offline", async () => {
  const { store, browser, conversation } = prepared(root, "T1", pageFor());
  const task = store.read<any>("task-review");
  delete task.naming;
  task.runs[0].state = "waiting";
  delete task.runs[0].reply;
  store.write("task-review", task);
  browser.copyResult = { ok: true, text: "## Captured" };
  mkdirSync(join(root, "conversations.db"));

  const completed = await conversation.poll("review");
  expect(completed.runs[0].state).toBe("complete");
  expect(completed.runs[0].reply?.markdown).toBe("## Captured");
  expect(conversationStatus(completed)).toMatchObject({
    archive: {
      status: "failed",
      error: expect.stringContaining("ARCHIVE_PATH_UNSAFE"),
    },
    state: "complete",
    nextAction: "result",
    error: null,
  });
  expect(conversationExitCode(completed, "resume")).toBe(0);
  expect(store.read<any>("task-review").archive).toBeUndefined();
  expect(browser.evals.length).toBe(1);

  renameSync(join(root, "conversations.db"), join(root, "unavailable-db"));
  browser.page = async () => {
    throw new Error("BROWSER_OFFLINE");
  };
  const resumed = await conversation.resume("review");
  expect(conversationStatus(resumed)).toMatchObject({
    archive: { status: "stored" },
  });
  expect(browser.evals.length).toBe(1);
  expect(store.read<any>("task-review").archive).toBeUndefined();
  const reports: any[] = [];
  expect(
    await waitForConversation(
      store,
      conversation,
      "review",
      "r1",
      1,
      new AbortController().signal,
      (value) => reports.push(value),
    ),
  ).toBe(0);
  expect(reports).toMatchObject([
    { state: "complete", archive: { status: "stored" } },
  ]);
  const archive = new Archive(root);
  expect(archive.history("review").turns[0].reply).toBe("## Captured");
  expect(
    archive.coverage(store.read("task-review"), taskFileHash(root, "review"))
      .state,
  ).toBe("current");
  archive.close();
});

test("automatic copy gaps stay separate from successful delivery", async () => {
  const { store, browser, conversation } = prepared(root, "T1", pageFor());
  const task = store.read<any>("task-review");
  delete task.naming;
  task.runs[0].state = "waiting";
  delete task.runs[0].reply;
  store.write("task-review", task);
  browser.copyResult = { ok: false, reason: "COPY_BUTTON_MISSING" };
  const completed = await conversation.poll("review");
  expect(conversationStatus(completed)).toMatchObject({
    state: "complete",
    error: null,
    archive: {
      status: "partial",
      gaps: [{ runId: "r1", code: "markdown_capture_failed" }],
    },
  });
});

for (const changed of [false, true]) {
  test(`pending naming preserves the durable completed reply with page changed=${changed}`, async () => {
    const { store, browser } = prepared(
      root,
      "T1",
      pageFor(changed ? "Changed reply" : RENDERED),
    );
    const task = store.read<any>("task-review");
    task.runs[0].reply.markdown = "## Already captured";
    store.write("task-review", task);
    await publishTask(root, task.id);
    const prior = structuredClone(task.runs[0]);
    browser.copyResult = { ok: false, reason: "COPY_BUTTON_MISSING" };
    let organized = 0;
    const conversation = new Conversation(
      store,
      browser as any,
      undefined,
      async () => {
        organized++;
        return { verified: true } as any;
      },
    );
    await conversation.poll("review");
    expect(organized).toBe(0);
    const result = await conversation.ensureNaming("review", task.currentRun);
    expect(result.runs[0]).toMatchObject({
      state: "complete",
      reply: prior.reply,
      replyHash: prior.replyHash,
      branch: prior.branch,
    });
    expect(store.read<any>("task-review").runs[0].reply).toEqual(prior.reply);
    // Naming does not depend on reply bytes; the captured reply above remains immutable.
    expect(result.organization.verified).toBe(true);
    expect(organized).toBe(1);
    expect(browser.evals).toEqual([]);
    expect(conversationStatus(result)).toMatchObject({
      archive: { status: "stored" },
    });
    const archive = new Archive(root);
    expect(archive.history("review").turns[0].reply).toBe(
      "## Already captured",
    );
    archive.close();
  });
}

test("publishing an earlier scan uses current source JSON after a newer capture", async () => {
  const { browser, conversation } = prepared(root, "T1", pageFor());
  const stale = scanTasks(root).found[0];
  expect(stale.task.runs[0].reply?.markdown).toBeUndefined();
  browser.copyResult = { ok: true, text: "## Latest captured" };
  await conversation.capture("review");
  expect(await publishTask(root, stale.taskId)).toMatchObject({
    status: "stored",
  });
  const archive = new Archive(root);
  expect(archive.history("review").turns[0].reply).toBe("## Latest captured");
  const current = scanTasks(root).found[0];
  expect(archive.coverage(current.task, current.hash).state).toBe("current");
  archive.close();
});

for (const serial of [false, true]) {
  test(`archive waits for the source writer before reading JSON (serial=${serial})`, async () => {
    const { store, browser, conversation } = prepared(root, "T1", pageFor());
    const stale = scanTasks(root).found[0];
    writePreference("browser.serial", String(serial));
    let copied!: () => void;
    let release!: () => void;
    const copying = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const resumeCopy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await browser.page();
    browser.page = async () => ({
      ...page,
      run: async () => {
        copied();
        await resumeCopy;
        return { result: { ok: true, text: "## Concurrent capture" } };
      },
    });
    let capture: Promise<unknown> | undefined;
    let publish: Promise<unknown> | undefined;
    try {
      capture = conversation.capture("review");
      await copying;
      let published = false;
      publish = publishTask(root, stale.taskId).then((result) => {
        published = true;
        return result;
      });
      await Bun.sleep(60);
      expect(published).toBe(false);
      release();
      await capture;
      expect(await publish).toMatchObject({ status: "stored" });
      const archive = new Archive(root);
      expect(archive.history("review").turns[0].reply).toBe(
        "## Concurrent capture",
      );
      expect(
        archive.coverage(
          store.read("task-review"),
          taskFileHash(root, "review"),
        ).state,
      ).toBe("current");
      archive.close();
    } finally {
      release();
      await Promise.allSettled([capture, publish]);
      writePreference("browser.serial", "");
    }
  });
}

test("archive lock timeout is reported separately and never steals the writer lock", async () => {
  const store = new State(root);
  store.write("task-review", taskDoc());
  writePreference("locks.taskWaitMs", "50");
  try {
    await store.locked(async () => {
      const before = readFileSync(store.path("lock-task-review"), "utf8");
      expect(await publishTask(root, "review")).toMatchObject({
        status: "failed",
        error: expect.stringContaining("LOCK_BUSY"),
      });
      expect(readFileSync(store.path("lock-task-review"), "utf8")).toBe(before);
      expect(Archive.available(root)).toBe(false);
    }, "task-review");
    expect((await publishTask(root, "review")).status).toBe("partial");
  } finally {
    writePreference("locks.taskWaitMs", "");
  }
});

test("an unreadable current source cannot replace the archive with an earlier scan", async () => {
  const store = new State(root);
  const task = taskDoc();
  task.runs[0].reply.markdown = "## Retained";
  store.write("task-review", task);
  const stale = scanTasks(root).found[0];
  expect((await publishTask(root, "review")).status).toBe("stored");
  writeFileSync(store.path("task-review"), "{");
  expect(await publishTask(root, stale.taskId)).toMatchObject({
    status: "failed",
  });
  const archive = new Archive(root);
  expect(archive.history("review").turns[0].reply).toBe("## Retained");
  archive.close();
});

test("capture stores copied Markdown without touching run state", async () => {
  const { store, browser, conversation } = prepared(
    join(base, "captured"),
    "T1",
    pageFor(),
  );
  browser.copyResult = { ok: true, text: "## 裁定\n\n**推荐 A**", length: 18 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: ["r1"],
    gaps: [],
    archive: { status: "stored" },
  });
  const task = store.read<any>("task-review");
  expect(task.runs[0].reply.markdown).toBe("## 裁定\n\n**推荐 A**");
  expect(task.runs[0].state).toBe("complete");
  expect(task.runs[0].error).toBeUndefined();
  const archived = new Archive(join(base, "captured"));
  expect(archived.history("review").turns[0].reply_format).toBe("markdown");
  expect(archived.coverage(task, "x").markdownMissingRuns).toEqual([]);
  archived.close();
});

test("a failed capture records a gap and never becomes a run failure", async () => {
  const { store, browser, conversation } = prepared(
    join(base, "failed"),
    "T2",
    pageFor(),
  );
  browser.copyResult = { ok: false, reason: "COPY_BUTTON_MISSING" };
  const result = await conversation.capture("review");
  expect(result).toMatchObject({
    captured: [],
    gaps: [{ runId: "r1", code: "COPY_BUTTON_MISSING" }],
  });
  const task = store.read<any>("task-review");
  expect(task.runs[0].state).toBe("complete");
  expect(task.runs[0].error).toBeUndefined();
  expect(task.runs[0].reply.markdown).toBeUndefined();
  expect(task.runs[0].reply.markdownError).toBe("COPY_BUTTON_MISSING");
  const opened = openArchive(join(base, "failed"));
  expect(opened.archive?.coverage(task, "x").state).toBe("markdown-incomplete");
  opened.archive?.close();
});

test("failed recapture preserves prior Markdown but reports this attempt's gap", async () => {
  const { store, browser, conversation } = prepared(root, "T1", pageFor());
  browser.copyResult = { ok: true, text: "## Original" };
  await conversation.capture("review");
  browser.copyResult = { ok: false, reason: "COPY_BUTTON_MISSING" };
  expect(await conversation.capture("review", "r1")).toMatchObject({
    captured: [],
    unchanged: [],
    gaps: [{ runId: "r1", code: "COPY_BUTTON_MISSING" }],
  });
  expect(store.read<any>("task-review").runs[0].reply.markdown).toBe(
    "## Original",
  );
  browser.copyResult = { ok: true, text: "## Original" };
  expect(await conversation.capture("review", "r1")).toMatchObject({
    unchanged: ["r1"],
    gaps: [],
  });
  await expect(conversation.capture("review", "missing-run")).rejects.toThrow(
    "RUN_NOT_FOUND",
  );
});

test("recapture requires a visible target even when Markdown was captured before", async () => {
  const { store, conversation } = prepared(root, "T1", pageFor("Changed"));
  const task = store.read<any>("task-review");
  task.runs[0].reply.markdown = "## Original";
  store.write("task-review", task);
  expect(await conversation.capture("review", "r1")).toMatchObject({
    unchanged: [],
    gaps: [{ runId: "r1", code: "TARGET_NOT_RENDERED" }],
  });
});

test("a rewritten page reply is not attributed to the stored run", async () => {
  const { store, browser, conversation } = prepared(
    join(base, "rewritten"),
    "T3",
    pageFor("网页里这条回复已经被改写"),
  );
  browser.copyResult = { ok: true, text: "## 冒名内容", length: 12 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: [],
    gaps: [{ runId: "r1", code: "TARGET_NOT_RENDERED" }],
  });
  expect(store.read<any>("task-review").runs[0].reply.markdown).toBeUndefined();
  expect(
    store.read<any>("task-review").runs[0].reply.markdownError,
  ).toBeUndefined();
  expect(browser.evals.join("\n")).not.toContain("copy-turn-action-button");
});

test("a turn whose bytes changed under the click is not archived", async () => {
  const replaced = pageFor("网页里这条回复已经被改写");
  const { store, browser, conversation } = prepared(
    join(base, "late-rewrite"),
    "T4",
    pageFor(),
    [pageFor(), replaced],
  );
  browser.copyResult = { ok: true, text: "## 冒名内容", length: 12 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: [],
    unchanged: [],
    gaps: [{ runId: "r1", code: "TARGET_CHANGED" }],
  });
  // The click did happen; only the re-read proved the bytes are no longer this reply's.
  expect(browser.evals.length).toBe(1);
  expect(browser.reads).toBe(3);
  const task = store.read<any>("task-review");
  expect(task.runs[0].reply.markdown).toBeUndefined();
  expect(task.runs[0].reply.markdownError).toBe("TARGET_CHANGED");
  expect(task.runs[0].state).toBe("complete");
});

test("the copy control's own relabel window is waited out, not rejected", async () => {
  const notFinal = {
    ...pageFor(),
    messages: [
      { ...pageFor().messages[0] },
      { ...pageFor().messages[1], final: false },
    ],
  };
  const { store, browser, conversation } = prepared(
    join(base, "relabelled"),
    "T6",
    pageFor(),
    // Clicking the control relabels it, which reads back as a non-final turn while the
    // bytes stay identical. The first read is not final; the second one is.
    [pageFor(), notFinal],
  );
  browser.copyResult = { ok: true, text: "## 裁定\n\n**推荐 A**", length: 18 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: ["r1"],
    gaps: [],
    archive: { status: "stored" },
  });
  expect(browser.evals.length).toBe(1);
  expect(browser.reads).toBe(4);
  const task = store.read<any>("task-review");
  expect(task.runs[0].reply.markdown).toBe("## 裁定\n\n**推荐 A**");
  expect(task.runs[0].reply.markdownError).toBeUndefined();
});

test("a capture already proven by its bytes survives a label that never settles", async () => {
  const notFinal = {
    ...pageFor(),
    messages: [
      { ...pageFor().messages[0] },
      { ...pageFor().messages[1], final: false },
    ],
  };
  const { store, browser, conversation } = prepared(
    join(base, "stuck-label"),
    "T8",
    pageFor(),
    [pageFor(), ...Array.from({ length: 6 }, () => notFinal)],
  );
  browser.copyResult = { ok: true, text: "## 裁定\n\n**推荐 A**", length: 18 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: ["r1"],
    gaps: [],
  });
  // Bounded waiting: four reads, then the attribution it already has is kept.
  expect(browser.reads).toBe(6);
  expect(store.read<any>("task-review").runs[0].reply.markdown).toBe(
    "## 裁定\n\n**推荐 A**",
  );
});

test("a body rewritten during the click is refused by the page program", async () => {
  const { store, browser, conversation } = prepared(
    join(base, "page-refused"),
    "T7",
    pageFor(),
  );
  browser.copyResult = { ok: false, reason: "TARGET_CHANGED" };
  expect(await conversation.capture("review")).toMatchObject({
    captured: [],
    gaps: [{ runId: "r1", code: "TARGET_CHANGED" }],
  });
  expect(store.read<any>("task-review").runs[0].reply.markdown).toBeUndefined();
});

test("a reply whose submitting message is gone cannot be captured", async () => {
  const orphan = pageFor();
  orphan.messages = [orphan.messages[1]];
  const { browser, conversation } = prepared(
    join(base, "orphan"),
    "T5",
    orphan,
  );
  browser.copyResult = { ok: true, text: "## 无主回复", length: 12 };
  expect(await conversation.capture("review")).toMatchObject({
    captured: [],
    gaps: [{ runId: "r1", code: "TARGET_NOT_RENDERED" }],
  });
  expect(browser.evals.join("\n")).not.toContain("copy-turn-action-button");
});

test("the copy script is a page program that parses, and rejects foreign ids", () => {
  const script = copyMarkdownScript("m1");
  expect(script).toContain("copy-turn-action-button");
  expect(script).toContain("COPY_AMBIGUOUS");
  expect(() => new Function("return (" + script + ")")).not.toThrow();
  expect(() => copyMarkdownScript("../m1")).toThrow("INVALID_MESSAGE_ID");
  expect(() => copyMarkdownScript('m"; alert(1)')).toThrow(
    "INVALID_MESSAGE_ID",
  );
});
