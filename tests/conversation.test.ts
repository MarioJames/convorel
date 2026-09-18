import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
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
  async epoch() {
    return this.epochValue;
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
  async page(target: string) {
    if (!this.pages.has(target)) throw new Error("tab_gone");
    const self = this,
      p = this.pages.get(target);
    return {
      session: "fake",
      read: async () => structuredClone(p),
      run: async (...args: string[]) => {
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
          if (!self.delayedUrl)
            p.url = "https://chatgpt.com/c/test-conversation";
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
  const t = await conversation.start("generation-failed", "Review");
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
  const t = await conversation.start("confirmed-send", "Review");
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
  const t = await conversation.start("model-drift", "Conversation");
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
  const t = await conversation.start("obstructed", "Conversation");
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
  const first = await conversation.start("url-pending", "Conversation");
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
  const first = await conversation.start("legacy-pending", "Conversation");
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
  const first = await conversation.start("wrong-pending", "Conversation");
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
test("new tasks resolve environment preferences while followups retain their original snapshot", async () => {
  const { state, browser, conversation } = setup();
  const keys = [
    "CONVOREL_MODEL",
    "CONVOREL_PROJECT_URL",
    "CONVOREL_PROJECT_NAME",
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.CONVOREL_MODEL = "7 Pro";
    process.env.CONVOREL_PROJECT_URL = "";
    process.env.CONVOREL_PROJECT_NAME = "";
    const first = await conversation.start("preferences", "First");
    expect(first.config.model).toBe("7 Pro");
    expect(first.config.projectUrl).toBeUndefined();
    browser.complete();
    await conversation.poll(first.id, first.currentRun);
    process.env.CONVOREL_MODEL = "";
    const next = await conversation.start(first.id, "Followup", "second", true);
    expect(next.config.model).toBe("7 Pro");
    browser.delayedUrl = true;
    const other = await conversation.start("default-preferences", "Other");
    expect(other.config.model).toBeUndefined();
    expect(state.read<any>("config").model).toBe("6 Pro");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
test("duplicate start never resends, exact reply persists, finish closes owned page and a new service instance retains its result", async () => {
  const { state, browser, conversation } = setup();
  const first = await conversation.start("design", "Conversation");
  await conversation.start("design", "Conversation");
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
  const first = await conversation.start("uncertain", "Conversation");
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
  const t = await conversation.start("read-interrupted", "Review");
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
  const t = await conversation.start("before-send-read", "Review");
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
    nextAction: "retry",
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
  const first = await conversation.start("draft", "Conversation");
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
  const first = await conversation.start("pending", "Conversation");
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
  const t = await conversation.start("protected", "Conversation");
  await expect(conversation.start("protected", "Different")).rejects.toThrow(
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
  const t = await conversation.start(
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
  const first = await conversation.start("question", input);
  const expected = `[CONVOREL:${first.currentRun}]\n\n${input}`;
  expect(first.runs[0].prompt).toBe(expected);
  expect([...browser.pages.values()][0].messages[0].text).toBe(expected);
  browser.complete();
  await conversation.poll("question", first.currentRun);
  const nextInput = "补充问题：为什么？\n";
  const next = await conversation.start(
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
  const first = await conversation.start("continued", "Initial question");
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
  const restored = new Conversation(
    new State(home),
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
  );
  const next = await restored.start("continued", "Follow-up", "second", true);
  expect(next.url).toBe(first.url);
  expect(next.runs).toHaveLength(2);
  expect(next.runs[0].reply?.text).toBe("Answer");
  expect(next.runs[1].state).toBe("waiting");
  expect(browser.sends).toBe(2);
});
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
  const first = await conversation.start("spaces", "Code:\n  const n = 1;");
  expect(first.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
  // Independent task must still stop on an actual text mutation.
  changeWords = true;
  const second = await conversation.start(
    "changed-words",
    "Code:\n  const n = 2;",
  );
  expect(second.runs[0].state).toBe("prepared");
  expect(second.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(1);
});

test("restoring a saved conversation refuses a different conversation without sending", async () => {
  const { browser, conversation } = setup();
  const first = await conversation.start("restore-drift", "Initial question");
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
  await expect(
    conversation.start("restore-drift", "Next question", "next", true),
  ).rejects.toThrow("CONVERSATION_CHANGED");
  expect(browser.sends).toBe(1);
  expect(conversation.get("restore-drift").runs).toHaveLength(1);
});

test("first durable task write already contains a recoverable run", async () => {
  const { state, browser, conversation } = setup();
  const write = state.write.bind(state);
  state.write = (key, value) => {
    write(key, value);
    if (key === "task-first-write")
      throw new Error("simulated interruption after durable write");
  };
  await expect(conversation.start("first-write", "Question")).rejects.toThrow(
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
  const first = await conversation.start("recover-send", "Question");
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
  const first = await conversation.start("retry-draft", "Recorded question");
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
  const t = await conversation.start("restored", "Recorded question");
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
  const t = await conversation.start("recovery-guards", "Question");
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
  const t = await conversation.start("unverified-clear", "Question");
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
    const t = await conversation.start("unknown-recovery", "Question");
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
  const t = await conversation.start(
    "workspace-binding",
    "Question",
    "initial",
    false,
    other,
  );
  expect(t.config.workspace).toBe(other);
  expect(conversationStatus(t).workspace).toBe(other);
  await expect(
    conversation.start(t.id, "Question", "initial", false, ws),
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
  const t = await conversation.start("correct-workspace", "Question");
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
