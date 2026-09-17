import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
import { Review } from "../src/review.ts";
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
  failSend = false;
  async epoch() {
    return this.epochValue;
  }
  async tabs(...args: string[]) {
    if (args[0] === "list") return { tabs: this.targets };
    if (args[0] === "new") {
      const targetId = "target" + (this.targets.length + 1);
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
      text: "Reviewed",
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
  const review = new Review(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  return { state, browser, review };
}
test("duplicate start never resends, exact reply persists, finish closes owned page and resume reopens conversation", async () => {
  const { state, browser, review } = setup();
  const first = await review.start("design", "Review");
  await review.start("design", "Review");
  expect(browser.sends).toBe(1);
  browser.complete();
  await review.poll("design", first.currentRun);
  expect(review.result("design", first.currentRun).reply.text).toBe("Reviewed");
  await review.finish("design", first.currentRun);
  expect(browser.targets.filter((t) => t.url.includes("/c/"))).toHaveLength(0);
  const other = new Review(new State(home), browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  expect(other.result("design", first.currentRun).reply.text).toBe("Reviewed");
});
test("uncertain send reconciles existing marker without a second click", async () => {
  const { browser, review } = setup();
  browser.failSend = true;
  const first = await review.start("uncertain", "Review");
  expect(browser.sends).toBe(1);
  await review.resume("uncertain", first.currentRun);
  expect(browser.sends).toBe(1);
  browser.complete();
  await review.poll("uncertain", first.currentRun);
  expect(review.result("uncertain", first.currentRun).reply.text).toBe(
    "Reviewed",
  );
});
test("draft and newer messages protect a completed page from closure", async () => {
  const { browser, review } = setup();
  const first = await review.start("draft", "Review");
  browser.complete();
  await review.poll("draft", first.currentRun);
  const p = [...browser.pages.values()][0];
  p.draft = "unfinished user text";
  await expect(review.finish("draft", first.currentRun)).rejects.toThrow();
  expect(browser.targets).toHaveLength(1);
  p.draft = "";
  p.messages.push({
    id: "u-new",
    role: "user",
    text: "followup",
    final: false,
  });
  await expect(review.finish("draft", first.currentRun)).rejects.toThrow();
  expect(browser.targets).toHaveLength(1);
});
test("a known user turn without composer remains pending, and stale run IDs fail", async () => {
  const { browser, review } = setup();
  const first = await review.start("pending", "Review");
  const p = [...browser.pages.values()][0];
  p.generating = false;
  p.hasComposer = false;
  expect(
    (await review.poll("pending", first.currentRun)).runs.at(-1)!.state,
  ).toBe("waiting");
  await expect(review.poll("pending", "different-run")).rejects.toThrow();
  expect(() => review.result("pending", first.currentRun)).toThrow();
});
test("borrowed conversation cannot be claimed twice or closed, and completed results remain durable", async () => {
  const { browser, review } = setup();
  await browser.tabs("new", "https://chatgpt.com/c/existing");
  const p = [...browser.pages.values()][0];
  p.messages = [
    { id: "u", role: "user", text: "Review", final: false },
    { id: "a", role: "assistant", text: "Evidence", final: true },
  ];
  const t = await review.attach("imported", p.url, "u");
  await expect(review.attach("duplicate", p.url, "u")).rejects.toThrow(
    "CONVERSATION_CONFLICT",
  );
  expect((await review.finish("imported", t.currentRun)).closed).toBe(false);
  expect(browser.targets).toHaveLength(1);
  p.messages = [];
  await review.poll("imported", t.currentRun);
  expect(review.result("imported", t.currentRun).reply.text).toBe("Evidence");
});
test("request changes, browser restart, navigation and attachments cannot overwrite or close resources", async () => {
  const { browser, review } = setup();
  const t = await review.start("protected", "Review");
  await expect(review.start("protected", "Different")).rejects.toThrow(
    "REQUEST_CONFLICT",
  );
  expect(browser.sends).toBe(1);
  browser.complete();
  await review.poll("protected", t.currentRun);
  const p = [...browser.pages.values()][0];
  p.attachments = true;
  await expect(review.finish("protected", t.currentRun)).rejects.toThrow(
    "PAGE_NOT_IDLE",
  );
  p.attachments = false;
  browser.epochValue = "new-browser";
  await expect(review.finish("protected", t.currentRun)).rejects.toThrow(
    "BROWSER_RESTARTED",
  );
  browser.epochValue = "epoch1";
  p.url = "https://chatgpt.com/c/another";
  await expect(review.finish("protected", t.currentRun)).rejects.toThrow(
    "CONVERSATION_CHANGED",
  );
  expect(browser.targets).toHaveLength(1);
});
test("a fresh task never fills or sends into a redirected non-ChatGPT page", async () => {
  const { browser, review } = setup();
  const original = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const value = await original(...args);
    if (args[0] === "new") {
      browser.pages.get(value.targetId!).url = "https://example.invalid/";
    }
    return value;
  };
  const t = await review.start("redirect", "Private review context");
  expect(t.runs.at(-1)!.state).toBe("needs_attention");
  expect(browser.sends).toBe(0);
  expect([...browser.pages.values()][0].draft).toBe("");
});
