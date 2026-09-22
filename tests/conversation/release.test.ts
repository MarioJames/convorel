import { test, expect } from "bun:test";
import { waitForConversation } from "../../src/conversation/wait.ts";
import { conversationStatus } from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";

const { setup, start } = conversationHarness();
test("draft and newer messages protect a completed page from closure", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "draft", "Conversation");
  browser.complete();
  await conversation.poll("draft", first.currentRun);
  const p = [...browser.pages.values()][0];
  p.draft = "unfinished user text";
  await expect(
    conversation.finish("draft", first.currentRun),
  ).rejects.toThrow();
  expect(browser.targets).toHaveLength(1);
  p.draft = "";
  p.messages.push({
    id: "u-new",
    role: "user",
    text: "followup",
    final: false,
  });
  await expect(
    conversation.finish("draft", first.currentRun),
  ).rejects.toThrow();
  expect(browser.targets).toHaveLength(1);
});

test("borrowed conversation cannot be claimed twice or closed, and completed results remain durable", async () => {
  const { browser, conversation } = setup();
  await browser.tabs("new", "https://chatgpt.com/c/existing");
  const p = [...browser.pages.values()][0];
  p.messages = [
    { id: "u", role: "user", text: "Conversation", final: false },
    { id: "a", role: "assistant", text: "Evidence", final: true },
  ];
  const t = await conversation.attach("imported", p.url, "u");
  await expect(conversation.attach("duplicate", p.url, "u")).rejects.toThrow(
    "CONVERSATION_CONFLICT",
  );
  expect((await conversation.finish("imported", t.currentRun)).closed).toBe(
    false,
  );
  expect(browser.targets).toHaveLength(1);
  p.messages = [];
  await conversation.poll("imported", t.currentRun);
  expect(conversation.result("imported", t.currentRun).reply.text).toBe(
    "Evidence",
  );
});
test("request changes, browser restart, navigation and attachments cannot overwrite or close resources", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "protected", "Conversation");
  await expect(start(conversation, "protected", "Different")).rejects.toThrow(
    "REQUEST_CONFLICT",
  );
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("protected", t.currentRun);
  const p = [...browser.pages.values()][0];
  p.attachments = true;
  await expect(conversation.finish("protected", t.currentRun)).rejects.toThrow(
    "PAGE_NOT_IDLE",
  );
  p.attachments = false;
  browser.epochValue = "new-browser";
  await expect(conversation.finish("protected", t.currentRun)).rejects.toThrow(
    "BROWSER_RESTARTED",
  );
  browser.epochValue = "epoch1";
  p.url = "https://chatgpt.com/c/another";
  await expect(conversation.finish("protected", t.currentRun)).rejects.toThrow(
    "CONVERSATION_CHANGED",
  );
  expect(browser.targets).toHaveLength(1);
});

test("an operation releases its browser sessions whether it returned or failed", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "released", "Review");
  expect(browser.releases).toBe(1);
  browser.pages.delete(t.binding!.target);
  browser.releases = 0;
  await expect(conversation.resume(t.id, t.currentRun)).rejects.toThrow(
    "tab_gone",
  );
  expect(browser.releases).toBe(1);
});
test("a watcher releases its browser sessions on every observation, not only at the end", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "watched", "Review");
  browser.complete();
  browser.releases = 0;
  expect(
    await waitForConversation(
      state,
      conversation,
      t.id,
      t.currentRun,
      5,
      new AbortController().signal,
      () => {},
    ),
  ).toBe(0);
  expect(browser.releases).toBe(1);
});

test("finish persists a redacted missing-composer diagnosis without closing the page", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "missing-composer", "Review");
  browser.complete();
  await conversation.poll(t.id);
  const p = browser.pages.get(t.binding!.target);
  p.hasComposer = false;
  p.draft = "private draft text";
  await expect(conversation.finish(t.id, t.currentRun)).rejects.toThrow(
    "COMPOSER_MISSING",
  );
  const cleanup = conversation.get(t.id).cleanup;
  expect(cleanup).toMatchObject({
    closed: false,
    target: t.binding!.target,
    page: {
      hasComposer: false,
      draftLength: 18,
      generating: false,
      blocked: false,
    },
  });
  expect(cleanup.reasons).toContain("DRAFT_PRESENT");
  expect(JSON.stringify(cleanup)).not.toContain("private draft text");
  expect(Date.parse(cleanup.observedAt)).toBeGreaterThan(0);
  expect(browser.targets).toHaveLength(1);
  expect(conversationStatus(conversation.get(t.id)).cleanup).toEqual(cleanup);
  p.hasComposer = true;
  delete p.draft;
  await expect(conversation.finish(t.id, t.currentRun)).rejects.toThrow(
    "DRAFT_UNKNOWN",
  );
  expect(browser.targets).toHaveLength(1);
  p.draft = "";
  expect((await conversation.finish(t.id, t.currentRun)).closed).toBe(true);
});

test("finish waits for transient composer hydration without reloading or resending", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "finish-loading", "Review");
  browser.complete();
  await conversation.poll(t.id);
  const p = browser.pages.get(t.binding!.target);
  p.hasComposer = false;
  let reads = 0;
  browser.gate = async (where) => {
    if (where === "read:" + t.binding!.target && ++reads === 3)
      p.hasComposer = true;
    if (where.startsWith("run:reload:")) throw new Error("Must not reload");
  };
  expect((await conversation.finish(t.id, t.currentRun)).closed).toBe(true);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(browser.sends).toBe(1);
});

test("finish can release an idle owned page after same-turn reply drift without replacing the captured result", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "finish-drift", "Review");
  browser.complete();
  await conversation.poll(t.id);
  const saved = conversation.result(t.id, t.currentRun).reply;
  browser.pages.get(t.binding!.target).messages.push({
    id: "a-late",
    role: "assistant",
    text: "Later answer",
    final: true,
  });
  expect(await conversation.finish(t.id, t.currentRun)).toMatchObject({
    closed: true,
    replyChanged: true,
  });
  expect(conversation.result(t.id, t.currentRun).reply).toEqual(saved);
  expect(browser.sends).toBe(1);
});

test("finish reports pending naming even when an interrupted edit has no error text", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "pending-edit-finish", "Review");
  browser.complete();
  await conversation.poll(t.id);
  const stored = conversation.get(t.id);
  stored.naming = { type: "FIX", topic: "命名" };
  stored.organization = { verified: false, phase: "editing" };
  state.write("task-" + t.id, stored);
  expect(await conversation.finish(t.id, t.currentRun)).toMatchObject({
    closed: true,
    organizationPending: true,
  });
});
