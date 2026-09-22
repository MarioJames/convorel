import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive/store.ts";
import {
  openArchive,
  publishTask,
  scanTasks,
  taskFileHash,
} from "../../src/archive/post-archive.ts";
import {
  conversationStatus,
  conversationExitCode,
} from "../../src/conversation/status.ts";
import { writePreference } from "../../src/config/preferences.ts";
import { State } from "../../src/storage/state.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { copyMarkdownScript } from "../../src/browser/chatgpt/copy.ts";
import { waitForConversation } from "../../src/conversation/wait.ts";
import { CHATGPT_URL, RENDERED, taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

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
      return { tabs: [{ targetId: this.target, url: CHATGPT_URL }] };
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
  url: CHATGPT_URL,
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
