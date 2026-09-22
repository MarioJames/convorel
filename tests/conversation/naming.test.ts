import { test, expect } from "bun:test";
import { Conversation } from "../../src/conversation/conversation.ts";
import { ObservationError } from "../../src/browser/browser.ts";
import { waitForConversation } from "../../src/conversation/wait.ts";
import { conversationStatus } from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";

const { setup, start } = conversationHarness();
test("initial naming waits for the first wait return even while the reply is still generating", async () => {
  const { state, browser } = setup();
  const calls: any[] = [];
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async (b, url, preferences, type, topic) => {
      const page = await b.read();
      calls.push({
        url,
        type,
        topic,
        generating: page.generating,
        messages: page.messages,
      });
      return { verified: true, title: "0918｜OPT｜创建路径" } as any;
    },
  );
  const first = await start(
    conversation,
    "named",
    "Review",
    "initial",
    false,
    undefined,
    { type: "OPT", topic: "创建路径" },
  );
  expect(first.organization).toBeUndefined();
  expect(calls).toHaveLength(0);
  await conversation.poll(first.id);
  expect(calls).toHaveLength(0);
  await waitForConversation(
    state,
    conversation,
    first.id,
    first.currentRun,
    0.02,
    new AbortController().signal,
    () => {},
  );
  expect(conversation.get(first.id).organization.verified).toBe(true);
  expect(first.runs[0].state).toBe("waiting");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    type: "OPT",
    topic: "创建路径",
    generating: true,
    messages: [{ id: "u1", role: "user" }],
  });
  await start(conversation, "named", "Review", "initial", false, undefined, {
    type: "OPT",
    topic: "创建路径",
  });
  browser.complete();
  await conversation.resume(first.id, first.currentRun);
  await start(conversation, "named", "Next", "next", true);
  expect(calls).toHaveLength(1);
  expect(browser.sends).toBe(2);
});

test("naming waits for the persisted URL and failures never undo delivery or resend", async () => {
  const { state, browser } = setup();
  let calls = 0;
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => {
      calls++;
      throw new Error("Title save rejected (HTTP 403)");
    },
  );
  browser.delayedUrl = true;
  const first = await start(
    conversation,
    "delayed-name",
    "Review",
    "initial",
    false,
    undefined,
    { type: "OPT", topic: "创建路径" },
  );
  expect(calls).toBe(0);
  const p = [...browser.pages.values()][0];
  p.url = "https://chatgpt.com/c/test-conversation";
  browser.targets[0].url = p.url;
  await conversation.resume(first.id, first.currentRun);
  expect(calls).toBe(0);
  const named = await conversation.ensureNaming(first.id, first.currentRun);
  expect(calls).toBe(1);
  expect(named.organization).toMatchObject({
    verified: false,
    error: "Error: Title save rejected (HTTP 403)",
  });
  expect(named.runs[0]).toMatchObject({
    state: "waiting",
    userMessageId: "u1",
  });
  await conversation.resume(first.id, first.currentRun);
  expect(calls).toBe(1);
  expect(browser.sends).toBe(1);
  await expect(conversation.retry(first.id, first.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  browser.complete();
  await conversation.resume(first.id, first.currentRun);
  expect(conversation.result(first.id, first.currentRun).reply.text).toBe(
    "Answer",
  );
});

test("transient naming failures recover at later checkpoints across restart without resending", async () => {
  const { state, browser } = setup();
  let calls = 0;
  const create = () =>
    new Conversation(
      state,
      browser as any,
      async () => ({ observedModel: "6 Pro" }),
      async () => {
        if (++calls < 3) throw new Error("Conversation UI reported an error");
        return { verified: true } as any;
      },
    );
  let conversation = create();
  const t = await start(
    conversation,
    "retry-name",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "恢复命名" },
  );
  expect(calls).toBe(0);
  await conversation.ensureNaming(t.id, t.currentRun);
  expect(conversationStatus(conversation.get(t.id)).organization).toMatchObject(
    { state: "retry_pending", attempts: 1, nextAction: "wait" },
  );
  await conversation.poll(t.id);
  expect(calls).toBe(1);
  conversation = create();
  await conversation.ensureNaming(t.id, t.currentRun);
  expect(calls).toBe(2);
  browser.complete();
  await conversation.resume(t.id);
  expect(calls).toBe(2);
  expect(
    (await conversation.ensureNaming(t.id, t.currentRun)).organization.verified,
  ).toBe(true);
  expect(calls).toBe(3);
  expect(browser.sends).toBe(1);
});

test("invalid initial naming stops before creating a browser page", async () => {
  const { browser, conversation } = setup();
  await expect(
    start(conversation, "bad-name", "Review", "initial", false, undefined, {
      type: "BAD",
      topic: "Topic",
    }),
  ).rejects.toThrow("title type");
  expect(browser.targets).toHaveLength(0);
});

test.each([false, true])(
  "metadata observation failure releases only its owned page and preserves a changed observer (%s)",
  async (changed) => {
    const { state, browser } = setup();
    let sourceTarget = "";
    const conversation = new Conversation(
      state,
      browser as any,
      async () => ({ observedModel: "6 Pro" }),
      async (b, url, prefs, type, topic, onProgress, metadata) => {
        expect((await b.read()).generating).toBe(true);
        expect(metadata).toBeDefined();
        await metadata!.read();
        sourceTarget = browser.targets.at(-1).targetId;
        if (changed)
          browser.pages.get(sourceTarget).draft = "User took over this page";
        throw new Error("Metadata unavailable");
      },
    );
    const t = await start(
      conversation,
      "observer-failure",
      "Review",
      "initial",
      false,
      undefined,
      { type: "OPT", topic: "创建路径" },
    );
    Object.assign(t, await conversation.ensureNaming(t.id, t.currentRun));
    expect(t.runs[0]).toMatchObject({ state: "waiting", userMessageId: "u1" });
    expect(t.organization.error).toContain("Metadata unavailable");
    expect(browser.targets.some((x) => x.targetId === t.binding!.target)).toBe(
      true,
    );
    expect(browser.targets.some((x) => x.targetId === sourceTarget)).toBe(
      changed,
    );
    if (changed)
      expect(t.organizationObservation?.error).toContain(
        "METADATA_PAGE_CHANGED",
      );
    else expect(t.organizationObservation?.closed).toBe(true);
    expect(browser.sends).toBe(1);
  },
);

test("failed organization revalidation retains the last verified naming, including after a new request", async () => {
  const { state, browser } = setup();
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => ({ verified: true, title: "0922｜OPT｜原主题" }) as any,
  );
  const t = await start(
    conversation,
    "revalidation",
    "Review",
    "initial",
    false,
    undefined,
    { type: "OPT", topic: "原主题" },
  );
  await conversation.ensureNaming(t.id, t.currentRun);
  browser.complete();
  await conversation.poll(t.id);
  browser.pages.get(t.binding!.target).draft = "User draft";
  const result = await conversation.organize(
    t.id,
    t.currentRun,
    "OPT",
    "原主题",
  );
  expect(result.verified).toBe(false);
  expect(result.lastVerified).toMatchObject({
    title: "0922｜OPT｜原主题",
    naming: { type: "OPT", topic: "原主题" },
  });
  expect(result.error).toContain("DRAFT_PRESENT");
  expect(conversationStatus(conversation.get(t.id)).organization).toMatchObject(
    { state: "revalidation_failed", lastVerified: result.lastVerified },
  );
  const changed = await conversation.organize(
    t.id,
    t.currentRun,
    "OPT",
    "新主题",
  );
  expect(changed.verified).toBe(false);
  expect(changed.lastVerified).toEqual(result.lastVerified);
  expect(conversationStatus(conversation.get(t.id)).organization!.state).toBe(
    "needs_attention",
  );
});

test("naming is independent of completed reply drift and composer hydration, and never reloads the reply page", async () => {
  const { state, browser, conversation: original } = setup();
  const t = await start(original, "name-drift", "Review");
  browser.complete();
  await original.poll(t.id);
  const saved = original.result(t.id, t.currentRun).reply;
  const p = browser.pages.get(t.binding!.target);
  p.hasComposer = false;
  p.messages.push({
    id: "a-late",
    role: "assistant",
    text: "Later answer",
    final: true,
  });
  let calls = 0;
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({}) as any,
    async (page, _url, _preferences, _type, _topic, _progress, metadata) => {
      calls++;
      await page.read();
      expect(metadata).toBeDefined();
      return { verified: true, title: "0922｜FIX｜可靠命名" } as any;
    },
  );
  const result = await conversation.organize(
    t.id,
    t.currentRun,
    "FIX",
    "可靠命名",
  );
  expect(result.verified).toBe(true);
  expect(calls).toBe(1);
  expect(conversation.result(t.id, t.currentRun).reply).toEqual(saved);
  expect(browser.sends).toBe(1);
});

test("each wait return and finish provide a naming checkpoint without exhausting later attempts", async () => {
  const { state, browser } = setup();
  let attempts = 0;
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => {
      attempts++;
      return { verified: true, title: "0922｜FIX｜检查点" } as any;
    },
  );
  const t = await start(
    conversation,
    "name-checkpoints",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "检查点" },
  );
  expect(attempts).toBe(0); // Sending does not name.
  const fail = () => {
    const task = conversation.get(t.id);
    task.organization = {
      verified: false,
      attempts: 3,
      phase: "metadata",
      error: "Error: METADATA_PAGE_UNAVAILABLE",
    };
    state.write("task-" + t.id, task);
  };
  expect(
    await waitForConversation(
      state,
      conversation,
      t.id,
      t.currentRun,
      0.02,
      new AbortController().signal,
      () => {},
    ),
  ).toBe(2);
  expect(conversation.get(t.id).organization.verified).toBe(true);
  expect(attempts).toBe(1); // Timed-out wait, while still generating.
  fail();
  browser.complete();
  expect(
    await waitForConversation(
      state,
      conversation,
      t.id,
      t.currentRun,
      1,
      new AbortController().signal,
      () => {},
    ),
  ).toBe(0);
  expect(attempts).toBe(2); // Completed wait also repairs naming.
  fail();
  expect((await conversation.finish(t.id, t.currentRun)).closed).toBe(true);
  expect(conversation.get(t.id).organization.verified).toBe(true);
  expect(attempts).toBe(3);
  expect(browser.sends).toBe(1);
});

test("the first wait return names a delivered conversation even when the reply is blocked", async () => {
  const { state, browser } = setup();
  let named = 0;
  const originalPage = browser.page.bind(browser);
  browser.page = async (target) => {
    const page = await originalPage(target);
    const run = page.run;
    page.run = async (...args: string[]) => {
      const result = await run(...args);
      if (args[0] === "click") {
        const p = browser.pages.get(target);
        p.generating = false;
        p.messages.push({
          id: "a-failed",
          role: "assistant",
          text: "",
          final: false,
          error: "Response generation failed",
        });
      }
      return result;
    };
    return page;
  };
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => {
      named++;
      return { verified: true } as any;
    },
  );
  const t = await start(
    conversation,
    "name-before-reply",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "首次命名" },
  );
  expect(t.runs[0].state).toBe("blocked");
  expect(named).toBe(0);
  await waitForConversation(
    state,
    conversation,
    t.id,
    t.currentRun,
    1,
    new AbortController().signal,
    () => {},
  );
  expect(named).toBe(1);
  expect(conversation.get(t.id).organization.verified).toBe(true);
  expect(browser.sends).toBe(1);
});

test("wait/finish naming checkpoints do not replay interrupted edits, rejected writes, or legacy unknown saves", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "unsafe-checkpoint", "Review");
  for (const organization of [
    { phase: "editing", error: "Connection lost" },
    { phase: "metadata", error: "HTTP 403" },
    { phase: "verifying", error: "ORGANIZATION_SAVE_UNCONFIRMED" },
    { error: "Title save was not acknowledged" },
  ]) {
    const task = conversation.get(t.id);
    task.naming = { type: "FIX", topic: "保留写入边界" };
    task.organization = { verified: false, ...organization };
    state.write("task-" + t.id, task);
    browser.gate = async () => {
      throw new Error("Must not touch browser");
    };
    const result = await conversation.ensureNaming(t.id, t.currentRun);
    expect(result.organization).toEqual(task.organization);
  }
  expect(browser.sends).toBe(1);
});

test.each([
  "Conversation UI reported an error",
  "Login required",
  "Human verification required",
])(
  "metadata-only observation handles %s independently of the streaming reply",
  async (blocked) => {
    const { state, browser } = setup();
    const conversation = new Conversation(
      state,
      browser as any,
      async () => ({ observedModel: "6 Pro" }),
      async (_page, _url, _prefs, _type, _topic, _progress, metadata) => {
        await metadata!.read();
        browser.pages.get(browser.targets.at(-1).targetId).blocked = blocked;
        await metadata!.run("network", "requests");
        return { verified: true } as any;
      },
    );
    const t = await start(
      conversation,
      "metadata-alert",
      "Review",
      "initial",
      false,
      undefined,
      { type: "FIX", topic: "元数据读取" },
    );
    Object.assign(t, await conversation.ensureNaming(t.id, t.currentRun));
    expect(t.organization.verified).toBe(
      blocked === "Conversation UI reported an error",
    );
    if (blocked !== "Conversation UI reported an error")
      expect(t.organization.error).toContain(blocked);
    expect(browser.sends).toBe(1);
    expect(browser.targets).toHaveLength(1);
  },
);

test("a wait checkpoint repairs a remotely reverted title even when local naming was verified", async () => {
  const { state, browser } = setup();
  let calls = 0;
  const title = "0922｜FIX｜可辨认会话";
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => {
      calls++;
      browser.pages.get(browser.targets[0].targetId).title =
        "Project - " + title;
      return { verified: true, title, phase: "complete" } as any;
    },
  );
  const t = await start(
    conversation,
    "reverted-title",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "可辨认会话" },
  );
  await conversation.ensureNaming(t.id, t.currentRun);
  browser.pages.get(t.binding!.target).title = "Project - Automatic title";
  expect(
    await waitForConversation(
      state,
      conversation,
      t.id,
      t.currentRun,
      0.02,
      new AbortController().signal,
      () => {},
    ),
  ).toBe(2);
  expect(calls).toBe(2);
  expect(browser.pages.get(t.binding!.target).title).toBe("Project - " + title);
  await conversation.ensureNaming(t.id, t.currentRun);
  expect(calls).toBe(2); // Current title already matches; no metadata page or write.
  browser.gate = async () => {
    throw new ObservationError("BROWSER_READ_FAILED: temporary disconnect");
  };
  await conversation.ensureNaming(t.id, t.currentRun);
  expect(conversation.get(t.id).organization.verified).toBe(false);
  browser.gate = undefined;
  await conversation.ensureNaming(t.id, t.currentRun);
  expect(conversation.get(t.id).organization.verified).toBe(true);
  expect(browser.sends).toBe(1);
});

test("a surviving owned metadata page can replace a lost main tab without becoming borrowed or being closed", async () => {
  const { state, browser, conversation } = setup();
  const t = await start(conversation, "observer-transfer", "Review");
  const saved = structuredClone(browser.pages.get(t.binding!.target));
  const observer = await browser.tabs("new", t.url!);
  browser.pages.set(observer.targetId!, saved);
  await browser.tabs("close", t.binding!.target);
  t.organizationObservation = { epoch: "epoch1", target: observer.targetId };
  state.write("task-" + t.id, t);
  const result = await conversation.resume(t.id, t.currentRun);
  expect(result.binding).toMatchObject({
    target: observer.targetId,
    owned: true,
  });
  expect(result.organizationObservation).toMatchObject({
    closed: true,
    transferredToMain: true,
  });
  expect(browser.targets).toHaveLength(1);
  expect(browser.sends).toBe(1);
});

test("observer close acknowledgement loss reconciles missing target on resume", async () => {
  const { state, browser } = setup();
  let calls = 0,
    lostAck = false;
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const result = await tabs(...args);
    if (args[0] === "close" && !lostAck) {
      lostAck = true;
      throw new Error("Connection lost after close");
    }
    return result;
  };
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async (_b, _url, _prefs, _type, _topic, _progress, metadata) => {
      calls++;
      await metadata!.read();
      if (calls === 1) throw new Error("METADATA_PAGE_UNAVAILABLE");
      return { verified: true } as any;
    },
  );
  const t = await start(
    conversation,
    "close-ack",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "恢复" },
  );
  Object.assign(t, await conversation.ensureNaming(t.id, t.currentRun));
  expect(t.organizationObservation?.closed).not.toBe(true);
  await conversation.resume(t.id);
  const result = await conversation.ensureNaming(t.id, t.currentRun);
  expect(result.organization.verified).toBe(true);
  expect(result.organizationObservation?.closed).toBe(true);
  expect(browser.sends).toBe(1);
});

test("title-save uncertainty survives restart and resumes only metadata verification", async () => {
  const { state, browser } = setup();
  let calls = 0;
  const baseline = {
    id: "test-conversation",
    title: "old",
    createdAt: "2026-09-22T00:00:00Z",
    projectId: null,
  };
  const organizer = async (
    _b: any,
    _url: any,
    _prefs: any,
    _type: any,
    _topic: any,
    progress: any,
    metadata: any,
    recovery: any,
  ) => {
    calls++;
    if (calls === 1) {
      progress({
        phase: "save_pending",
        baseline,
        rename: { verified: false },
      });
      throw new Error("Connection lost after title save");
    }
    expect(recovery).toEqual({ verificationOnly: true, baseline });
    expect(metadata).toBeDefined();
    return { verified: true, phase: "complete" } as any;
  };
  const create = () =>
    new Conversation(
      state,
      browser as any,
      async () => ({ observedModel: "6 Pro" }),
      organizer,
    );
  let conversation = create();
  const t = await start(
    conversation,
    "save-ack",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "恢复" },
  );
  Object.assign(t, await conversation.ensureNaming(t.id, t.currentRun));
  expect(t.organization.phase).toBe("save_pending");
  await expect(
    conversation.organize(t.id, t.currentRun, "FIX", "different"),
  ).rejects.toThrow("ORGANIZATION_WRITE_UNRESOLVED");
  conversation = create();
  expect(
    (await conversation.ensureNaming(t.id, t.currentRun)).organization.verified,
  ).toBe(true);
  expect(browser.sends).toBe(1);
});

test.each([
  "Conversation UI reported an error",
  "Login required",
  "Human verification required",
])("wait naming handles main page alert: %s", async (blocked) => {
  const { state, browser } = setup();
  let edits = 0;
  const conversation = new Conversation(
    state,
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
    async () => {
      edits++;
      return { verified: true } as any;
    },
  );
  const t = await start(
    conversation,
    "main-alert",
    "Review",
    "initial",
    false,
    undefined,
    { type: "FIX", topic: "命名" },
  );
  browser.pages.get(t.binding!.target).blocked = blocked;
  if (blocked === "Conversation UI reported an error") {
    expect(
      await waitForConversation(
        state,
        conversation,
        t.id,
        t.currentRun,
        0.02,
        new AbortController().signal,
        () => {},
      ),
    ).toBe(2);
    expect(edits).toBe(1);
    expect(conversation.get(t.id).runs[0].state).toBe("blocked");
  } else {
    await conversation.ensureNaming(t.id, t.currentRun);
    expect(edits).toBe(0);
  }
});
