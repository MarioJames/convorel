import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../../src/storage/state.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { preference, writePreference } from "../../src/config/preferences.ts";

export class FakeBrowser {
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

/** Tests may not rely on a leftover global preference from another case. */
const SHARED_PREFERENCES = [
  "model",
  "project.url",
  "project.name",
  "browser.serial",
  "locks.taskWaitMs",
] as const;

/** Installs this file's temp-dir and preference lifecycle. Each behavior test
 * file calls it once at the top level; hooks are per-file, never import-global. */
export function conversationHarness() {
  const dirs = { home: "", ws: "" };
  let savedPreferences: Record<string, string | undefined>;
  beforeEach(() => {
    dirs.home = mkdtempSync(join(tmpdir(), "convorel-flow-"));
    dirs.ws = mkdtempSync(join(tmpdir(), "convorel-root-"));
    savedPreferences = Object.fromEntries(
      SHARED_PREFERENCES.map((key) => [key, preference(key)]),
    );
  });
  afterEach(() => {
    for (const key of SHARED_PREFERENCES) {
      if (preference(key) !== savedPreferences[key])
        writePreference(key, savedPreferences[key] ?? "");
    }
    rmSync(dirs.home, { recursive: true, force: true });
    rmSync(dirs.ws, { recursive: true, force: true });
  });
  function setup() {
    const state = new State(dirs.home);
    state.write("config", {
      version: 1,
      workspace: dirs.ws,
      cdp: "9222",
      model: "6 Pro",
    });
    const browser = new FakeBrowser();
    const conversation = new Conversation(state, browser as any, async () => ({
      observedModel: "6 Pro",
    }));
    return { state, browser, conversation };
  }
  async function start(
    conversation: Conversation,
    ...args: Parameters<Conversation["create"]>
  ) {
    const task = await conversation.create(...args);
    return conversation.start(task.id, task.currentRun, args[4]);
  }
  /** A completed first run whose conversation page was closed, plus a second
   * unrelated task that currently claims the only tab matching that URL. */
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
  /** A followup whose send was rejected by Cloudflare (blocked delivery on a
   * completed prior turn), plus one operator-approved evidence bundle. */
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
  function makeGate() {
    const blockKeys = new Set<string>();
    const reached = new Set<string>();
    const latches = new Map<
      string,
      { p: Promise<void>; resolve: () => void }
    >();
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
  return {
    home: () => dirs.home,
    ws: () => dirs.ws,
    setup,
    start,
    completedWithClaimedTab,
    missingDelivery,
    makeGate,
    waitUntil,
  };
}
