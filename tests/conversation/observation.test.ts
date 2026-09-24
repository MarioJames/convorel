import { test, expect } from "bun:test";
import { State } from "../../src/storage/state.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { ObservationError } from "../../src/browser/browser.ts";
import { waitForConversation } from "../../src/conversation/wait.ts";
import {
  conversationStatus,
  conversationExitCode,
} from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";

const { setup, start, home } = conversationHarness();
test("generation failure stops wait with confirmed delivery and resumes only by observing the original turn", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "generation-failed", "Review");
  const p = [...browser.pages.values()][0];
  p.generating = false;
  p.messages.push({
    id: "a-failed",
    role: "assistant",
    text: "Partial response",
    final: true,
    error:
      "Response generation failed; inspect the original reply's Retry control",
  });
  const failed = await conversation.resume(t.id, t.currentRun);
  expect(conversationStatus(failed)).toMatchObject({
    state: "blocked",
    delivery: "confirmed",
    phase: "needs_attention",
    nextAction: "inspect",
    error: p.messages.at(-1).error,
  });
  const reports: any[] = [];
  expect(
    await waitForConversation(
      state,
      conversation,
      t.id,
      t.currentRun,
      1,
      new AbortController().signal,
      (r) => reports.push(r),
    ),
  ).toBe(2);
  expect(reports).toHaveLength(1);
  expect(reports[0].phase).toBe("needs_attention");
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  expect(browser.sends).toBe(1);
  p.generating = true;
  expect(
    conversationStatus(await conversation.resume(t.id, t.currentRun)),
  ).toMatchObject({ state: "waiting", phase: "awaiting_reply", error: null });
  browser.complete();
  expect(
    conversationStatus(await conversation.resume(t.id, t.currentRun)).phase,
  ).toBe("capture_pending");
  expect(browser.sends).toBe(1);
});

test("observation failures preserve delivery evidence and expose safe recovery actions", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "read-interrupted", "Review");
  expect(conversationExitCode(t, "start")).toBe(0);
  expect(conversationExitCode(t, "resume")).toBe(2);
  const page = browser.page.bind(browser);
  browser.page = async (target) => ({
    ...(await page(target)),
    read: async () => {
      throw new ObservationError("connection reset");
    },
  });
  await expect(conversation.resume(t.id, t.currentRun)).rejects.toThrow(
    "connection reset",
  );
  const saved = conversation.get(t.id);
  expect(conversationStatus(saved)).toMatchObject({
    state: "waiting",
    delivery: "confirmed",
    phase: "observation_interrupted",
    nextAction: "resume",
  });
  expect(saved.runs[0].lastObservedAt).toBeTruthy();
  expect(saved.runs[0].observationError?.retryable).toBe(true);
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  browser.page = page;
  const p = [...browser.pages.values()][0];
  p.blocked = "Login required";
  await expect(conversation.resume(t.id, t.currentRun)).rejects.toThrow(
    "Login required",
  );
  expect(conversationStatus(conversation.get(t.id))).toMatchObject({
    delivery: "confirmed",
    nextAction: "inspect",
  });
  p.blocked = null;
  browser.complete();
  const recovered = await new Conversation(state, browser as any).resume(
    t.id,
    t.currentRun,
  );
  expect(conversationStatus(recovered)).toMatchObject({
    phase: "capture_pending",
    nextAction: "capture",
    observationError: null,
  });
  expect(conversationExitCode(recovered, "resume")).toBe(2);
  expect(browser.sends).toBe(1);
});

test("resuming a pre-send observation failure saves recovery without sending", async () => {
  const { browser, conversation } = setup();
  const page = browser.page.bind(browser);
  browser.page = async (target) => ({
    ...(await page(target)),
    read: async () => {
      throw new ObservationError("connection reset");
    },
  });
  const t = await start(conversation, "before-send-read", "Review");
  expect(conversationStatus(t)).toMatchObject({
    state: "prepared",
    delivery: "not_attempted",
    nextAction: "resume",
  });
  browser.page = page;
  await conversation.resume(t.id, t.currentRun);
  expect(conversationStatus(conversation.get(t.id))).toMatchObject({
    state: "prepared",
    delivery: "not_attempted",
    nextAction: "start",
    observationError: null,
    error: null,
  });
  expect(conversation.get(t.id).runs[0].lastObservedAt).toBeTruthy();
  expect(browser.sends).toBe(0);
  await conversation.retry(t.id, t.currentRun);
  expect(browser.sends).toBe(1);
});

test("first durable task write already contains a recoverable run", async () => {
  const { state, browser, conversation } = setup();
  const write = state.write.bind(state);
  state.write = (key, value) => {
    write(key, value);
    if (key === "task-first-write")
      throw new Error("simulated interruption after durable write");
  };
  await expect(start(conversation, "first-write", "Question")).rejects.toThrow(
    "simulated interruption",
  );
  const restored = new Conversation(
    new State(home()),
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
  );
  const saved = restored.get("first-write");
  expect(saved.runs).toHaveLength(1);
  expect(saved.currentRun).toBe(saved.runs[0].id);
  expect(saved.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  const continued = await restored.retry("first-write", saved.currentRun);
  expect(continued.currentRun).toBe(saved.currentRun);
  expect(browser.sends).toBe(1);
});

for (const remote of [
  "complete",
  "complete-without-composer",
  "waiting",
  "superseded",
]) {
  test(`stalled stream refreshes and reconciles without resending: ${remote}`, async () => {
    const { state, browser, conversation } = setup();
    const first = await start(conversation, "stalled", "Review");
    const original = browser.pages.get(first.binding!.target);
    const saved = structuredClone(original);
    if (remote.startsWith("complete")) {
      saved.hasComposer = remote !== "complete-without-composer";
      saved.generating = false;
      saved.messages.push({
        id: "a1",
        role: "assistant",
        text: "Persisted answer",
        final: true,
      });
    } else if (remote === "superseded") {
      saved.generating = false;
      saved.messages.push({
        id: "other",
        role: "user",
        text: "Another question",
        final: true,
      });
    }
    let reloads = 0;
    browser.gate = async (where) => {
      if (where === "run:reload:" + first.binding!.target) {
        reloads++;
        Object.assign(original, structuredClone(saved));
      }
    };
    await conversation.poll(first.id);
    expect(reloads).toBe(0);
    const t = conversation.get(first.id);
    expect(t.runs[0].completionProbe).toBeDefined();
    t.runs[0].completionProbe!.unchangedSince = new Date(0).toISOString();
    state.write("task-" + first.id, t);
    const result = await conversation.resume(first.id);
    expect(reloads).toBe(1);
    expect(result.runs[0].state).toBe(
      remote.startsWith("complete")
        ? "complete"
        : remote === "superseded"
          ? "superseded"
          : "waiting",
    );
    if (remote.startsWith("complete"))
      expect(result.runs[0].reply?.text).toBe("Persisted answer");

    expect(browser.targets).toHaveLength(1);
    expect(browser.sends).toBe(1);
  });
}

test("stalled refresh preserves drafts, bounds navigation and never resends", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "stalled-limit", "Review");
  const p = browser.pages.get(first.binding!.target);
  let reloads = 0;
  browser.gate = async (where) => {
    if (where.startsWith("run:reload:")) reloads++;
  };
  const due = () => {
    const t = conversation.get(first.id);
    t.runs[0].completionProbe!.unchangedSince = new Date(0).toISOString();
    t.runs[0].completionProbe!.lastRefreshedAt = new Date(0).toISOString();
    state.write("task-" + first.id, t);
  };
  due();
  p.draft = "User draft";
  await conversation.poll(first.id);
  expect(reloads).toBe(0);
  expect(p.draft).toBe("User draft");
  p.draft = "";
  // A healthy long-running Pro response may survive more than three refreshes.
  for (let n = 0; n < 4; n++) {
    due();
    await conversation.poll(first.id);
  }
  expect(reloads).toBe(4);
  browser.gate = async (where) => {
    if (where.startsWith("run:reload:")) {
      reloads++;
      throw new ObservationError("Transport unavailable");
    }
  };
  for (let n = 0; n < 3; n++) {
    due();
    await conversation.poll(first.id);
  }
  const cooling = conversation.get(first.id);
  cooling.runs[0].completionProbe!.lastRefreshedAt = new Date().toISOString();
  state.write("task-" + first.id, cooling);
  await conversation.poll(first.id);
  expect(reloads).toBe(7);
  due();
  browser.gate = async (where) => {
    if (where.startsWith("run:reload:")) reloads++;
  };
  const recovered = await conversation.poll(first.id);
  expect(reloads).toBe(8);
  expect(recovered.runs[0].completionProbe?.failures).toBe(0);
  expect(browser.sends).toBe(1);
});

test("missing owned creation can be replaced only before the first send", async () => {
  const { state, browser } = setup();
  let ready = false;
  const conversation = new Conversation(state, browser as any, async () => {
    if (!ready) throw new Error("Model control unavailable");
    return { observedModel: "6 Pro" };
  });
  const first = await start(conversation, "recreate", "Review");
  expect(first.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  browser.targets = [];
  ready = true;
  const recovered = await conversation.retry(first.id, first.currentRun);
  expect(recovered.runs[0].state).toBe("waiting");
  expect(recovered.pageRecreations).toBe(1);
  expect(recovered.currentRun).toBe(first.currentRun);
  expect(browser.sends).toBe(1);
});

test("bound page waits for delayed history without resending", async () => {
  const { browser, conversation } = setup();
  const t = await start(conversation, "hydration", "Review");
  const p = browser.pages.get(t.binding!.target);
  const messages = structuredClone(p.messages);
  p.messages = [];
  p.generating = false;
  let reads = 0;
  browser.gate = async (where) => {
    if (where === "read:" + t.binding!.target && ++reads === 2)
      p.messages = messages;
  };
  const result = await conversation.resume(t.id);
  expect(result.runs[0].state).toBe("waiting");
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(browser.sends).toBe(1);
});

test("a navigated submitted tab is preserved while a new page observes its saved URL", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "navigated-observer", "Review");
  const target = first.binding!.target;
  const saved = structuredClone(browser.pages.get(target));
  const moved = browser.pages.get(target);
  moved.url = "https://chatgpt.com/";
  moved.draft = "User work";
  browser.targets.find((tab) => tab.targetId === target).url = moved.url;
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args) => {
    const result = await tabs(...args);
    if (args[0] === "new" && args[1] === first.url)
      Object.assign(
        browser.pages.get(result.targetId!),
        structuredClone(saved),
      );
    return result;
  };
  const resumed = await conversation.resume(first.id, first.currentRun);
  expect(resumed.runs[0].state).toBe("waiting");
  expect(resumed.binding).toMatchObject({ owned: true });
  expect(resumed.binding?.target).not.toBe(target);
  expect(resumed.detachedBindings).toMatchObject([
    { target, reason: "navigated" },
  ]);
  expect(moved.draft).toBe("User work");
  expect(browser.sends).toBe(1);
});

test("interrupted opening of a saved conversation can recreate an observation page", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "opening-observer", "Review");
  const saved = structuredClone(browser.pages.get(first.binding!.target));
  const checkpoint = conversation.get(first.id);
  checkpoint.binding = undefined;
  checkpoint.opening = true;
  state.write("task-" + first.id, checkpoint);
  browser.targets = [];
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args) => {
    const result = await tabs(...args);
    if (args[0] === "new" && args[1] === first.url)
      Object.assign(
        browser.pages.get(result.targetId!),
        structuredClone(saved),
      );
    return result;
  };
  const resumed = await conversation.resume(first.id, first.currentRun);
  expect(resumed.runs[0].state).toBe("waiting");
  expect(resumed.opening).toBe(false);
  expect(resumed.pageRecreations).toBe(1);
  expect(browser.sends).toBe(1);
});

test("partial history waits for the saved user ID after older messages appear", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "partial-history", "Review");
  const page = browser.pages.get(first.binding!.target);
  const submitted = structuredClone(page.messages[0]);
  page.messages = [
    { id: "old-user", role: "user", text: "Earlier", final: true },
  ];
  let reads = 0;
  browser.gate = async (where) => {
    if (where === "read:" + first.binding!.target && ++reads === 2)
      page.messages.push(submitted);
  };
  const resumed = await conversation.resume(first.id, first.currentRun);
  expect(resumed.runs[0].state).toBe("waiting");
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(browser.sends).toBe(1);
});

test("unknown submission cannot recreate a missing new conversation", async () => {
  const { browser, conversation } = setup();
  browser.delayedUrl = true;
  browser.failSend = true;
  const first = await start(conversation, "no-recreate", "Review");
  expect(first.runs[0].state).toBe("delivery_unknown");
  browser.targets = [];
  await expect(conversation.resume(first.id)).rejects.toThrow("OPEN_UNKNOWN");
  expect(browser.targets).toHaveLength(0);
  expect(browser.sends).toBe(1);
});
