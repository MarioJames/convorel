import { Database } from "bun:sqlite";
import { preference, writePreference } from "../src/user-config.ts";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha } from "../src/workspace.ts";
import { State, tabsLockName } from "../src/state.ts";
import { Conversation } from "../src/conversation.ts";
import { ObservationError } from "../src/browser.ts";
import { waitForConversation } from "../src/wait.ts";
import {
  conversationStatus,
  conversationExitCode,
} from "../src/conversation-status.ts";
let home: string, ws: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "convorel-flow-"));
  ws = mkdtempSync(join(tmpdir(), "convorel-root-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});
class FakeBrowser {
  epochValue = "epoch1";
  targets: any[] = [];
  pages = new Map<string, any>();
  sends = 0;
  clears = 0;
  restoredDraft = "";
  ignoreClear = false;
  nextTarget = 0;
  failSend = false;
  delayedUrl = false;
  sendReady = true;
  releases = 0;
  uniqueUrls = false;
  // Concurrency tests inject a barrier here; default behavior is unchanged.
  gate: ((where: string) => Promise<void>) | undefined = undefined;
  async epoch() {
    return this.epochValue;
  }
  async release() {
    this.releases++;
  }
  async tabs(...args: string[]) {
    if (args[0] === "list") return { tabs: this.targets };
    if (args[0] === "new") {
      const targetId = "target" + ++this.nextTarget;
      this.targets.push({ targetId, url: args[1] });
      this.pages.set(targetId, {
        url: args[1],
        messages: [],
        generating: false,
        hasComposer: true,
        blocked: null,
        draft: this.restoredDraft,
        sendReady: this.sendReady,
      });
      return { targetId };
    }
    if (args[0] === "close") {
      this.targets = this.targets.filter((t) => t.targetId !== args[1]);
      return {};
    }
    return {};
  }
  async page(target: string): Promise<any> {
    if (!this.pages.has(target)) throw new Error("tab_gone");
    const self = this,
      p = this.pages.get(target);
    return {
      session: "fake",
      read: async () => {
        if (self.gate) await self.gate("read:" + target);
        return structuredClone(p);
      },
      run: async (...args: string[]) => {
        if (self.gate) await self.gate("run:" + args[0] + ":" + target);
        if (args[0] === "fill") p.draft = args[2];
        if (args[0] === "eval" && args[1].includes("execCommand")) {
          self.clears++;
          if (!self.ignoreClear) p.draft = "";
          return { result: { cleared: true } };
        }
        if (args[0] === "click") {
          self.sends++;
          const text = p.draft;
          p.draft = "";
          // A real conversation gets a distinct URL per tab only when a test
          // needs several live conversations at once; otherwise all tabs share
          // one URL so target-selection behavior stays exercised.
          if (!self.delayedUrl)
            p.url =
              "https://chatgpt.com/c/" +
              (self.uniqueUrls ? target : "test-conversation");
          self.targets.find((t) => t.targetId === target).url = p.url;
          p.messages.push({
            id: "u" + self.sends,
            role: "user",
            text,
            final: false,
          });
          p.generating = true;
          if (self.failSend)
            throw new Error("transport disconnected after submit");
        }
        return {};
      },
    };
  }
  complete() {
    const p = [...this.pages.values()].at(-1);
    p.generating = false;
    p.messages.push({
      id: "a1",
      role: "assistant",
      text: "Answer",
      final: true,
    });
  }
}
function setup() {
  const state = new State(home);
  state.write("config", {
    version: 1,
    workspace: ws,
    cdp: "9222",
    model: "6 Pro",
  });
  const browser = new FakeBrowser();
  const conversation = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  return { state, browser, conversation };
}
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
  ).toBe("complete");
  expect(browser.sends).toBe(1);
});
test("an error after recognizing the submitted message never restores permission to send", async () => {
  const { state, browser, conversation } = setup();
  const write = state.write.bind(state);
  let failed = false;
  state.write = (key, value) => {
    if (!failed && value.runs?.[0]?.state === "waiting") {
      failed = true;
      throw new Error("Temporary state write failure");
    }
    return write(key, value);
  };
  const t = await start(conversation, "confirmed-send", "Review");
  expect(t.runs[0].userMessageId).toBe("u1");
  expect(t.runs[0].state).toBe("waiting");
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  browser.complete();
  await conversation.resume(t.id, t.currentRun);
  expect(conversation.result(t.id, t.currentRun).reply.text).toBe("Answer");
  expect(browser.sends).toBe(1);
});
test("model drift after filling the draft stops before sending", async () => {
  const { state, browser } = setup();
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => ({
      observedModel: opts["verify-only"] === "true" ? "Changed model" : "6 Pro",
    }),
  );
  const t = await start(conversation, "model-drift", "Conversation");
  expect(t.runs[0]).toMatchObject({
    state: "prepared",
    error: "Error: MODEL_CHANGED_BEFORE_SEND",
  });
  expect(browser.sends).toBe(0);
  expect([...browser.pages.values()][0].draft).toContain(t.runs[0].marker);
});
test("an obstructed Send button retains a prepared run without clicking", async () => {
  const { browser, conversation } = setup();
  browser.sendReady = false;
  const t = await start(conversation, "obstructed", "Conversation");
  expect(t.runs[0]).toMatchObject({
    state: "prepared",
    error: "Error: SEND_CONTROL_UNAVAILABLE",
  });
  expect(browser.sends).toBe(0);
  [...browser.pages.values()][0].sendReady = true;
  expect((await conversation.retry(t.id, t.currentRun)).runs[0].state).toBe(
    "waiting",
  );
  expect(browser.sends).toBe(1);
});
test("a submitted message can precede its persisted conversation URL without allowing a resend", async () => {
  const { browser, conversation } = setup();
  browser.delayedUrl = true;
  const first = await start(conversation, "url-pending", "Conversation");
  expect(first.url).toBeUndefined();
  expect(first.runs[0].state).toBe("waiting");
  expect(first.runs[0].userMessageId).toBe("u1");
  await expect(conversation.retry(first.id, first.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  const p = [...browser.pages.values()][0];
  p.url = "https://chatgpt.com/c/test-conversation";
  browser.targets[0].url = p.url;
  browser.complete();
  expect((await conversation.resume(first.id, first.currentRun)).url).toBe(
    p.url,
  );
  expect(conversation.result(first.id, first.currentRun).reply.text).toBe(
    "Answer",
  );
  expect(browser.sends).toBe(1);
});
test("resume recovers a saved draft URL only on its original target with the exact submitted message", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "legacy-pending", "Conversation");
  first.url = "https://chatgpt.com/";
  first.runs[0].state = "delivery_unknown";
  state.write("task-" + first.id, first);
  browser.complete();
  expect((await conversation.resume(first.id, first.currentRun)).url).toBe(
    "https://chatgpt.com/c/test-conversation",
  );
  expect(browser.sends).toBe(1);
});
test("draft URL recovery never trusts a different submitted message", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "wrong-pending", "Conversation");
  first.url = "https://chatgpt.com/";
  first.runs[0].state = "delivery_unknown";
  state.write("task-" + first.id, first);
  [...browser.pages.values()][0].messages[0].id = "unrelated-user";
  await expect(conversation.resume(first.id, first.currentRun)).rejects.toThrow(
    "PENDING_URL_UNVERIFIED",
  );
  expect(browser.sends).toBe(1);
  expect(state.read<any>("task-" + first.id).url).toBe("https://chatgpt.com/");
});
test("new tasks resolve stored preferences while followups retain their original snapshot", async () => {
  const { state, browser } = setup();
  const checks: string[] = [];
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => {
      checks.push(opts.model);
      return { observedModel: opts.model || "8 Pro" };
    },
  );
  const keys = ["model", "project.url", "project.name"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, preference(k)]));
  try {
    writePreference("model", "7 Pro");
    writePreference("project.url", "");
    writePreference("project.name", "");
    const first = await start(conversation, "preferences", "First");
    expect(first.config.model).toBe("7 Pro");
    expect(first.config.projectUrl).toBeUndefined();
    browser.complete();
    await conversation.poll(first.id, first.currentRun);
    writePreference("model", "");
    const next = await start(
      conversation,
      first.id,
      "Followup",
      "second",
      true,
    );
    expect(next.config.model).toBe("7 Pro");
    browser.delayedUrl = true;
    const other = await start(conversation, "default-preferences", "Other");
    expect(other.config.model).toBeUndefined();
    expect(checks).toEqual(["7 Pro", "7 Pro", "7 Pro", "7 Pro", "", "8 Pro"]);
    expect(other.runs[0].observedModel).toBe("8 Pro");
    expect(state.read<any>("config").model).toBe("6 Pro");
  } finally {
    for (const key of keys) {
      writePreference(key, saved[key] ?? "");
    }
  }
});
test("duplicate start never resends, exact reply persists, finish closes owned page and a new service instance retains its result", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "design", "Conversation");
  await start(conversation, "design", "Conversation");
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("design", first.currentRun);
  expect(conversation.result("design", first.currentRun).reply.text).toBe(
    "Answer",
  );
  await conversation.finish("design", first.currentRun);
  expect(browser.targets.filter((t) => t.url.includes("/c/"))).toHaveLength(0);
  const other = new Conversation(new State(home), browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  expect(other.result("design", first.currentRun).reply.text).toBe("Answer");
});
test("uncertain send reconciles existing marker without a second click", async () => {
  const { browser, conversation } = setup();
  browser.failSend = true;
  const first = await start(conversation, "uncertain", "Conversation");
  expect(browser.sends).toBe(1);
  expect(conversationStatus(first)).toMatchObject({
    delivery: "unknown",
    nextAction: "resume",
    phase: "confirming_delivery",
    observationError: null,
  });
  await conversation.resume("uncertain", first.currentRun);
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("uncertain", first.currentRun);
  expect(conversation.result("uncertain", first.currentRun).reply.text).toBe(
    "Answer",
  );
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
    phase: "complete",
    nextAction: "result",
    observationError: null,
  });
  expect(conversationExitCode(recovered, "resume")).toBe(0);
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
test("a known user turn without composer remains pending, and stale run IDs fail", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "pending", "Conversation");
  const p = [...browser.pages.values()][0];
  p.generating = false;
  p.hasComposer = false;
  expect(
    (await conversation.poll("pending", first.currentRun)).runs.at(-1)!.state,
  ).toBe("waiting");
  await expect(conversation.poll("pending", "different-run")).rejects.toThrow();
  expect(() => conversation.result("pending", first.currentRun)).toThrow();
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
test("a fresh task never fills or sends into a redirected non-ChatGPT page", async () => {
  const { browser, conversation } = setup();
  const original = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const value = await original(...args);
    if (args[0] === "new") {
      browser.pages.get(value.targetId!).url = "https://example.invalid/";
    }
    return value;
  };
  const t = await start(
    conversation,
    "redirect",
    "Private conversation context",
  );
  expect(t.runs.at(-1)!.state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect([...browser.pages.values()][0].draft).toBe("");
});

test("caller content is relayed intact with only a run correlation marker", async () => {
  const { browser, conversation } = setup();
  const input = "请解释这个算法。\n\n```ts\nconst n = 2;\n```\n";
  const first = await start(conversation, "question", input);
  const expected = `[CONVOREL:${first.currentRun}]\n\n${input}`;
  expect(first.runs[0].prompt).toBe(expected);
  expect([...browser.pages.values()][0].messages[0].text).toBe(expected);
  browser.complete();
  await conversation.poll("question", first.currentRun);
  const nextInput = "补充问题：为什么？\n";
  const next = await start(
    conversation,
    "question",
    nextInput,
    "second-question",
    true,
  );
  expect(next.runs.at(-1)!.prompt).toBe(
    `[CONVOREL:${next.currentRun}]\n\n${nextInput}`,
  );
  expect([...browser.pages.values()][0].messages.at(-1).text).toBe(
    next.runs.at(-1)!.prompt,
  );
});

test("followup restores a closed conversation after page loading and retains earlier runs", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "continued", "Initial question");
  browser.complete();
  await conversation.poll("continued", first.currentRun);
  const saved = structuredClone([...browser.pages.values()][0]);
  await conversation.finish("continued", first.currentRun);
  const original = browser.page.bind(browser);
  let reads = 0;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      read: async () => {
        reads++;
        if (reads === 1)
          return {
            ...saved,
            url: "about:blank",
            hasComposer: false,
            messages: [],
          };
        if (reads === 2) return { ...saved, messages: [] };
        if (reads === 3)
          return { ...saved, messages: saved.messages.slice(0, 1) };
        if (reads === 4 || reads === 5)
          return {
            ...saved,
            messages: saved.messages.map((m: any) =>
              m.role === "assistant"
                ? {
                    ...m,
                    text: reads === 4 ? "An" : m.text,
                    final: reads === 4,
                  }
                : m,
            ),
          };
        const p = browser.pages.get(target);
        if (!p.messages.length) Object.assign(p, structuredClone(saved));
        return b.read();
      },
    };
  };
  const modelChecks: Record<string, string>[] = [];
  const restored = new Conversation(
    new State(home),
    browser as any,
    async (_b, opts) => {
      modelChecks.push(opts);
      if (opts.model !== "6 Pro") throw new Error("No element found: Latest");
      return { observedModel: "6 Pro" };
    },
  );
  const next = await start(restored, "continued", "Follow-up", "second", true);
  expect(modelChecks).toEqual([
    { url: first.url!, target: next.binding!.target, model: "6 Pro" },
    {
      url: first.url!,
      target: next.binding!.target,
      model: "6 Pro",
      "verify-only": "true",
    },
  ]);
  expect(next.url).toBe(first.url);
  expect(next.runs).toHaveLength(2);
  expect(next.runs[0].reply?.text).toBe("Answer");
  expect(next.runs[1].state).toBe("waiting");
  expect(browser.sends).toBe(2);
});
async function completedWithClaimedTab() {
  const setupResult = setup();
  const { state, browser, conversation } = setupResult;
  const first = await start(conversation, "continued", "Initial question");
  browser.complete();
  await conversation.poll(first.id, first.currentRun);
  const savedPage = structuredClone(browser.pages.get(first.binding!.target));
  await conversation.finish(first.id, first.currentRun);
  browser.sendReady = false;
  const other = await start(conversation, "occupant", "Unsent question");
  // Its registered URL differs, but its target has navigated to this conversation.
  other.url = "https://chatgpt.com/c/other-conversation";
  state.write("task-" + other.id, other);
  const target = other.binding!.target;
  browser.targets.find((t) => t.targetId === target).url = first.url;
  browser.pages.get(target).url = first.url;
  browser.pages.get(target).draft = "Other task's private draft";
  browser.sendReady = true;
  const tabs = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const result = await tabs(...args);
    if (args[0] === "new" && args[1] === first.url)
      Object.assign(
        browser.pages.get(result.targetId!),
        structuredClone(savedPage),
      );
    return result;
  };
  return { ...setupResult, first, other, savedPage };
}

test.each([true, false])(
  "completed followup skips a claimed target (owned=%s) and sends once on its own restored page",
  async (owned) => {
    const { state, browser, conversation, first, other } =
      await completedWithClaimedTab();
    other.binding!.owned = owned;
    state.write("task-" + other.id, other);
    const otherPage = structuredClone(browser.pages.get(other.binding!.target));
    const targets = structuredClone(browser.targets);
    const page = browser.page.bind(browser);
    browser.page = async (target) => {
      expect(target).not.toBe(other.binding!.target);
      return page(target);
    };
    const next = await start(conversation, first.id, "Follow-up", "next", true);
    expect(next.binding).toMatchObject({ owned: true, epoch: "epoch1" });
    expect(next.binding!.target).not.toBe(other.binding!.target);
    expect(next.url).toBe(first.url);
    expect(next.runs).toHaveLength(2);
    expect(next.runs[0].id).toBe(first.currentRun);
    expect(next.runs[0].reply?.text).toBe("Answer");
    expect(next.runs[1].state).toBe("waiting");
    expect(browser.sends).toBe(2);
    expect(browser.targets).toEqual([
      ...targets,
      { targetId: next.binding!.target, url: first.url },
    ]);
    expect(conversation.get(other.id)).toEqual(other);
    expect(browser.pages.get(other.binding!.target)).toEqual(otherPage);
    expect(
      await start(conversation, first.id, "Follow-up", "next", true),
    ).toEqual(next);
    expect(browser.sends).toBe(2);
  },
);

test("restored followup verifies the entire completed branch before sending its saved run", async () => {
  const { browser, conversation, first, other, savedPage } =
    await completedWithClaimedTab();
  savedPage.messages.push({
    id: "foreign-user",
    role: "user",
    text: "Later message",
    final: false,
  });
  const otherPage = structuredClone(browser.pages.get(other.binding!.target));
  const failed = await start(conversation, first.id, "Follow-up", "next", true);
  expect(failed.runs.at(-1)?.error).toContain("COMPLETED_TURN_CHANGED");
  const after = conversation.get(first.id);
  expect(after.currentRun).not.toBe(first.currentRun);
  expect(after.runs).toHaveLength(2);
  expect(after.runs[1].state).toBe("prepared");
  expect(after.runs[0].state).toBe("complete");
  expect(browser.sends).toBe(1);
  expect(conversation.get(other.id)).toEqual(other);
  expect(browser.pages.get(other.binding!.target)).toEqual(otherPage);
});

test("prepared retry still rejects a conflicting target instead of replacing it", async () => {
  const { browser, conversation, other } = await completedWithClaimedTab();
  const conflicting = conversation.get("continued");
  conflicting.id = "conflicting";
  conflicting.url = undefined;
  conflicting.binding = { ...other.binding! };
  conversation.store.write("task-conflicting", conflicting);
  const targets = structuredClone(browser.targets);
  await expect(conversation.retry(other.id, other.currentRun)).rejects.toThrow(
    "TARGET_CONFLICT",
  );
  expect(browser.targets).toEqual(targets);
  expect(browser.sends).toBe(1);
});

test.each([1, 2])(
  "completed followup considers only unclaimed candidates and preserves ambiguity (%s available)",
  async (count) => {
    const { browser, conversation, first, other } =
      await completedWithClaimedTab();
    const candidates = [];
    for (let n = 0; n < count; n++)
      candidates.push(await browser.tabs("new", first.url!));
    const targets = structuredClone(browser.targets);
    if (count === 1) {
      const next = await start(
        conversation,
        first.id,
        "Follow-up",
        "next",
        true,
      );
      expect(next.binding).toMatchObject({
        target: candidates[0]!.targetId,
        owned: false,
      });
      expect(browser.sends).toBe(2);
    } else {
      const failed = await start(
        conversation,
        first.id,
        "Follow-up",
        "next",
        true,
      );
      expect(failed.runs.at(-1)?.error).toContain(
        "AMBIGUOUS_CONVERSATION_TABS",
      );
      expect(failed.runs.at(-1)?.state).toBe("prepared");
      expect(conversation.get(first.id).runs).toHaveLength(2);
      expect(browser.sends).toBe(1);
    }
    expect(browser.targets).toEqual(targets);
    expect(conversation.get(other.id)).toEqual(other);
  },
);

test("composer nonbreaking spaces preserve indentation without accepting changed words", async () => {
  const { browser, conversation } = setup();
  const original = browser.page.bind(browser);
  let changeWords = false;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        const result = await b.run(...args);
        if (args[0] === "fill") {
          const p = browser.pages.get(target);
          p.draft = p.draft.replace(/  /g, "\u00a0 ");
          if (changeWords) p.draft += "unexpected modification";
        }
        return result;
      },
    };
  };
  const first = await start(conversation, "spaces", "Code:\n  const n = 1;");
  expect(first.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
  // Independent task must still stop on an actual text mutation.
  changeWords = true;
  const second = await start(
    conversation,
    "changed-words",
    "Code:\n  const n = 2;",
  );
  expect(second.runs[0].state).toBe("prepared");
  expect(second.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(1);
});

test("restoring a saved conversation refuses a different conversation without sending", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "restore-drift", "Initial question");
  browser.complete();
  await conversation.poll("restore-drift", first.currentRun);
  await conversation.finish("restore-drift", first.currentRun);
  const original = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const result = await original(...args);
    if (args[0] === "new") {
      browser.pages.get(result.targetId!).url =
        "https://chatgpt.com/c/unrelated";
    }
    return result;
  };
  const failed = await start(
    conversation,
    "restore-drift",
    "Next question",
    "next",
    true,
  );
  expect(failed.runs.at(-1)?.error).toContain("CONVERSATION_CHANGED");
  expect(failed.runs.at(-1)?.state).toBe("prepared");
  expect(browser.sends).toBe(1);
  expect(conversation.get("restore-drift").runs).toHaveLength(2);
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
    new State(home),
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
test("pre-submit recovery is explicit, run-bound and never retries uncertain delivery", async () => {
  const { state, browser } = setup();
  let available = false;
  const conversation = new Conversation(state, browser as any, async () => {
    if (!available) throw new Error("MODEL_UNVERIFIED");
    return { observedModel: "6 Pro" };
  });
  const first = await start(conversation, "recover-send", "Question");
  expect(first.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(
    (await conversation.resume("recover-send", first.currentRun)).runs[0].state,
  ).toBe("prepared");
  available = true;
  await expect(conversation.retry("recover-send", "stale")).rejects.toThrow(
    "STALE_RUN",
  );
  browser.failSend = true;
  const next = await conversation.retry("recover-send", first.currentRun);
  expect(next.currentRun).toBe(first.currentRun);
  expect(next.runs[0].state).toBe("delivery_unknown");
  expect(browser.sends).toBe(1);
  await expect(
    conversation.retry("recover-send", first.currentRun),
  ).rejects.toThrow("RUN_NOT_PREPARED");
  await conversation.resume("recover-send", first.currentRun);
  expect(browser.sends).toBe(1);
});

test("explicit retry preserves a changed draft and continues only the recorded message", async () => {
  const { browser, conversation } = setup();
  const original = browser.page.bind(browser);
  let failFill = true;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        const result = await b.run(...args);
        if (args[0] === "fill" && failFill)
          throw new Error("fill response lost");
        return result;
      },
    };
  };
  const first = await start(conversation, "retry-draft", "Recorded question");
  expect(first.runs[0].state).toBe("prepared");
  const p = [...browser.pages.values()][0];
  failFill = false;
  p.draft = "User's changed draft";
  const refused = await conversation.retry("retry-draft", first.currentRun);
  expect(refused.runs[0].error).toContain("DRAFT_CHANGED");
  expect(p.draft).toBe("User's changed draft");
  expect(browser.sends).toBe(0);
  p.draft = first.runs[0].prompt;
  const sent = await conversation.retry("retry-draft", first.currentRun);
  expect(sent.currentRun).toBe(first.currentRun);
  expect(sent.runs).toHaveLength(1);
  expect(sent.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
});

test("restored draft recovery backs up, confirms clearing, then retries the same prompt with model verification", async () => {
  const { state, browser } = setup();
  let modelChecks = 0;
  const conversation = new Conversation(state, browser as any, async () => {
    modelChecks++;
    return { observedModel: "6 Pro" };
  });
  browser.restoredDraft = "Old restored draft\nsecond line";
  const t = await start(conversation, "restored", "Recorded question");
  expect(t.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(0);
  expect(modelChecks).toBe(0);
  const original = browser.page.bind(browser);
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "eval")
          expect(conversation.get(t.id).runs[0].draftRecovery).toMatchObject({
            draft: browser.restoredDraft,
            cleared: false,
            target,
          });
        return b.run(...args);
      },
    };
  };
  const cleared = await conversation.clearDraft(
    t.id,
    t.currentRun,
    browser.restoredDraft,
  );
  expect(cleared.runs[0].draftRecovery?.cleared).toBe(true);
  expect(cleared.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(browser.clears).toBe(1);
  const sent = await conversation.retry(t.id, t.currentRun);
  expect(sent.runs).toHaveLength(1);
  expect(sent.currentRun).toBe(t.currentRun);
  expect(sent.runs[0].prompt).toBe(t.runs[0].prompt);
  expect(sent.runs[0].state).toBe("waiting");
  expect(sent.runs[0].observedModel).toBe("6 Pro");
  expect(modelChecks).toBe(2);
  expect(browser.sends).toBe(1);
  expect(browser.pages.get(t.binding!.target).messages[0].text).toBe(
    t.runs[0].prompt,
  );
  await expect(
    conversation.clearDraft(t.id, t.currentRun, browser.restoredDraft),
  ).rejects.toThrow("RUN_NOT_PREPARED");
});

test("recovery refuses changed drafts, stale runs, attachments, history, and borrowed pages without clearing", async () => {
  const { state, browser, conversation } = setup();
  browser.restoredDraft = "Old draft";
  const t = await start(conversation, "recovery-guards", "Question");
  const p = browser.pages.get(t.binding!.target);
  await expect(
    conversation.clearDraft(t.id, "stale", "Old draft"),
  ).rejects.toThrow("STALE_RUN");
  p.draft = "User edit";
  await expect(
    conversation.clearDraft(t.id, t.currentRun, "Old draft"),
  ).rejects.toThrow("DRAFT_CHANGED");
  expect(p.draft).toBe("User edit");
  p.draft = "Old draft";
  p.attachments = true;
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("PAGE_NOT_IDLE");
  p.attachments = false;
  p.messages = [{ id: "submitted", role: "user", text: t.runs[0].prompt }];
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("UNEXPECTED_CONVERSATION_HISTORY");
  p.messages = [];
  const borrowed = conversation.get(t.id);
  borrowed.binding!.owned = false;
  state.write("task-" + t.id, borrowed);
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("DRAFT_RECOVERY_REQUIRES_OWNED_NEW_PAGE");
  expect(browser.clears).toBe(0);
  expect(browser.sends).toBe(0);
});

test("a successful browser command does not prove the draft cleared and never triggers retry", async () => {
  const { browser, conversation } = setup();
  browser.restoredDraft = "Restored draft";
  browser.ignoreClear = true;
  const t = await start(conversation, "unverified-clear", "Question");
  await expect(
    conversation.clearDraft(t.id, t.currentRun, browser.restoredDraft),
  ).rejects.toThrow("DRAFT_CLEAR_UNVERIFIED");
  expect(conversation.get(t.id).runs[0].draftRecovery?.cleared).toBe(false);
  expect(conversation.get(t.id).runs[0].state).toBe("prepared");
  expect(browser.clears).toBe(1);
  expect(browser.sends).toBe(0);
});

for (const delivery of ["submitting", "delivery_unknown"]) {
  test(`draft recovery cannot reauthorize ${delivery} delivery`, async () => {
    const { state, browser, conversation } = setup();
    browser.restoredDraft = "Old draft";
    const t = await start(conversation, "unknown-recovery", "Question");
    t.runs[0].state = delivery;
    state.write("task-" + t.id, t);
    await expect(
      conversation.clearDraft(t.id, t.currentRun, "Old draft"),
    ).rejects.toThrow("RUN_NOT_PREPARED");
    await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
      "RUN_NOT_PREPARED",
    );
    expect(browser.clears).toBe(0);
    expect(browser.sends).toBe(0);
  });
}

test("workspace snapshots can be selected explicitly and mismatch cannot silently reuse or retry a task", async () => {
  const { browser, conversation } = setup();
  const other = join(ws, "other");
  mkdirSync(other);
  browser.restoredDraft = "Old draft";
  const t = await start(
    conversation,
    "workspace-binding",
    "Question",
    "initial",
    false,
    other,
  );
  expect(t.config.workspace).toBe(other);
  expect(conversationStatus(t).workspace).toBe(other);
  await expect(
    start(conversation, t.id, "Question", "initial", false, ws),
  ).rejects.toThrow("WORKSPACE_MISMATCH");
  await expect(conversation.retry(t.id, t.currentRun, ws)).rejects.toThrow(
    "WORKSPACE_MISMATCH",
  );
  expect(browser.sends).toBe(0);
});

test("explicit prepared workspace correction retains prompt/run and rejects stale binding or uncertain delivery", async () => {
  const { state, browser, conversation } = setup();
  const other = join(ws, "other");
  mkdirSync(other);
  browser.restoredDraft = "Old draft";
  const t = await start(conversation, "correct-workspace", "Question");
  const corrected = await conversation.rebindWorkspace(
    t.id,
    t.currentRun,
    ws,
    other,
  );
  expect(corrected.config.workspace).toBe(other);
  expect(corrected.workspaceId).not.toBe(t.workspaceId);
  expect(corrected.runs).toEqual(t.runs);
  expect(corrected.currentRun).toBe(t.currentRun);
  expect(state.read<any>("config").workspace).toBe(ws);
  await expect(
    conversation.rebindWorkspace(t.id, t.currentRun, ws, other),
  ).rejects.toThrow("WORKSPACE_MISMATCH");
  corrected.runs[0].state = "delivery_unknown";
  state.write("task-" + t.id, corrected);
  await expect(
    conversation.rebindWorkspace(t.id, t.currentRun, other, ws),
  ).rejects.toThrow("RUN_NOT_PREPARED");
  expect(browser.sends).toBe(0);
});

async function missingDelivery(priorInput = "Architecture review") {
  const ctx = setup();
  const { conversation, browser } = ctx;
  const first = await start(conversation, "missing-send", priorInput);
  browser.complete();
  await conversation.poll(first.id, first.currentRun);
  const sent = await start(
    conversation,
    first.id,
    "Result review\n",
    "result",
    true,
  );
  const p = browser.pages.get(sent.binding!.target);
  p.messages = p.messages.slice(0, 2);
  p.generating = false;
  const blocked = await conversation.resume(sent.id, sent.currentRun);
  const r = blocked.runs.at(-1)!;
  const evidence = [
    {
      method: "POST",
      url: "https://chatgpt.com/backend-api/f/conversation",
      status: 403,
      timestamp: Date.parse(r.submittedAt || r.createdAt),
    },
  ];
  const options = {
    expectedUserMessageId: r.userMessageId!,
    expectedUrl: blocked.url!,
    input: "Result review\n",
    reason:
      "Operator verified Cloudflare rejection and refreshed original page",
    evidence,
    rejectedAt: evidence[0].timestamp,
    confirmCloudflareChallenge: true,
  };
  return { ...ctx, t: blocked, p, options };
}

test("explicit rejected-send recovery keeps task/run/prompt and durably audits the old user before sending once", async () => {
  const { conversation, browser, t, options } = await missingDelivery();
  const prior = structuredClone(t.runs[0]);
  const original = browser.page.bind(browser);
  browser.page = async (target) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "click") {
          const saved = conversation.get(t.id).runs.at(-1)!;
          expect(saved.state).toBe("submitting");
          expect(saved.sendRecoveries?.at(-1)).toMatchObject({
            priorUserMessageId: options.expectedUserMessageId,
            priorAttemptId: t.attemptId,
            reason: options.reason,
            evidence: options.evidence[0],
          });
        }
        return b.run(...args);
      },
    };
  };
  const recovered = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(recovered.currentRun).toBe(t.currentRun);
  expect(recovered.url).toBe(t.url);
  expect(recovered.runs).toHaveLength(2);
  expect(recovered.runs[0]).toEqual(prior);
  expect(recovered.runs[1].prompt).toBe(t.runs[1].prompt);
  expect(recovered.runs[1].userMessageId).toBe("u3");
  expect(recovered.runs[1].state).toBe("waiting");
  expect(browser.sends).toBe(3);
  await expect(
    conversation.recoverSend(t.id, t.currentRun, options),
  ).rejects.toThrow("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  await conversation.resume(t.id, t.currentRun);
  expect(browser.sends).toBe(3);
});

for (const scenario of [
  "stale-run",
  "old-user",
  "url",
  "prompt",
  "reason",
  "unconfirmed",
  "missing-evidence",
  "wrong-status",
  "wrong-endpoint",
  "wrong-time",
  "ambiguous-evidence",
  "waiting",
  "delivery_unknown",
  "prepared",
  "complete",
  "borrowed",
  "closed",
  "epoch",
  "target-gone",
  "target-navigated",
  "user-present",
  "marker-present",
  "draft",
  "attachments",
  "generating",
  "no-composer",
  "blocked-page",
  "changed-reply",
  "changed-branch",
  "changed-prior-user",
]) {
  test(`rejected-send recovery refuses ${scenario} without filling, sending, or changing saved delivery`, async () => {
    const { state, conversation, browser, t, p, options } =
      await missingDelivery();
    let run = t.currentRun;
    if (scenario === "stale-run") run = "stale";
    if (scenario === "old-user") options.expectedUserMessageId = "other";
    if (scenario === "url") options.expectedUrl = "https://chatgpt.com/c/other";
    if (scenario === "prompt") options.input += "changed";
    if (scenario === "reason") options.reason = " ";
    if (scenario === "unconfirmed") options.confirmCloudflareChallenge = false;
    if (scenario === "missing-evidence") options.evidence = [];
    if (scenario === "wrong-status") options.evidence[0].status = 200;
    if (scenario === "wrong-endpoint") options.evidence[0].url += "/prepare";
    if (scenario === "wrong-time") options.rejectedAt -= 60000;
    if (scenario === "ambiguous-evidence")
      options.evidence.push({ ...options.evidence[0] });
    if (
      ["waiting", "delivery_unknown", "prepared", "complete"].includes(scenario)
    )
      t.runs[1].state = scenario;
    if (scenario === "borrowed") t.binding!.owned = false;
    if (scenario === "closed") t.binding!.closed = true;
    if (scenario === "epoch") browser.epochValue = "restarted";
    if (scenario === "target-gone") browser.targets = [];
    if (scenario === "target-navigated") browser.targets[0].url += "-other";
    if (scenario === "user-present")
      p.messages.push({
        id: options.expectedUserMessageId,
        role: "user",
        text: "changed",
      });
    if (scenario === "marker-present")
      p.messages.push({
        id: "different",
        role: "user",
        text: t.runs[1].prompt,
      });
    if (scenario === "draft") p.draft = "User edit";
    if (scenario === "attachments") p.attachments = true;
    if (scenario === "generating") p.generating = true;
    if (scenario === "no-composer") p.hasComposer = false;
    if (scenario === "blocked-page") p.blocked = "Cloudflare";
    if (scenario === "changed-reply") p.messages[1].text = "changed";
    if (scenario === "changed-branch")
      p.messages.splice(1, 0, {
        id: "new-branch",
        role: "assistant",
        text: "new",
      });
    if (scenario === "changed-prior-user")
      p.messages[0].text = "edited prior user";
    state.write("task-" + t.id, t);
    const before = conversation.get(t.id);
    await expect(
      conversation.recoverSend(t.id, run, options),
    ).rejects.toThrow();
    expect(conversation.get(t.id)).toEqual(before);
    expect(browser.sends).toBe(2);
    expect(p.draft).toBe(scenario === "draft" ? "User edit" : "");
    expect(browser.nextTarget).toBe(1);
  });
}

for (const drift of ["marker", "history", "target", "epoch"]) {
  test(`rejected-send recovery rechecks ${drift} after model selection without granting ordinary retry`, async () => {
    const { state, browser, t, p, options } = await missingDelivery();
    const conversation = new Conversation(state, browser as any, async () => {
      if (drift === "marker")
        p.messages.push({ id: "late", role: "user", text: t.runs[1].prompt });
      if (drift === "history") p.messages[1].text = "changed reply";
      if (drift === "target") browser.targets = [];
      if (drift === "epoch") browser.epochValue = "new epoch";
      return { observedModel: "6 Pro" };
    });
    const result = await conversation.recoverSend(t.id, t.currentRun, options);
    expect(result.runs[1].state).toBe("blocked");
    expect(result.runs[1].userMessageId).toBe(options.expectedUserMessageId);
    expect(result.runs[1].sendRecoveries).toBeUndefined();
    expect(result.runs[1].error).toBeTruthy();
    await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
      "RUN_NOT_PREPARED",
    );
    expect(browser.sends).toBe(2);
    expect(browser.nextTarget).toBe(1);
  });
}

test("a recovery send transport failure stays uncertain, retains audit, and cannot reuse rejection evidence", async () => {
  const { conversation, browser, t, options, p } = await missingDelivery();
  browser.failSend = true;
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("delivery_unknown");
  expect(result.runs[1].sendRecoveries).toHaveLength(1);
  expect(result.runs[1].userMessageId).toBeUndefined();
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  await expect(
    conversation.recoverSend(t.id, t.currentRun, options),
  ).rejects.toThrow("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
  const observed = await conversation.resume(t.id, t.currentRun);
  const newId = observed.runs[1].userMessageId!;
  p.messages = p.messages.slice(0, 2);
  p.generating = false;
  await conversation.resume(t.id, t.currentRun);
  await expect(
    conversation.recoverSend(t.id, t.currentRun, {
      ...options,
      expectedUserMessageId: newId,
    }),
  ).rejects.toThrow("REJECTED_SEND_EVIDENCE_REQUIRED");
  expect(browser.sends).toBe(3);
});

test("legacy confirmed records without a send timestamp recover using creation time and persist only allowlisted evidence", async () => {
  const { state, conversation, t, options } = await missingDelivery();
  delete t.runs[1].submittedAt;
  state.write("task-" + t.id, t);
  const result = await conversation.recoverSend(t.id, t.currentRun, {
    ...options,
    evidence: [
      { ...options.evidence[0], unrelatedMetadata: "must not be persisted" },
    ],
  });
  expect(result.runs[1].state).toBe("waiting");
  expect(result.runs[1].sendRecoveries![0].evidence).toEqual(
    options.evidence[0],
  );
});

test("recovery rechecks the composer after the final target check", async () => {
  const { browser, conversation, t, p, options } = await missingDelivery();
  const original = browser.tabs.bind(browser);
  let lists = 0;
  browser.tabs = async (...args) => {
    if (args[0] === "list" && ++lists === 2)
      p.draft = "User changed the composer";
    return original(...args);
  };
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("blocked");
  expect(result.runs[1].error).toContain("RECOVERY_DRAFT_OR_SEND_CHANGED");
  expect(result.runs[1].sendRecoveries).toBeUndefined();
  expect(p.draft).toBe("User changed the composer");
  expect(browser.sends).toBe(2);
});

test("recovery anchors the completed user despite rendered code whitespace and Show more text", async () => {
  const { conversation, t, p, options } = await missingDelivery(
    "Architecture review\n\n```ts\n/*\n *   request's cost; the next request is then blocked.\n */\n```\n",
  );
  p.messages[0].text = `${t.runs[0].marker}\n\nArchitecture review\n\n\n\`\`\`ts\n/*\n * request's cost; the next request is then blocked.\n */\n\`\`\`\n\nShow more`;
  const recovered = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(recovered.runs[1].state).toBe("waiting");
  expect(recovered.runs[0]).toEqual(t.runs[0]);
});

for (const mismatch of [
  "missing-marker",
  "duplicate-marker",
  "repeated-marker",
  "changed-user-id",
  "corrupt-saved-marker",
]) {
  test(`completed-user recovery anchor rejects ${mismatch}`, async () => {
    const { conversation, state, browser, t, p, options } =
      await missingDelivery();
    if (mismatch === "missing-marker")
      p.messages[0].text = "Architecture review";
    if (mismatch === "duplicate-marker")
      p.messages.unshift({
        id: "unrelated",
        role: "user",
        text: t.runs[0].marker,
      });
    if (mismatch === "repeated-marker") p.messages[0].text += t.runs[0].marker;
    if (mismatch === "changed-user-id") p.messages[0].id = "unrelated";
    if (mismatch === "corrupt-saved-marker") {
      t.runs[0].marker = "";
      state.write("task-" + t.id, t);
    }
    await expect(
      conversation.recoverSend(t.id, t.currentRun, options),
    ).rejects.toThrow();
    expect(browser.sends).toBe(2);
    expect(p.draft).toBe("");
  });
}

for (const mode of [
  "observed",
  "observed-over-config",
  "history-fallback",
  "config-fallback",
  "default-fallback",
]) {
  test(`recovery retains its observed model and both verifications: ${mode}`, async () => {
    const { state, browser, t, options } = await missingDelivery();
    t.config.model = mode.includes("config") ? "5.6 Pro" : undefined;
    t.runs[1].observedModel = mode.startsWith("observed") ? "6 Pro" : undefined;
    if (mode === "default-fallback") delete t.runs[0].observedModel;
    state.write("task-" + t.id, t);
    const checks: Record<string, string>[] = [];
    const expected =
      mode === "default-fallback"
        ? ""
        : mode === "config-fallback"
          ? "5.6 Pro"
          : "6 Pro";
    const selected = expected || "7 Pro";
    const conversation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts);
        if (opts.model !== (checks.length === 1 ? expected : selected))
          throw new Error(
            "Unexpected model selection; original model must be retained",
          );
        return { observedModel: selected };
      },
    );
    const result = await conversation.recoverSend(t.id, t.currentRun, options);
    expect(result.runs[1].state).toBe("waiting");
    expect(checks).toEqual([
      { url: t.url!, target: t.binding!.target, model: expected },
      {
        url: t.url!,
        target: t.binding!.target,
        model: selected,
        "verify-only": "true",
      },
    ]);
    expect(result.runs[1].observedModel).toBe(selected);
    expect(browser.sends).toBe(3);
  });
}

test("recovery retaining a model still refuses a failed final verification", async () => {
  const { state, browser, t, options } = await missingDelivery();
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => {
      if (opts["verify-only"] === "true")
        throw new Error("MODEL_UNVERIFIED: configured model did not persist");
      return { observedModel: "6 Pro" };
    },
  );
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("blocked");
  expect(result.runs[1].error).toContain(
    "MODEL_UNVERIFIED: configured model did not persist",
  );
  expect(result.runs[1].sendRecoveries).toBeUndefined();
  expect(browser.sends).toBe(2);
});

for (const mode of [
  "followup",
  "retry-before-verification",
  "retry-after-verification",
  "explicit-config",
  "model-conflict",
]) {
  test(`continuation preserves the verified model through both checks: ${mode}`, async () => {
    const { state, browser, conversation } = setup();
    const first = await start(conversation, "continue-model", "First");
    browser.complete();
    const completed = await conversation.poll(first.id, first.currentRun);
    completed.config.model = mode === "explicit-config" ? "7 Pro" : undefined;
    state.write("task-" + first.id, completed);
    const checks: Record<string, string>[] = [];
    let fail = mode.startsWith("retry-");
    const expected = mode === "explicit-config" ? "7 Pro" : "6 Pro";
    const continuation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts);
        if (!opts.model) throw new Error("No element found: Latest");
        if (mode === "model-conflict")
          throw new Error("Pro selection did not match expected model 6 Pro");
        if (
          fail &&
          (mode === "retry-before-verification" ||
            opts["verify-only"] === "true")
        )
          throw new Error("Temporary verification failure");
        return { observedModel: opts.model };
      },
    );
    let result = await start(
      continuation,
      first.id,
      "Followup",
      "second",
      true,
    );
    const prepared = structuredClone(result.runs[1]);
    if (mode.startsWith("retry-")) {
      expect(prepared.state).toBe("prepared");
      expect(prepared.observedModel).toBe(
        mode === "retry-after-verification" ? "6 Pro" : undefined,
      );
      expect(browser.sends).toBe(1);
      // A same-run observation must win even over a conflicting saved config.
      if (mode === "retry-after-verification") {
        result.config.model = "7 Pro";
        state.write("task-" + result.id, result);
      }
      fail = false;
      checks.length = 0;
      result = await continuation.retry(result.id, result.currentRun);
      expect(result.runs[1]).toMatchObject({
        id: prepared.id,
        prompt: prepared.prompt,
        promptHash: prepared.promptHash,
        inputHash: prepared.inputHash,
        marker: prepared.marker,
      });
    }
    expect(checks[0]).toEqual({
      url: first.url!,
      target: first.binding!.target,
      model: expected,
    });
    expect(result.runs[0]).toMatchObject({
      id: completed.runs[0].id,
      prompt: completed.runs[0].prompt,
      promptHash: completed.runs[0].promptHash,
      observedModel: "6 Pro",
      reply: completed.runs[0].reply!,
      replyHash: completed.runs[0].replyHash!,
      branch: completed.runs[0].branch!,
      state: "complete",
    });
    if (mode === "model-conflict") {
      expect(result.runs[1].state).toBe("prepared");
      expect(result.runs[1].error).toContain("expected model 6 Pro");
      expect(checks).toHaveLength(1);
      expect(browser.sends).toBe(1);
      expect(browser.pages.get(first.binding!.target).draft).toBe("");
    } else {
      expect(checks).toHaveLength(2);
      expect(checks[1]).toEqual({ ...checks[0], "verify-only": "true" });
      expect(result.runs[1]).toMatchObject({
        state: "waiting",
        observedModel: expected,
      });
      expect(browser.sends).toBe(2);
    }
  });
}

for (const historicalState of [
  "complete",
  "prepared",
  "waiting",
  "blocked",
  "delivery_unknown",
]) {
  test(`continuation only inherits a completed historical observation: ${historicalState}`, async () => {
    const { state, browser, conversation } = setup();
    const first = await start(conversation, "historical-model", "First");
    browser.complete();
    const completed = await conversation.poll(first.id, first.currentRun);
    completed.config.model = undefined;
    const anchor = structuredClone(completed.runs[0]);
    // Legacy completed anchors may lack an observation; inspect older runs only.
    delete completed.runs[0].observedModel;
    completed.runs.unshift({
      ...anchor,
      id: "older",
      requestId: "older",
      state: historicalState,
      observedModel: "5.6 Pro",
    });
    state.write("task-" + first.id, completed);
    const checks: string[] = [];
    const continuation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts.model);
        return { observedModel: opts.model || "7 Pro" };
      },
    );
    const result = await start(
      continuation,
      first.id,
      "Followup",
      "second",
      true,
    );
    expect(checks).toEqual(
      historicalState === "complete" ? ["5.6 Pro", "5.6 Pro"] : ["", "7 Pro"],
    );
    expect(result.runs[2].state).toBe("waiting");
  });
}

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
    await expect(conversation.poll(first.id)).rejects.toThrow(
      "Transport unavailable",
    );
  }
  due();
  await expect(conversation.poll(first.id)).rejects.toThrow("STALLED_REPLY");
  expect(reloads).toBe(7);
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

test("project starts use only the configured project composer and reject a generic or changed page before send", async () => {
  const oldUrl = preference("project.url"),
    oldName = preference("project.name");
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  try {
    for (const scenario of ["project", "generic", "drift"]) {
      const { state: base, browser } = setup();
      const state = new State(join(home, scenario));
      state.write("config", base.read("config"));
      const originalPage = browser.page.bind(browser);
      browser.page = async (target: string) => {
        const page = await originalPage(target);
        return {
          ...page,
          run: async (...args: string[]) => {
            if (args[0] === "eval" && args[1].includes("composerCount"))
              return {
                result: {
                  url: projectUrl,
                  composerCount: 1,
                  editable: true,
                  projectName: scenario === "generic" ? null : "Agent reviews",
                },
              };
            return page.run(...args);
          },
        };
      };
      const conversation = new Conversation(state, browser as any, async () => {
        if (scenario === "drift")
          [...browser.pages.values()][0].url = "https://chatgpt.com/";
        return { observedModel: "6 Pro" };
      });
      const task = await start(conversation, "project-" + scenario, "Review");
      expect(browser.targets).toHaveLength(1);
      expect(task.config.projectUrl).toBe(projectUrl);
      if (scenario === "project") expect(browser.sends).toBe(1);
      else {
        expect(browser.sends).toBe(0);
        expect(task.runs[0].state).toBe("prepared");
        expect(task.runs[0].error).toContain(
          scenario === "generic"
            ? "PROJECT_COMPOSER_UNVERIFIED"
            : "NEW_CONVERSATION_LOCATION_CHANGED",
        );
      }
    }
  } finally {
    writePreference("project.url", oldUrl ?? "");
    writePreference("project.name", oldName ?? "");
  }
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

function makeGate() {
  const blockKeys = new Set<string>();
  const reached = new Set<string>();
  const latches = new Map<string, { p: Promise<void>; resolve: () => void }>();
  return {
    gate: async (where: string) => {
      if (!blockKeys.has(where)) return;
      reached.add(where);
      let l = latches.get(where);
      if (!l) {
        let resolve!: () => void;
        const p = new Promise<void>((r) => (resolve = r));
        l = { p, resolve };
        latches.set(where, l);
      }
      await l.p;
    },
    block: (key: string) => void blockKeys.add(key),
    release: (key: string) => latches.get(key)?.resolve(),
    reached: (key: string) => reached.has(key),
    releaseAll: () => {
      for (const l of latches.values()) l.resolve();
    },
  };
}
async function waitUntil(cond: () => boolean, ms = 3000) {
  for (let i = 0; i < ms / 5; i++) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error("waitUntil timed out");
}

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

async function start(
  conversation: Conversation,
  ...args: Parameters<Conversation["create"]>
) {
  const task = await conversation.create(...args);
  return conversation.start(task.id, task.currentRun, args[4]);
}
test("create is durable and offline; start loads the saved run and never sends it twice", async () => {
  const { state, browser, conversation } = setup();
  const prepared = await conversation.create("queued", "Saved prompt");
  expect(prepared.runs[0].state).toBe("prepared");
  expect(browser.nextTarget).toBe(0);
  expect(browser.sends).toBe(0);
  const resumed = new Conversation(
    new State(home),
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
  );
  const sent = await resumed.start(prepared.id, prepared.currentRun);
  expect(sent.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
  expect([...browser.pages.values()][0].messages[0].text).toContain(
    "Saved prompt",
  );
  await resumed.start(prepared.id, prepared.currentRun);
  expect(browser.sends).toBe(1);
  await expect(resumed.start(prepared.id, "stale")).rejects.toThrow(
    "STALE_RUN",
  );
  const repeated = await resumed.create("queued", "Saved prompt");
  expect(repeated.currentRun).toBe(prepared.currentRun);
  await expect(resumed.create("queued", "Changed prompt")).rejects.toThrow(
    "REQUEST_CONFLICT",
  );
  expect(state.read<any>("task-queued").currentRun).toBe(prepared.currentRun);
});

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

test("followup creation does not contact the browser; execution checks prior reply drift", async () => {
  const { browser, conversation } = setup();
  const prepared = await conversation.create("offline-followup", "First");
  await conversation.start(prepared.id, prepared.currentRun);
  browser.complete();
  await conversation.poll(prepared.id, prepared.currentRun);
  browser.gate = async () => {
    throw new Error("OFFLINE");
  };
  const next = await conversation.create(
    prepared.id,
    "Second",
    "followup-key",
    true,
  );
  expect(next.runs).toHaveLength(2);
  expect(browser.sends).toBe(1);
  browser.gate = undefined;
  [...browser.pages.values()][0].messages.at(-1).text = "Changed reply";
  const failed = await conversation.start(next.id, next.currentRun);
  expect(failed.runs.at(-1)?.state).toBe("prepared");
  expect(failed.runs.at(-1)?.error).toBeTruthy();
  expect(browser.sends).toBe(1);
});

test("replaying an older create request cannot select a queued successor", async () => {
  const { browser, conversation } = setup();
  const first = await conversation.create("old-key", "First");
  await conversation.start(first.id, first.currentRun);
  browser.complete();
  await conversation.poll(first.id, first.currentRun);
  const next = await conversation.create(first.id, "Second", "second", true);
  await expect(conversation.create(first.id, "First")).rejects.toThrow(
    "REQUEST_RUN_SUPERSEDED",
  );
  expect(conversation.get(first.id).currentRun).toBe(next.currentRun);
  expect(browser.sends).toBe(1);
});

test("a database rejection at the submission boundary prevents the browser click", async () => {
  const { browser, conversation } = setup();
  const task = await conversation.create(
    "durability-failure",
    "Do not send before commit",
  );
  const db = new Database(join(home, "tasks.db"));
  db.exec(`create trigger reject_submission before update on task_document
    when json_extract(new.document, '$.runs[0].state') = 'submitting'
    begin select raise(abort, 'test disk failure'); end`);
  db.close();
  const result = await conversation.start(task.id, task.currentRun);
  expect(result.runs[0].error).toContain("test disk failure");
  expect(browser.sends).toBe(0);
  await conversation.start(task.id, task.currentRun);
  expect(browser.sends).toBe(0);
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
