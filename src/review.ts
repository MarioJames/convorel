import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { State } from "./state.ts";
import { Browser } from "./browser.ts";
import { Workspace, sha } from "./workspace.ts";
import {
  classify,
  conversationId,
  type Message,
  type PageState,
} from "./chatgpt/page.ts";
import { ensureModel, MODEL_SCRIPT } from "./chatgpt/model.ts";
import { organizeConversation } from "./chatgpt/organize.ts";
export interface Config {
  version: 1;
  workspace: string;
  cdp: string;
  model: string;
  projectUrl?: string;
  projectName?: string;
  timezone?: string;
  language?: "en" | "zh";
}
interface Run {
  id: string;
  requestId: string;
  inputHash: string;
  prompt: string;
  promptHash: string;
  marker: string;
  state: string;
  userMessageId?: string;
  reply?: Message;
  replyHash?: string;
  branch?: string[];
  error?: string;
  createdAt: string;
  observedModel?: string;
}
interface Binding {
  target: string;
  epoch: string;
  owned: boolean;
  closed?: boolean;
  opening?: boolean;
}
export interface Task {
  version: 1;
  id: string;
  config: Config;
  workspaceId: string;
  url?: string;
  binding?: Binding;
  opening?: boolean;
  currentRun: string;
  attemptId: string;
  runs: Run[];
  organization?: any;
  cleanup?: any;
}
const same = (a: string, b: string) => {
  try {
    return conversationId(a) === conversationId(b);
  } catch {
    return false;
  }
};
const template = () =>
  readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
export class Review {
  constructor(
    public store: State,
    public browser: Browser,
    private verify = async (b: any, opts: Record<string, string>) => {
      if (opts.model === "6 Pro") return ensureModel(b, opts);
      const p = (await b.run("eval", MODEL_SCRIPT)).result;
      if (
        p.url !== opts.url ||
        p.blocked ||
        p.generating ||
        !p.hasComposer ||
        p.control?.disabled ||
        p.control?.label !== opts.model
      )
        throw new Error(
          "MODEL_UNVERIFIED: select the configured model in this tab",
        );
      return { observedModel: p.control.label };
    },
  ) {}
  get(id: string): Task {
    return this.store.read<Task>("task-" + id);
  }
  private save(t: Task) {
    this.store.write("task-" + t.id, t);
  }
  private claim(t: Task) {
    for (const other of this.store.tasks() as Task[]) {
      if (other.id === t.id) continue;
      if (t.url && other.url && same(t.url, other.url))
        throw new Error("CONVERSATION_CONFLICT");
      if (
        t.binding &&
        !t.binding.closed &&
        other.binding &&
        !other.binding.closed &&
        t.binding.epoch === other.binding.epoch &&
        t.binding.target === other.binding.target
      )
        throw new Error("TARGET_CONFLICT");
    }
  }
  private current(t: Task, run?: string) {
    if (run && run !== t.currentRun) throw new Error("STALE_RUN");
    const r = t.runs.find((r) => r.id === t.currentRun);
    if (!r) throw new Error("RUN_MISSING");
    return r;
  }
  private guard(t: Task) {
    const now = this.get(t.id);
    if (now.currentRun !== t.currentRun || now.attemptId !== t.attemptId)
      throw new Error("STALE_ATTEMPT");
    this.claim(t);
  }
  private begin(t: Task) {
    t.attemptId = randomUUID();
    this.save(t);
  }
  private async open(t: Task) {
    const epoch = await this.browser.epoch();
    this.guard(t);
    const { tabs } = await this.browser.tabs("list");
    this.guard(t);
    const previous =
      t.binding && !t.binding.closed && t.binding.epoch === epoch
        ? tabs.find((x: any) => x.targetId === t.binding!.target)
        : undefined;
    if (previous) {
      if (t.url && !same(previous.url, t.url))
        throw new Error("TARGET_NAVIGATED");
      return previous.targetId;
    }
    if (!t.url && (t.opening || t.binding))
      throw new Error(
        "OPEN_UNKNOWN: inspect the created page; no automatic replacement",
      );
    const existing = t.url ? tabs.filter((x: any) => same(x.url, t.url!)) : [];
    if (existing.length > 1) throw new Error("AMBIGUOUS_CONVERSATION_TABS");
    if (existing.length) {
      t.binding = { target: existing[0].targetId, epoch, owned: false };
      this.claim(t);
      this.save(t);
      return t.binding.target;
    }
    if (t.opening)
      throw new Error("OPEN_UNKNOWN: no automatic second creation attempt");
    t.opening = true;
    this.save(t);
    this.guard(t);
    const created = await this.browser.tabs(
      "new",
      t.url || t.config.projectUrl || "https://chatgpt.com/",
    );
    this.guard(t);
    if (!created.targetId) throw new Error("OPEN_UNKNOWN");
    t.binding = { target: created.targetId, epoch, owned: true };
    t.opening = false;
    this.claim(t);
    this.save(t);
    return created.targetId;
  }
  private async page(t: Task) {
    const target = await this.open(t);
    this.guard(t);
    return this.browser.page(target);
  }
  private async observe(t: Task, b: any) {
    const p: PageState = await b.read();
    this.guard(t);
    const pageUrl = new URL(p.url);
    if (
      pageUrl.origin !== "https://chatgpt.com" &&
      !(p.url === "about:blank" && !p.hasComposer)
    )
      throw new Error("PAGE_ORIGIN_CHANGED");
    if (t.url && !same(p.url, t.url)) throw new Error("CONVERSATION_CHANGED");
    if (p.blocked) throw new Error("NEEDS_ATTENTION: " + p.blocked);
    return p;
  }
  private async reconcile(t: Task, b: any) {
    const r = this.current(t),
      p = await this.observe(t, b);
    if (!r.userMessageId) {
      const found = p.messages.filter(
        (m) => m.role === "user" && m.text.includes(r.marker),
      );
      if (found.length !== 1 || !found[0].id) {
        r.state = "delivery_unknown";
        r.error = "No unique submitted user message matches the marker";
        this.save(t);
        return t;
      }
      r.userMessageId = found[0].id;
      t.url = p.url;
      conversationId(t.url);
      this.claim(t);
    }
    const outcome = classify(p, t.url!, r.userMessageId);
    r.state = outcome.state;
    r.error = outcome.reason;
    if (outcome.state === "complete") {
      r.reply = outcome.reply;
      r.replyHash = sha(outcome.reply!.text);
      r.branch = p.messages
        .slice(p.messages.findIndex((m) => m.id === r.userMessageId))
        .map((m) => m.id);
    }
    this.save(t);
    return t;
  }
  async start(
    id: string,
    input: string,
    requestId = "initial",
    followup = false,
  ) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ||
      !requestId ||
      requestId.length > 120 ||
      !input.trim() ||
      Buffer.byteLength(input) > 100000
    )
      throw new Error("INVALID_REQUEST");
    return this.store.locked(async () => {
      let t: Task;
      const inputHash = sha(input);
      if (this.store.has("task-" + id)) {
        t = this.get(id);
        const previous = t.runs.find((r) => r.requestId === requestId);
        if (previous) {
          if (previous.inputHash !== inputHash)
            throw new Error("REQUEST_CONFLICT");
          return t;
        }
        if (!followup)
          throw new Error("TASK_EXISTS: use followup with a new request-id");
        if (this.current(t).state !== "complete")
          throw new Error("PRIOR_RUN_NOT_COMPLETE");
      } else {
        if (followup) throw new Error("TASK_NOT_FOUND");
        const config = this.store.read<Config>("config");
        t = {
          version: 1,
          id,
          config,
          workspaceId: new Workspace(config.workspace).id,
          currentRun: "",
          attemptId: "",
          runs: [],
        };
      }
      for (const other of this.store.tasks() as Task[]) {
        if (
          other.id !== id &&
          other.runs.some((r) => r.requestId === requestId) &&
          requestId !== "initial"
        )
          throw new Error("REQUEST_ALREADY_BOUND_TO_ANOTHER_TASK");
      }
      // Check the previous completed turn before assigning a successor.
      this.begin(t);
      if (t.currentRun) {
        const b = await this.page(t),
          p = await this.observe(t, b);
        this.safeCompleted(t, p);
      }
      const runId = randomUUID(),
        marker = `[CONVOREL:${runId}]`;
      const prompt = `${marker}\nDefault review path: ${t.config.workspace}\nDefault workspaceId: ${t.workspaceId}\nTemplate: v0.1\n\n${template()}\n\nUser request:\n${input}`;
      t.currentRun = runId;
      t.runs.push({
        id: runId,
        requestId,
        inputHash,
        prompt,
        promptHash: sha(prompt),
        marker,
        state: "prepared",
        createdAt: new Date().toISOString(),
      });
      this.save(t);
      const r = this.current(t);
      try {
        const b = await this.page(t);
        let p = await this.observe(t, b);
        // A new page may still be loading. No side effects during this bounded readiness wait.
        for (let n = 0; !p.hasComposer && !p.blocked && n < 20; n++) {
          await Bun.sleep(250);
          p = await this.observe(t, b);
        }
        if (p.generating || !p.hasComposer || p.draft?.trim() || p.attachments)
          throw new Error("PAGE_NOT_IDLE");
        const observed = await this.verify(b, {
          url: p.url,
          target: t.binding!.target,
          model: t.config.model,
        });
        this.guard(t);
        r.observedModel = observed.observedModel;
        p = await this.observe(t, b);
        if (p.generating || p.draft?.trim() || p.attachments)
          throw new Error("PAGE_NOT_IDLE");
        await b.run("fill", "#prompt-textarea", prompt);
        this.guard(t);
        p = await this.observe(t, b);
        if (p.draft?.trim() !== prompt.trim() || p.generating || p.attachments)
          throw new Error("DRAFT_CHANGED");
        // Durable write precedes the first action capable of submitting a message.
        r.state = "submitting";
        this.save(t);
        this.guard(t);
        await b.run(
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Send prompt",
          "--exact",
        );
        this.guard(t);
        for (let n = 0; n < 12; n++) {
          await this.reconcile(t, b);
          if (r.userMessageId) return t;
          await Bun.sleep(250);
        }
        return t;
      } catch (e) {
        r.state =
          r.state === "submitting" || r.state === "delivery_unknown"
            ? "delivery_unknown"
            : "needs_attention";
        r.error = String(e);
        this.guard(t);
        this.save(t);
        return t;
      }
    });
  }
  async poll(id: string, run?: string) {
    return this.store.locked(async () => {
      const t = this.get(id);
      if (this.current(t, run).state === "complete") return t;
      this.begin(t);
      return this.reconcile(t, await this.page(t));
    });
  }
  resume(id: string, run?: string) {
    return this.poll(id, run);
  }
  result(id: string, run?: string) {
    const t = this.get(id),
      r = this.current(t, run);
    if (r.state !== "complete" || !r.reply || r.replyHash !== sha(r.reply.text))
      throw new Error("RESULT_NOT_COMPLETE");
    return {
      taskId: id,
      runId: r.id,
      url: t.url,
      reply: r.reply,
      replyHash: r.replyHash,
      userMessageId: r.userMessageId,
      branch: r.branch,
    };
  }
  private safeCompleted(t: Task, p: PageState) {
    const r = this.current(t);
    if (r.state !== "complete" || !r.reply || !t.url || !r.userMessageId)
      throw new Error("RESULT_NOT_COMPLETE");
    if (
      !p.hasComposer ||
      p.draft?.trim() ||
      p.attachments ||
      p.generating ||
      p.blocked
    )
      throw new Error("PAGE_NOT_IDLE");
    const out = classify(p, t.url, r.userMessageId),
      branch = p.messages
        .slice(p.messages.findIndex((m) => m.id === r.userMessageId))
        .map((m) => m.id);
    if (
      out.state !== "complete" ||
      out.reply?.id !== r.reply.id ||
      sha(out.reply.text) !== r.replyHash ||
      JSON.stringify(branch) !== JSON.stringify(r.branch)
    )
      throw new Error("COMPLETED_TURN_CHANGED");
  }
  async finish(id: string, run?: string) {
    return this.store.locked(async () => {
      const t = this.get(id);
      this.current(t, run);
      this.result(id, run);
      this.begin(t);
      if (!t.binding?.owned || t.binding.closed) {
        t.cleanup = {
          closed: !!t.binding?.closed,
          reason: "Borrowed, untracked or already closed",
        };
        this.save(t);
        return t.cleanup;
      }
      if (t.binding.epoch !== (await this.browser.epoch()))
        throw new Error("BROWSER_RESTARTED: ownership expired");
      this.guard(t);
      let { tabs } = await this.browser.tabs("list");
      this.guard(t);
      if (!tabs.some((x: any) => x.targetId === t.binding!.target)) {
        t.binding.closed = true;
        t.cleanup = { closed: true, alreadyGone: true };
        this.save(t);
        return t.cleanup;
      }
      const b = await this.browser.page(t.binding.target);
      this.safeCompleted(t, await this.observe(t, b));
      if (tabs.length === 1) {
        this.store.write("keepalive", {
          version: 1,
          opening: true,
          epoch: t.binding.epoch,
        });
        const k = await this.browser.tabs("new", "about:blank");
        this.guard(t);
        this.store.write("keepalive", {
          version: 1,
          target: k.targetId,
          epoch: t.binding.epoch,
        });
      }
      this.safeCompleted(t, await this.observe(t, b));
      this.guard(t);
      await this.browser.tabs("close", t.binding.target);
      this.guard(t);
      tabs = (await this.browser.tabs("list")).tabs;
      if (tabs.some((x: any) => x.targetId === t.binding!.target))
        throw new Error("CLOSE_UNVERIFIED");
      t.binding.closed = true;
      t.cleanup = {
        closed: true,
        target: t.binding.target,
        organizationPending: !!t.organization?.error,
      };
      this.save(t);
      return t.cleanup;
    });
  }
  async attach(id: string, url: string, userMessageId: string) {
    return this.store.locked(async () => {
      conversationId(url);
      if (this.store.has("task-" + id)) throw new Error("TASK_EXISTS");
      const config = this.store.read<Config>("config"),
        run = randomUUID();
      const t: Task = {
        version: 1,
        id,
        url,
        config,
        workspaceId: new Workspace(config.workspace).id,
        currentRun: run,
        attemptId: randomUUID(),
        runs: [
          {
            id: run,
            requestId: "import",
            prompt: "",
            promptHash: sha(""),
            inputHash: sha(""),
            marker: "",
            state: "waiting",
            userMessageId,
            createdAt: new Date().toISOString(),
          },
        ],
      };
      this.claim(t);
      this.save(t);
      return this.reconcile(t, await this.page(t));
    });
  }
  async organize(id: string, run: string, type: string, topic: string) {
    return this.store.locked(async () => {
      const t = this.get(id);
      this.current(t, run);
      this.result(id, run);
      this.begin(t);
      if (!t.config.projectUrl || !t.config.projectName)
        throw new Error("PROJECT_NOT_CONFIGURED");
      try {
        const b = await this.page(t);
        this.safeCompleted(t, await this.observe(t, b));
        const guarded = {
          session: b.session,
          read: () => this.observe(t, b),
          run: async (...args: string[]) => {
            this.guard(t);
            if (!["eval", "network"].includes(args[0]))
              this.safeCompleted(t, await this.observe(t, b));
            return b.run(...args);
          },
        };
        t.organization = await organizeConversation(
          guarded,
          t.url!,
          {
            projectUrl: t.config.projectUrl,
            projectName: t.config.projectName,
            timezone: t.config.timezone || "UTC",
            language: t.config.language || "en",
          },
          type,
          topic,
        );
      } catch (e) {
        t.organization = { error: String(e) };
      }
      this.guard(t);
      this.save(t);
      return t.organization;
    });
  }
}
