import { randomUUID } from "node:crypto";
import { State } from "./state.ts";
import { Browser } from "./browser.ts";
import { Workspace, sha } from "./workspace.ts";
import {
  classify,
  conversationId,
  type Message,
  type PageState,
} from "./chatgpt/page.ts";
import { ensureModel } from "./chatgpt/model.ts";
import { organizeConversation } from "./chatgpt/organize.ts";
import { conversationConfig, type Config } from "./config.ts";
export type { Config } from "./config.ts";
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
export class Conversation {
  constructor(
    public store: State,
    public browser: Browser,
    private verify: (
      b: any,
      opts: Record<string, string>,
    ) => Promise<{ observedModel: string }> = ensureModel,
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
      return { target: previous.targetId, created: false };
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
      return { target: t.binding.target, created: false };
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
    return { target: created.targetId, created: true };
  }
  private async page(t: Task) {
    const { target, created } = await this.open(t);
    this.guard(t);
    const b = await this.browser.page(target);
    // A newly opened saved URL can initially expose about:blank or partial history.
    // Wait only on that new target; changed URLs and blocked pages still fail closed.
    if (created && t.url) {
      const current = this.current(t);
      const anchor = current.userMessageId ? current : t.runs.at(-2);
      const userId = anchor?.userMessageId;
      const replyId = anchor?.reply?.id;
      for (let n = 0; n < 20; n++) {
        const p: PageState = await b.read();
        this.guard(t);
        const blank =
          p.url === "about:blank" && !p.hasComposer && !p.messages.length;
        const loading =
          same(p.url, t.url) &&
          (!p.hasComposer ||
            (userId && !p.messages.some((m) => m.id === userId)) ||
            (replyId && !p.messages.some((m) => m.id === replyId)));
        if (p.blocked || (!blank && !loading)) break;
        await Bun.sleep(250);
      }
    }
    return b;
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
    if (!r.userMessageId || !t.url) {
      const found = p.messages.filter(
        (m) => m.role === "user" && m.text.includes(r.marker),
      );
      if (!found.length && r.state === "prepared") return t;
      if (found.length !== 1 || !found[0].id) {
        r.state = "delivery_unknown";
        r.error = "No unique submitted user message matches the marker";
        this.save(t);
        return t;
      }
      if (r.userMessageId && r.userMessageId !== found[0].id)
        throw new Error("SUBMITTED_MESSAGE_CHANGED");
      r.userMessageId = found[0].id;
      try {
        conversationId(p.url);
      } catch {
        if (p.url !== (t.config.projectUrl || "https://chatgpt.com/"))
          throw new Error("CONVERSATION_CHANGED");
        r.state = "waiting";
        r.error =
          "Awaiting persisted conversation URL for the submitted message";
        this.save(t);
        return t;
      }
      t.url = p.url;
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
        const config = conversationConfig(this.store.read<Config>("config"));
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
      if (t.currentRun) {
        this.begin(t);
        const b = await this.page(t),
          p = await this.observe(t, b);
        this.safeCompleted(t, p);
      }
      t.attemptId = randomUUID();
      const runId = randomUUID(),
        marker = `[CONVOREL:${runId}]`;
      const prompt = `${marker}\n\n${input}`;
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
      return this.submitPrepared(t);
    });
  }
  async retry(id: string, run: string) {
    return this.store.locked(async () => {
      const t = this.get(id);
      if (this.current(t, run).state !== "prepared")
        throw new Error("RUN_NOT_PREPARED");
      this.begin(t);
      return this.submitPrepared(t);
    });
  }
  private async submitPrepared(t: Task) {
    const r = this.current(t),
      prompt = r.prompt;
    const draftText = (text: string) => text.replace(/\u00a0/g, " ").trim();
    try {
      const b = await this.page(t);
      let p = await this.observe(t, b);
      // A new page may still be loading. No side effects during this bounded readiness wait.
      for (let n = 0; !p.hasComposer && !p.blocked && n < 20; n++) {
        await Bun.sleep(250);
        p = await this.observe(t, b);
      }
      if (
        p.messages.some((m) => m.role === "user" && m.text.includes(r.marker))
      )
        return this.reconcile(t, b);
      const checkDraft = (page: PageState) => {
        if (page.generating || !page.hasComposer || page.attachments)
          throw new Error("PAGE_NOT_IDLE");
        if (page.draft?.trim() && draftText(page.draft) !== draftText(prompt))
          throw new Error("DRAFT_CHANGED");
        const previous = t.runs.at(-2);
        if (previous) this.safeCompleted(t, { ...page, draft: "" }, previous);
        else if (page.messages.length)
          throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
      };
      checkDraft(p);
      const observed = await this.verify(b, {
        url: p.url,
        target: t.binding!.target,
        model: t.config.model || "",
      });
      this.guard(t);
      r.observedModel = observed.observedModel;
      p = await this.observe(t, b);
      checkDraft(p);
      if (!p.draft?.trim()) await b.run("fill", "#prompt-textarea", prompt);
      this.guard(t);
      p = await this.observe(t, b);
      // Model popovers can leave a closing overlay after their label has updated.
      // Wait for a genuinely enabled, unobstructed Send button before crossing the send boundary.
      for (let n = 0; p.sendReady === false && n < 20; n++) {
        checkDraft(p);
        await Bun.sleep(100);
        p = await this.observe(t, b);
      }
      if (p.sendReady === false) throw new Error("SEND_CONTROL_UNAVAILABLE");
      // Chromium contenteditable may render ordinary indentation as NBSP.
      // Normalize only this presentation difference, retaining exact persisted input.
      if (
        draftText(p.draft || "") !== draftText(prompt) ||
        p.generating ||
        p.attachments
      )
        throw new Error("DRAFT_CHANGED");
      checkDraft(p);
      const finalModel = await this.verify(b, {
        url: p.url,
        target: t.binding!.target,
        model: r.observedModel!,
        "verify-only": "true",
      });
      if (finalModel.observedModel !== r.observedModel)
        throw new Error("MODEL_CHANGED_BEFORE_SEND");
      p = await this.observe(t, b);
      checkDraft(p);
      if (draftText(p.draft || "") !== draftText(prompt))
        throw new Error("DRAFT_CHANGED");
      if (p.sendReady === false) throw new Error("SEND_CONTROL_UNAVAILABLE");
      r.error = undefined;
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
          : "prepared";
      r.error = String(e);
      this.guard(t);
      this.save(t);
      return t;
    }
  }
  async poll(id: string, run?: string) {
    return this.store.locked(async () => {
      const t = this.get(id);
      if (this.current(t, run).state === "complete") return t;
      this.begin(t);
      // Recover a previously saved initial URL without guessing another tab or resending.
      if (t.url === (t.config.projectUrl || "https://chatgpt.com/")) {
        const r = this.current(t);
        if (
          t.runs.length !== 1 ||
          !r.marker ||
          !r.userMessageId ||
          !["delivery_unknown", "waiting", "submitting"].includes(r.state) ||
          !t.binding ||
          t.binding.closed ||
          t.binding.epoch !== (await this.browser.epoch())
        )
          throw new Error("PENDING_URL_UNVERIFIED");
        this.guard(t);
        const b = await this.browser.page(t.binding.target);
        const p: PageState = await b.read();
        this.guard(t);
        const matches = p.messages.filter(
          (m) => m.role === "user" && m.text.includes(r.marker),
        );
        if (
          p.blocked ||
          matches.length !== 1 ||
          matches[0].id !== r.userMessageId
        )
          throw new Error("PENDING_URL_UNVERIFIED");
        conversationId(p.url);
        t.url = p.url;
        this.claim(t);
        this.save(t);
        return this.reconcile(t, b);
      }
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
  private safeCompleted(t: Task, p: PageState, r = this.current(t)) {
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
      const config = conversationConfig(this.store.read<Config>("config")),
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
  async organize(
    id: string,
    run: string,
    type: string,
    topic: string,
    language = "en",
  ) {
    if (language !== "en" && language !== "zh")
      throw new Error("Title language must be en or zh");
    return this.store.locked(async () => {
      const t = this.get(id);
      this.current(t, run);
      this.result(id, run);
      this.begin(t);
      t.organization = { verified: false };
      this.save(t);
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
            const result = await b.run(...args);
            if (args[0] === "reload") {
              // Metadata responses can arrive before the same saved answer finishes rendering.
              for (let n = 0; ; n++) {
                const page = await this.observe(t, b);
                if (page.draft?.trim() || page.generating || page.attachments)
                  throw new Error("PAGE_NOT_IDLE");
                try {
                  this.safeCompleted(t, page);
                  break;
                } catch (e) {
                  if (n >= 20) throw e;
                  await Bun.sleep(250);
                }
              }
            }
            return result;
          },
        };
        t.organization = await organizeConversation(
          guarded,
          t.url!,
          {
            projectUrl: t.config.projectUrl,
            projectName: t.config.projectName,
            timezone: "Asia/Shanghai",
            language,
          },
          type,
          topic,
          (progress) => {
            this.guard(t);
            t.organization = { ...structuredClone(progress), verified: false };
            this.save(t);
          },
        );
      } catch (e) {
        t.organization = {
          ...t.organization,
          verified: false,
          error: String(e),
        };
      }
      this.guard(t);
      this.save(t);
      return t.organization;
    });
  }
}
