import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
import { Conversation } from "../src/conversation.ts";
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
  nextTarget = 0;
  failSend = false;
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
        draft: "",
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
        if (args[0] === "find" && args.includes("click")) {
          self.sends++;
          const text = p.draft;
          p.draft = "";
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
  await conversation.resume("uncertain", first.currentRun);
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("uncertain", first.currentRun);
  expect(conversation.result("uncertain", first.currentRun).reply.text).toBe(
    "Answer",
  );
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
