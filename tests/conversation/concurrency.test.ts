import { test, expect } from "bun:test";
import { writePreference } from "../../src/config/preferences.ts";
import { tabsLockName } from "../../src/storage/state.ts";
import { conversationHarness } from "../support/conversation.ts";

const { setup, start, makeGate, waitUntil } = conversationHarness();
test("one task holding its own tab does not block another task's send", async () => {
  const { browser, conversation } = setup();
  const g = makeGate();
  browser.gate = g.gate;
  browser.uniqueUrls = true; // two live conversations coexist
  g.block("run:fill:target1");
  try {
    const a = start(conversation, "task-a", "Review A");
    await waitUntil(() => g.reached("run:fill:target1")); // A holds lock-task-a only
    const tb = await start(conversation, "task-b", "Review B"); // must not LOCK_BUSY
    expect(tb.binding!.target).toBe("target2");
    g.release("run:fill:target1");
    const ta = await a;
    expect(ta.binding!.target).toBe("target1");
    expect(ta.url).not.toBe(tb.url);
  } finally {
    g.releaseAll();
  }
});

test("a second operation on the same task waits a bounded window then fails closed without sending", async () => {
  const { browser, conversation } = setup();
  const g = makeGate();
  browser.gate = g.gate;
  writePreference("locks.taskWaitMs", "120");
  g.block("run:fill:target1");
  try {
    const a = start(conversation, "same-task", "Review");
    await waitUntil(() => g.reached("run:fill:target1"));
    const sendsBefore = browser.sends;
    await expect(conversation.poll("same-task")).rejects.toThrow("LOCK_BUSY");
    expect(browser.sends).toBe(sendsBefore); // contention never crosses the send boundary
    g.release("run:fill:target1");
    expect((await a).id).toBe("same-task");
  } finally {
    writePreference("locks.taskWaitMs", "");
    g.releaseAll();
  }
});

test("browser.serial restores a single global browser lock across different tasks", async () => {
  const { browser, conversation } = setup();
  const g = makeGate();
  browser.gate = g.gate;
  writePreference("browser.serial", "true");
  writePreference("locks.taskWaitMs", "120");
  g.block("run:fill:target1");
  try {
    const a = start(conversation, "serial-a", "Review A");
    await waitUntil(() => g.reached("run:fill:target1"));
    await expect(start(conversation, "serial-b", "Review B")).rejects.toThrow(
      "LOCK_BUSY",
    ); // different task, still serialized by the global lock
    g.release("run:fill:target1");
    expect((await a).id).toBe("serial-a");
  } finally {
    writePreference("browser.serial", "");
    writePreference("locks.taskWaitMs", "");
    g.releaseAll();
  }
});

test("a slow metadata cleanup read does not hold the cross-task close lock", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "slow-observer", "Review");
  const observer = await browser.tabs("new", t.url!);
  browser.pages.set(
    observer.targetId!,
    structuredClone(browser.pages.get(t.binding!.target)),
  );
  t.organizationObservation = { epoch: "epoch1", target: observer.targetId };
  state.write("task-" + t.id, t);
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((r) => (entered = r)),
    barrier = new Promise<void>((r) => (release = r));
  browser.gate = async (where) => {
    if (where === "read:" + observer.targetId) {
      entered();
      await barrier;
    }
  };
  const pending = conversation.resume(t.id);
  try {
    await reading;
    await state.locked(async () => {}, tabsLockName(), 0);
  } finally {
    release();
    await pending;
  }
});
