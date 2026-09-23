import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State } from "../../src/storage/state.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { FakeBrowser } from "../support/conversation.ts";
import { taskDoc } from "../support/archive.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "observer-cleanup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function setup() {
  const state = new State(root),
    browser = new FakeBrowser();
  const task = taskDoc({ naming: undefined });
  task.runs[0].reply.markdown = "Answer";
  const main = await browser.tabs("new", task.url);
  const observer = await browser.tabs("new", task.url);
  task.binding = { target: main.targetId, epoch: "epoch1", owned: true };
  task.organizationObservation = { target: observer.targetId, epoch: "epoch1" };
  for (const target of [main.targetId, observer.targetId])
    Object.assign(browser.pages.get(target!), {
      messages: [
        { id: "u1", role: "user", text: task.runs[0].prompt, final: false },
        task.runs[0].reply,
      ],
    });
  state.write("task-review", task);
  return {
    state,
    browser,
    task,
    observer: observer.targetId!,
    conversation: new Conversation(state, browser as any),
  };
}

test.each([
  "generating",
  "new-user",
  "missing-anchor",
  "unknown-draft",
  "loading",
  "blocked",
])(
  "observer cleanup preserves %s and records the refusal",
  async (activity) => {
    const { browser, task, observer, conversation } = await setup();
    const page = browser.pages.get(observer);
    if (activity === "generating") page.generating = true;
    if (activity === "new-user")
      page.messages.push({
        id: "u2",
        role: "user",
        text: "New work",
        final: false,
      });
    if (activity === "missing-anchor") page.messages = [];
    if (activity === "unknown-draft") delete page.draft;
    if (activity === "loading") page.hasComposer = false;
    if (activity === "blocked") page.blocked = "Login required";
    await conversation.poll(task.id, task.currentRun);
    expect(browser.targets.map((x) => x.targetId)).toContain(observer);
    expect(conversation.get(task.id).organizationObservation?.closed).not.toBe(
      true,
    );
    expect(
      conversation.get(task.id).organizationObservation?.error,
    ).toBeTruthy();
  },
);

test("observer retry after failed close and successful main close keeps the last tab alive", async () => {
  const { browser, task, observer, conversation, state } = await setup();
  const tabs = browser.tabs.bind(browser);
  let fail = true;
  browser.tabs = async (...args: string[]) => {
    if (args[0] === "close" && args[1] === observer && fail) {
      fail = false;
      throw new Error("INJECTED_CLOSE_FAILURE");
    }
    return tabs(...args);
  };
  expect((await conversation.finish(task.id, task.currentRun)).closed).toBe(
    true,
  );
  expect(browser.targets.map((x) => x.targetId)).toEqual([observer]);
  await conversation.poll(task.id, task.currentRun);
  expect(browser.targets).toHaveLength(1);
  expect(browser.targets[0].url).toBe("about:blank");
  expect(state.read<any>("keepalive").target).toBe(browser.targets[0].targetId);
  expect(conversation.get(task.id).organizationObservation?.closed).toBe(true);
});

test("unverified keepalive preserves the last observer and can be retried", async () => {
  const { browser, task, observer, conversation, state } = await setup();
  await browser.tabs("close", task.binding.target);
  task.binding.closed = true;
  state.write("task-review", task);
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) =>
    args[0] === "new" ? { targetId: "not-created" } : tabs(...args);
  await conversation.poll(task.id);
  expect(browser.targets.map((x) => x.targetId)).toEqual([observer]);
  expect(conversation.get(task.id).organizationObservation?.error).toContain(
    "KEEPALIVE_UNVERIFIED",
  );
  browser.tabs = tabs;
  await conversation.poll(task.id);
  expect(browser.targets).toHaveLength(1);
  expect(browser.targets[0].url).toBe("about:blank");
});

test("observer cleanup rechecks new activity after creating the keepalive", async () => {
  const { browser, task, observer, conversation, state } = await setup();
  await browser.tabs("close", task.binding.target);
  task.binding.closed = true;
  state.write("task-review", task);
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const result = await tabs(...args);
    if (args[0] === "new") browser.pages.get(observer).generating = true;
    return result;
  };
  await conversation.poll(task.id);
  expect(browser.targets.map((x) => x.targetId)).toContain(observer);
  expect(conversation.get(task.id).organizationObservation?.error).toContain(
    "GENERATING",
  );
});

test("concurrent observer retries serialize closes and leave one verified keepalive", async () => {
  const { browser, task, observer, conversation, state } = await setup();
  await browser.tabs("close", task.binding.target);
  task.binding.closed = true;
  state.write("task-review", task);
  const other = structuredClone(task);
  other.id = "other";
  other.url = "https://chatgpt.com/c/other";
  other.currentRun = other.runs[0].id = "other-run";
  const second = await browser.tabs("new", other.url);
  browser.pages.set(second.targetId!, {
    ...structuredClone(browser.pages.get(observer)),
    url: other.url,
  });
  other.organizationObservation.target = second.targetId;
  state.write("task-other", other);
  const tabs = browser.tabs.bind(browser),
    observed: boolean[] = [];
  let active = 0,
    max = 0;
  browser.tabs = async (...args: string[]) => {
    if (args[0] !== "close") return tabs(...args);
    observed.push(state.isLockedActive("tabs"));
    max = Math.max(max, ++active);
    await Bun.sleep(30);
    const result = await tabs(...args);
    active--;
    return result;
  };
  await Promise.all([conversation.poll(task.id), conversation.poll(other.id)]);
  expect(observed).toEqual([true, true]);
  expect(max).toBe(1);
  expect(browser.targets).toHaveLength(1);
  expect(browser.targets[0].url).toBe("about:blank");
  expect(state.read<any>("keepalive").target).toBe(browser.targets[0].targetId);
});

test("observer cleanup rechecks activity after action pacing", async () => {
  const { browser, task, observer, conversation } = await setup();
  browser.gate = async (where) => {
    if (where === "before-close:" + observer)
      browser.pages.get(observer).generating = true;
  };
  await conversation.poll(task.id);
  expect(browser.targets.map((x) => x.targetId)).toContain(observer);
  expect(conversation.get(task.id).organizationObservation?.error).toContain(
    "GENERATING",
  );
});
