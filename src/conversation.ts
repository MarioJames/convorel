import { randomUUID } from "node:crypto";
import { State, registryLockName, tabsLockName } from "./state.ts";
import {
  Browser,
  clearDraft,
  ObservationError,
  sendPrompt,
} from "./browser.ts";
import { Workspace, sha } from "./workspace.ts";
import {
  classify,
  PageNotIdleError,
  conversationId,
  type Message,
  type PageState,
} from "./chatgpt/page.ts";
import { ensureModel } from "./chatgpt/model.ts";
import {
  assertNewConversationPage,
  verifyProjectComposer,
} from "./chatgpt/project.ts";
import { conversationTitle, organizeConversation } from "./chatgpt/organize.ts";
import { copyMarkdownScript } from "./chatgpt/copy.ts";
import {
  publishSafely,
  withTaskStateLock,
  type ArchiveNotice,
} from "./post-archive.ts";
import { conversationConfig, type Config } from "./config.ts";
import {
  organizationDue,
  ORGANIZATION_DELAYS,
} from "./organization-recovery.ts";
export type { Config } from "./config.ts";
export interface RejectedSendRecovery {
  expectedUserMessageId: string;
  expectedUrl: string;
  input: string;
  reason: string;
  evidence: unknown;
  rejectedAt: number;
  confirmCloudflareChallenge: boolean;
}
export interface Run {
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
  lastObservedAt?: string;
  observationError?: { at: string; message: string; retryable: boolean };
  submittedAt?: string;
  completionProbe?: {
    fingerprint: string;
    unchangedSince: string;
    lastRefreshedAt?: string;
    refreshes: number;
    failures: number;
    error?: string;
  };
  sendRecoveries?: {
    at: string;
    priorUserMessageId: string;
    priorAttemptId: string;
    attemptId: string;
    reason: string;
    target: string;
    url: string;
    priorError?: string;
    evidence: {
      method: string;
      url: string;
      status: number;
      timestamp: number;
    };
    confirmedCloudflareChallenge: true;
  }[];
  draftRecovery?: {
    draft: string;
    hash: string;
    target: string;
    at: string;
    cleared: boolean;
  };
}
interface Binding {
  target: string;
  epoch: string;
  owned: boolean;
  closed?: boolean;
  opening?: boolean;
}
export interface Naming {
  type: string;
  topic: string;
  language?: "en" | "zh";
}
export interface Task {
  version: 1;
  id: string;
  config: Config;
  workspaceId: string;
  url?: string;
  binding?: Binding;
  opening?: boolean;
  pageRecreations?: number;
  currentRun: string;
  attemptId: string;
  runs: Run[];
  naming?: Naming;
  organization?: any;
  organizationObservation?: {
    epoch: string;
    target?: string;
    opening?: boolean;
    closed?: boolean;
    error?: string;
  };
  cleanup?: any;
  /** Outcome of this operation only; never persisted as source state. */
  archive?: ArchiveNotice;
  workspaceBindingChange?: { from: string; to: string; at: string };
}
const same = (a: string, b: string) => {
  try {
    return conversationId(a) === conversationId(b);
  } catch {
    return false;
  }
};
const REGISTRY_WAIT_MS = 10_000;
const TABS_WAIT_MS = 15_000;
export class Conversation {
  constructor(
    public store: State,
    public browser: Browser,
    private verify: (
      b: any,
      opts: Record<string, string>,
    ) => Promise<{ observedModel: string }> = ensureModel,
    private organizer: typeof organizeConversation = organizeConversation,
  ) {}
  get(id: string): Task {
    return this.store.read<Task>("task-" + id);
  }
  private save(t: Task) {
    const { archive: _archive, ...document } = t;
    this.store.write("task-" + t.id, document);
  }
  /** Serializes one task's browser side effects on its own tab, releasing every
   * session it opened. Different tasks proceed concurrently; config browser.serial=true
   * restores the single global browser lock for environments that cannot. */
  private exclusive<T>(id: string, fn: () => Promise<T>) {
    return withTaskStateLock(this.store, id, fn).finally(() =>
      this.browser.release(),
    );
  }
  /** Cross-task identity publish (conversation URL, tab binding, request key).
   * Held only for the read-all-tasks conflict check plus the atomic write; it
   * never wraps a browser side effect. Lock order is task -> registry. */
  private publish<T>(fn: () => Promise<T>) {
    return this.store.locked(fn, registryLockName(), REGISTRY_WAIT_MS);
  }
  /** The one critical section that spans a browser close: last-tab keepalive
   * protection, so concurrent releases cannot strand zero tabs. */
  private tabRelease<T>(fn: () => Promise<T>) {
    return this.store.locked(fn, tabsLockName(), TABS_WAIT_MS);
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
  /** A non-"initial" request key may be bound to only one run across all tasks. */
  private assertRequestFree(id: string, requestId: string) {
    if (requestId === "initial") return;
    for (const other of this.store.tasks() as Task[])
      if (other.id !== id && other.runs.some((r) => r.requestId === requestId))
        throw new Error("REQUEST_ALREADY_BOUND_TO_ANOTHER_TASK");
  }
  private current(t: Task, run?: string) {
    if (run && run !== t.currentRun) throw new Error("STALE_RUN");
    const r = t.runs.find((r) => r.id === t.currentRun);
    if (!r) throw new Error("RUN_MISSING");
    return r;
  }
  private checkWorkspace(t: Task, expected?: string) {
    if (!expected) return;
    const root = new Workspace(expected).root;
    if (root !== t.config.workspace)
      throw new Error(
        `WORKSPACE_MISMATCH: task=${t.id} bound=${t.config.workspace} expected=${root}; inspect status; do not create a duplicate task`,
      );
  }
  private workspace(path: string) {
    const workspace = new Workspace(path);
    if (
      this.store.root === workspace.root ||
      this.store.root.startsWith(workspace.root + "/")
    )
      throw new Error("STATE_INSIDE_WORKSPACE");
    return workspace;
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
  private async open(t: Task, completedFollowup = false) {
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
    if (
      !t.url &&
      t.binding?.owned &&
      !t.opening &&
      !t.binding.closed &&
      t.binding.epoch === epoch &&
      !tabs.some((x: any) => x.targetId === t.binding!.target) &&
      t.runs.length === 1 &&
      this.current(t).state === "prepared" &&
      !this.current(t).submittedAt &&
      !this.current(t).userMessageId &&
      (t.pageRecreations ?? 0) < 2
    ) {
      t.pageRecreations = (t.pageRecreations ?? 0) + 1;
      t.binding = undefined;
      this.save(t);
    }
    if (!t.url && (t.opening || t.binding))
      throw new Error(
        "OPEN_UNKNOWN: inspect the created page; no automatic replacement",
      );
    // A completed followup may restore its URL on a new target, but must never
    // borrow a target claimed by another task, even if that target navigated here.
    // The caller verifies the saved completed branch before creating a new run.
    const claimed = new Set(
      completedFollowup
        ? (this.store.tasks() as Task[])
            .filter(
              (other) =>
                other.id !== t.id &&
                other.binding &&
                !other.binding.closed &&
                other.binding.epoch === epoch,
            )
            .map((other) => other.binding!.target)
        : [],
    );
    const existing = t.url
      ? tabs.filter((x: any) => same(x.url, t.url!) && !claimed.has(x.targetId))
      : [];
    if (existing.length > 1) throw new Error("AMBIGUOUS_CONVERSATION_TABS");
    if (existing.length) {
      t.binding = { target: existing[0].targetId, epoch, owned: false };
      await this.publish(async () => {
        this.claim(t);
        this.save(t);
      });
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
    await this.publish(async () => {
      this.claim(t);
      this.save(t);
    });
    return { target: created.targetId, created: true };
  }
  private async page(t: Task, completedFollowup = false) {
    const { target, created } = await this.open(t, completedFollowup);
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
        const reply = replyId
          ? p.messages.find((m) => m.id === replyId)
          : undefined;
        const blank =
          p.url === "about:blank" && !p.hasComposer && !p.messages.length;
        const loading =
          same(p.url, t.url) &&
          (!p.hasComposer ||
            (userId && !p.messages.some((m) => m.id === userId)) ||
            (replyId &&
              (!reply?.final ||
                (anchor?.replyHash && sha(reply.text) !== anchor.replyHash))));
        if (
          p.blocked ||
          p.draft?.trim() ||
          p.generating ||
          (!blank && !loading)
        )
          break;
        await Bun.sleep(250);
      }
    }
    return b;
  }
  private async observe(t: Task, b: any) {
    const p: PageState = await b.read();
    this.guard(t);
    const r = this.current(t);
    r.lastObservedAt = new Date().toISOString();
    const pageUrl = new URL(p.url);
    if (
      pageUrl.origin !== "https://chatgpt.com" &&
      !(p.url === "about:blank" && !p.hasComposer)
    )
      throw new Error("PAGE_ORIGIN_CHANGED");
    if (t.url && !same(p.url, t.url)) throw new Error("CONVERSATION_CHANGED");
    if (p.blocked) throw new Error("NEEDS_ATTENTION: " + p.blocked);
    if (r.observationError?.retryable && r.error === r.observationError.message)
      r.error = undefined;
    r.observationError = undefined;
    return p;
  }
  private recordFailure(t: Task, e: unknown, observing = false) {
    this.guard(t);
    const r = this.current(t);
    r.error = String(e);
    r.observationError =
      observing || e instanceof ObservationError
        ? {
            at: new Date().toISOString(),
            message: String(e),
            retryable: e instanceof ObservationError,
          }
        : undefined;
    this.save(t);
  }
  private archiveCompleted(t: Task) {
    t.archive = publishSafely(this.store.root, t.id);
    return t;
  }
  private async refreshStalledReply(t: Task, b: any, page: PageState) {
    const r = this.current(t);
    const fingerprint = (p: PageState) =>
      sha(
        JSON.stringify([
          p.generating,
          p.messages.map((m) => [m.id, m.role, m.text, m.final, m.error]),
        ]),
      );
    const current = fingerprint(page);
    if (!r.completionProbe || r.completionProbe.fingerprint !== current) {
      r.completionProbe = {
        fingerprint: current,
        unchangedSince: new Date().toISOString(),
        refreshes: 0,
        failures: 0,
      };
      return page;
    }
    const probe = r.completionProbe;
    if (
      Date.now() - Date.parse(probe.lastRefreshedAt ?? probe.unchangedSince) <
      120000
    )
      return page;
    if (probe.failures >= 3)
      throw new Error(
        "STALLED_REPLY: three refresh attempts failed; inspect the original conversation",
      );
    // Refresh is never a send. Preserve user input and recheck target/branch just
    // before navigation; unknown delivery is never permission to recreate.
    const before = await this.observe(t, b);
    if (fingerprint(before) !== current) return before;
    if (before.draft?.trim() || before.attachments) {
      probe.error =
        "STALLED_REPLY: refresh deferred to preserve draft or attachments";
      return before;
    }
    probe.lastRefreshedAt = new Date().toISOString();
    probe.refreshes++;
    delete probe.error;
    this.save(t); // Durable budget before navigation, including process interruption.
    try {
      await b.run("reload");
      for (let n = 0; n < 80; n++) {
        const p: PageState = await b.read();
        this.guard(t);
        if (!same(p.url, t.url!)) throw new Error("CONVERSATION_CHANGED");
        if (p.blocked) throw new Error("NEEDS_ATTENTION: " + p.blocked);
        if (
          p.messages.some((m) => m.role === "user" && m.id === r.userMessageId)
        ) {
          probe.failures = 0;
          return p;
        }
        await Bun.sleep(500);
      }
      throw new ObservationError(
        "REFRESH_HISTORY_UNAVAILABLE: delivery remains confirmed; do not resend",
      );
    } catch (e) {
      probe.failures++;
      probe.error = String(e);
      this.save(t);
      throw e;
    }
  }
  private async reconcile(t: Task, b: any) {
    // A completed reply is durable. Recovery may finish pending organization,
    // but must not replace its captured bytes with a fresh DOM observation.
    if (this.current(t).state === "complete") {
      if (t.naming && organizationDue(t))
        await this.applyOrganization(t, b, t.naming);
      return this.archiveCompleted(t);
    }
    const r = this.current(t);
    let p = await this.observe(t, b);
    if (!r.userMessageId || !t.url) {
      const found = p.messages.filter(
        (m) => m.role === "user" && m.text.includes(r.marker),
      );
      if (!found.length && r.state === "prepared") {
        this.save(t);
        return t;
      }
      if (found.length !== 1 || !found[0].id) {
        if (r.userMessageId) throw new Error("SUBMITTED_MESSAGE_MISSING");
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
      // Publish the conversation URL atomically with its cross-task conflict
      // check. On CONVERSATION_CONFLICT the in-memory URL is rolled back so a
      // later failure record cannot persist a URL another task already owns.
      await this.publish(async () => {
        const previousUrl = t.url;
        t.url = p.url;
        try {
          this.claim(t);
          this.save(t);
        } catch (e) {
          t.url = previousUrl;
          throw e;
        }
      });
    }
    if (classify(p, t.url!, r.userMessageId).state === "waiting")
      p = await this.refreshStalledReply(t, b, p);
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
    if (outcome.state === "complete" && !r.reply?.markdown)
      await this.attemptCapture(t, b, r);
    if (
      t.naming &&
      organizationDue(t) &&
      ["waiting", "complete"].includes(r.state)
    )
      await this.applyOrganization(t, b, t.naming);
    return r.state === "complete" ? this.archiveCompleted(t) : t;
  }
  async start(
    id: string,
    input: string,
    requestId = "initial",
    followup = false,
    workspace?: string,
    naming?: Naming,
  ) {
    if (naming) {
      if (followup) throw new Error("NAMING_REQUIRES_START_OR_ORGANIZE");
      conversationTitle("2000-01-01T00:00:00Z", naming.type, naming.topic, {
        timezone: "Asia/Shanghai",
        language: naming.language ?? "en",
      });
      if (naming.language && !["en", "zh"].includes(naming.language))
        throw new Error("Title language must be en or zh");
      naming = {
        type: naming.type,
        topic: naming.topic.trim(),
        language: naming.language ?? "en",
      };
    }
    if (
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ||
      !requestId ||
      requestId.length > 120 ||
      !input.trim() ||
      Buffer.byteLength(input) > 100000
    )
      throw new Error("INVALID_REQUEST");
    return this.exclusive(id, async () => {
      let t: Task;
      const inputHash = sha(input);
      if (this.store.has("task-" + id)) {
        t = this.get(id);
        this.checkWorkspace(t, workspace);
        const previous = t.runs.find((r) => r.requestId === requestId);
        if (previous) {
          if (naming && JSON.stringify(t.naming) !== JSON.stringify(naming))
            throw new Error("NAMING_CONFLICT");
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
        if (workspace) config.workspace = this.workspace(workspace).root;
        t = {
          version: 1,
          id,
          config,
          workspaceId: new Workspace(config.workspace).id,
          naming,
          currentRun: "",
          attemptId: "",
          runs: [],
        };
      }
      this.assertRequestFree(id, requestId);
      // Check the previous completed turn before assigning a successor.
      if (t.currentRun) {
        this.begin(t);
        const b = await this.page(t, true),
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
      // Publish the new run's request key atomically against other tasks.
      await this.publish(async () => {
        this.assertRequestFree(id, requestId);
        this.save(t);
      });
      return this.submitPrepared(t);
    });
  }
  async retry(id: string, run: string, workspace?: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id);
      this.checkWorkspace(t, workspace);
      if (
        this.current(t, run).state !== "prepared" ||
        this.current(t, run).userMessageId
      )
        throw new Error("RUN_NOT_PREPARED");
      this.begin(t);
      return this.submitPrepared(t);
    });
  }
  /** Operator-authorized recovery of a verified Cloudflare-rejected followup.
   * DOM absence alone never grants permission to send again. */
  async recoverSend(
    id: string,
    run: string,
    options: RejectedSendRecovery,
    workspace?: string,
  ) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        r = this.current(t, run);
      this.checkWorkspace(t, workspace);
      if (r.state !== "blocked" || !r.userMessageId || r.reply || r.branch)
        throw new Error("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
      if (
        !options.expectedUserMessageId ||
        r.userMessageId !== options.expectedUserMessageId
      )
        throw new Error("EXPECTED_USER_MESSAGE_MISMATCH");
      if (!t.url || options.expectedUrl !== t.url)
        throw new Error("EXPECTED_URL_MISMATCH");
      conversationId(t.url);
      if (
        sha(options.input) !== r.inputHash ||
        sha(r.prompt) !== r.promptHash ||
        r.marker !== `[CONVOREL:${r.id}]` ||
        r.prompt !== `${r.marker}\n\n${options.input}`
      )
        throw new Error("RECOVERY_PROMPT_MISMATCH");
      const evidence = Array.isArray(options.evidence)
        ? options.evidence.filter(
            (e: any) =>
              e?.method === "POST" &&
              e?.url === "https://chatgpt.com/backend-api/f/conversation",
          )
        : [];
      const rejected = evidence[0];
      if (
        !options.reason?.trim() ||
        options.reason.length > 2000 ||
        options.confirmCloudflareChallenge !== true ||
        evidence.length !== 1 ||
        rejected.status !== 403 ||
        rejected.timestamp !== options.rejectedAt ||
        !Number.isSafeInteger(options.rejectedAt) ||
        !Number.isFinite(Date.parse(r.submittedAt || r.createdAt)) ||
        options.rejectedAt < Date.parse(r.submittedAt || r.createdAt) ||
        options.rejectedAt > Date.now() ||
        r.sendRecoveries?.some(
          (a) => a.evidence.timestamp === options.rejectedAt,
        )
      )
        throw new Error("REJECTED_SEND_EVIDENCE_REQUIRED");
      const binding = t.binding;
      if (!binding?.owned || binding.closed || binding.opening || t.opening)
        throw new Error("RECOVERY_REQUIRES_OWNED_TARGET");
      const checkTarget = async () => {
        if (binding.epoch !== (await this.browser.epoch()))
          throw new Error("BROWSER_RESTARTED");
        this.guard(t);
        const { tabs } = await this.browser.tabs("list");
        this.guard(t);
        if (
          !tabs.some(
            (x: any) => x.targetId === binding.target && x.url === t.url,
          )
        )
          throw new Error("RECOVERY_TARGET_CHANGED");
      };
      const previous = t.runs.at(-2);
      if (!previous || t.runs.at(-1) !== r)
        throw new Error("RECOVERY_REQUIRES_COMPLETED_ANCHOR");
      const checkPage = (p: PageState) => {
        if (
          p.url !== t.url ||
          p.messages.some(
            (m) =>
              m.id === options.expectedUserMessageId ||
              m.text.includes(r.marker),
          )
        )
          throw new Error("RECOVERY_MESSAGE_OR_URL_CHANGED");
        this.safeCompleted(t, { ...p, draft: "" }, previous);
        const users = p.messages.filter(
          (m) => m.role === "user" && m.text.includes(previous.marker),
        );
        // Rendered Markdown is not the submitted source (paragraphs/code fences
        // change innerText). Bind the user by its exact ID and unique run marker;
        // safeCompleted above still verifies the reply hash and entire branch.
        if (
          previous.marker !== `[CONVOREL:${previous.id}]` ||
          !previous.promptHash ||
          sha(previous.prompt) !== previous.promptHash ||
          !previous.prompt.startsWith(`${previous.marker}\n\n`) ||
          users.length !== 1 ||
          users[0].id !== previous.userMessageId ||
          users[0].text.split(previous.marker).length !== 2
        )
          throw new Error("COMPLETED_USER_CHANGED");
      };
      await checkTarget();
      // Never use page(t): recovery must not reopen, rebind or create a target.
      const b = await this.browser.page(binding.target);
      const p: PageState = await b.read();
      this.guard(t);
      checkPage(p);
      if (p.draft === undefined || p.draft.trim())
        throw new Error("RECOVERY_REQUIRES_EMPTY_COMPOSER");
      const priorAttemptId = t.attemptId;
      this.begin(t);
      return this.submitPrepared(t, {
        b,
        checkPage,
        beforeSend: async () => {
          await checkTarget();
          const latest: PageState = await b.read();
          this.guard(t);
          checkPage(latest);
          if (
            !latest.sendReady ||
            latest.draft?.replace(/\u00a0/g, " ").trim() !==
              r.prompt.replace(/\u00a0/g, " ").trim()
          )
            throw new Error("RECOVERY_DRAFT_OR_SEND_CHANGED");
          (r.sendRecoveries ??= []).push({
            at: new Date().toISOString(),
            priorUserMessageId: options.expectedUserMessageId,
            priorAttemptId,
            attemptId: t.attemptId,
            reason: options.reason,
            target: binding.target,
            url: t.url!,
            priorError: r.error,
            evidence: {
              method: rejected.method,
              url: rejected.url,
              status: rejected.status,
              timestamp: rejected.timestamp,
            },
            confirmedCloudflareChallenge: true,
          });
          r.userMessageId = undefined;
          r.observationError = undefined;
        },
      });
    });
  }
  async rebindWorkspace(id: string, run: string, from: string, path: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        r = this.current(t, run);
      if (
        r.state !== "prepared" ||
        r.userMessageId ||
        t.runs.length !== 1 ||
        t.url
      )
        throw new Error("RUN_NOT_PREPARED");
      this.checkWorkspace(t, from);
      const workspace = this.workspace(path);
      t.workspaceBindingChange = {
        from: t.config.workspace,
        to: workspace.root,
        at: new Date().toISOString(),
      };
      t.config.workspace = workspace.root;
      t.workspaceId = workspace.id;
      this.begin(t);
      return t;
    });
  }
  async clearDraft(id: string, run: string, expected: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        r = this.current(t, run);
      if (r.state !== "prepared" || r.userMessageId)
        throw new Error("RUN_NOT_PREPARED");
      if (t.url || t.runs.length !== 1 || !t.binding?.owned || t.binding.closed)
        throw new Error("DRAFT_RECOVERY_REQUIRES_OWNED_NEW_PAGE");
      if (!expected.trim()) throw new Error("EXPECTED_DRAFT_REQUIRED");
      this.begin(t);
      try {
        const b = await this.page(t),
          p = await this.observe(t, b);
        if (
          p.url !== (t.config.projectUrl || "https://chatgpt.com/") ||
          p.messages.length
        )
          throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
        if (p.draft !== expected) throw new Error("DRAFT_CHANGED");
        if (p.blocked || p.generating || p.attachments || !p.hasComposer)
          throw new Error("PAGE_NOT_IDLE");
        r.draftRecovery = {
          draft: expected,
          hash: sha(expected),
          target: t.binding!.target,
          at: new Date().toISOString(),
          cleared: false,
        };
        this.save(t); // Durable backup before the only destructive action.
        this.guard(t);
        await clearDraft(b, p);
        this.guard(t);
        r.draftRecovery.cleared = true;
        r.error = undefined;
        this.save(t);
        return t;
      } catch (e) {
        this.recordFailure(t, e);
        throw e;
      }
    });
  }
  private async submitPrepared(
    t: Task,
    recovery?: {
      b: any;
      checkPage: (p: PageState) => void;
      beforeSend: () => Promise<void>;
    },
  ) {
    const r = this.current(t),
      prompt = r.prompt;
    const draftText = (text: string) => text.replace(/\u00a0/g, " ").trim();
    try {
      const b = recovery?.b ?? (await this.page(t));
      let p = await this.observe(t, b);
      recovery?.checkPage(p);
      if (recovery && (p.draft === undefined || p.draft.trim()))
        throw new Error("RECOVERY_REQUIRES_EMPTY_COMPOSER");
      // A new page may still be loading. No side effects during this bounded readiness wait.
      for (let n = 0; !p.hasComposer && !p.blocked && n < 20; n++) {
        await Bun.sleep(250);
        p = await this.observe(t, b);
      }
      if (
        p.messages.some((m) => m.role === "user" && m.text.includes(r.marker))
      )
        return await this.reconcile(t, b);
      const checkDraft = (page: PageState) => {
        recovery?.checkPage(page);
        if (page.generating || !page.hasComposer || page.attachments)
          throw new Error("PAGE_NOT_IDLE");
        if (page.draft?.trim() && draftText(page.draft) !== draftText(prompt))
          throw new Error("DRAFT_CHANGED");
        const previous = t.runs.at(-2);
        if (previous) this.safeCompleted(t, { ...page, draft: "" }, previous);
        else if (!recovery)
          assertNewConversationPage(page, t.config.projectUrl);
        else if (page.messages.length)
          throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
      };
      checkDraft(p);
      if (!t.url && t.config.projectUrl)
        await verifyProjectComposer(
          b,
          t.config.projectUrl,
          t.config.projectName!,
        );
      // Retries retain this run's verified model (including rejected sends).
      // Otherwise honor the task's explicit preference before inheriting the
      // latest completed observation. New tasks still resolve Latest Pro.
      const model =
        r.observedModel?.trim() ||
        t.config.model?.trim() ||
        t.runs
          .slice(0, t.runs.indexOf(r))
          .findLast(
            (run) => run.state === "complete" && run.observedModel?.trim(),
          )
          ?.observedModel?.trim() ||
        "";
      const observed = await this.verify(b, {
        url: p.url,
        target: t.binding!.target,
        model,
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
      if (!p.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
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
      if (!p.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
      if (!t.url && t.config.projectUrl)
        await verifyProjectComposer(
          b,
          t.config.projectUrl,
          t.config.projectName!,
        );
      await recovery?.beforeSend();
      r.error = undefined;
      // Durable write precedes the first action capable of submitting a message.
      r.state = "submitting";
      r.submittedAt = new Date().toISOString();
      this.save(t);
      this.guard(t);
      await sendPrompt(b, p);
      this.guard(t);
      for (let n = 0; n < 12; n++) {
        await this.reconcile(t, b);
        if (r.userMessageId && (!t.naming || t.url)) return t;
        await Bun.sleep(250);
      }
      return t;
    } catch (e) {
      if (r.state === "submitting") r.state = "delivery_unknown";
      if (
        r.userMessageId &&
        ["prepared", "submitting", "delivery_unknown"].includes(r.state)
      )
        r.state = "waiting";
      this.recordFailure(t, e);
      return t;
    }
  }
  async poll(id: string, run?: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id);
      if (
        this.current(t, run).state === "complete" &&
        (!t.naming || !organizationDue(t))
      )
        return this.archiveCompleted(t);
      this.begin(t);
      try {
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
          await this.publish(async () => {
            const previousUrl = t.url;
            t.url = p.url;
            try {
              this.claim(t);
              this.save(t);
            } catch (e) {
              t.url = previousUrl;
              throw e;
            }
          });
          return await this.reconcile(t, b);
        }
        return await this.reconcile(t, await this.page(t));
      } catch (e) {
        this.recordFailure(t, e, true);
        throw e;
      }
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
  /**
   * Takes the reply's Markdown through the page's own copy control. This is a copy
   * path only: it never changes delivery state, the stored rendered text, or the
   * authorization to send again, and it never throws into the operation that called it.
   */
  private async attemptCapture(t: Task, b: any, r: Run) {
    try {
      if (!r.reply?.id || r.state !== "complete")
        return { ok: false, reason: "RESULT_NOT_COMPLETE" };
      const p: PageState = await b.read();
      this.guard(t);
      if (!this.captureTargetValid(t, p, r))
        return { ok: false, reason: "TARGET_NOT_RENDERED" };
      const observed = (await b.run("eval", copyMarkdownScript(r.reply.id)))
        .result;
      this.guard(t);
      if (
        observed?.ok === true &&
        typeof observed.text === "string" &&
        observed.text.trim()
      ) {
        if (await this.captureStillAttributable(t, b, r)) {
          r.reply.markdown = observed.text;
          delete r.reply.markdownError;
        } else r.reply.markdownError = "TARGET_CHANGED";
      } else
        r.reply.markdownError = String(observed?.reason ?? "COPY_NOT_CAPTURED");
      this.save(t);
      return r.reply.markdownError
        ? { ok: false, reason: r.reply.markdownError }
        : { ok: true };
    } catch {
      // A stale attempt or a page failure leaves the durable reply intact and unarchived.
      return { ok: false, reason: "CAPTURE_FAILED" };
    }
  }
  /**
   * Proves the capture belongs to this run's reply, then waits out the page's own
   * relabel. Clicking the copy control makes it report a different action for a second
   * or two, which reads back as a turn that is no longer final, while the rendered bytes
   * stay identical. Attribution is therefore measured on the bytes, and finality is only
   * waited for so the next operation does not inherit a page still mid-click.
   */
  private async captureStillAttributable(
    t: Task,
    b: { read: () => Promise<PageState> },
    r: Run,
  ) {
    let settled = false;
    for (let attempt = 0; attempt < 4 && !settled; attempt++) {
      if (attempt) await Bun.sleep(750);
      const page = await b.read();
      this.guard(t);
      if (!this.captureAttributionValid(t, page, r)) return false;
      settled = !!page.messages.find((m) => m.id === r.reply?.id)?.final;
    }
    return true;
  }
  /** The reply this run submitted, still mounted after its own user message, still the
   * stored bytes. Later completed turns are allowed; a missing anchor is not "no later
   * turn" but a reply that cannot be tied to this run. */
  private captureAttributionValid(t: Task, p: PageState, r: Run) {
    try {
      if (!t.url || conversationId(p.url) !== conversationId(t.url))
        return false;
    } catch {
      return false;
    }
    const index = p.messages.findIndex((m) => m.id === r.reply?.id);
    if (index < 0) return false;
    const target = p.messages[index];
    if (target.role !== "assistant") return false;
    const anchor = r.userMessageId
      ? p.messages.findIndex((m) => m.id === r.userMessageId)
      : -1;
    if (anchor < 0 || anchor > index) return false;
    return sha(target.text) === r.replyHash;
  }
  /** Before the click the turn must also still present itself as completed. */
  private captureTargetValid(t: Task, p: PageState, r: Run) {
    if (!this.captureAttributionValid(t, p, r)) return false;
    return !!p.messages.find((m) => m.id === r.reply?.id)?.final;
  }
  /** Backfill path: capture and archive completed runs of one task on demand. */
  capture(id: string, run?: string, workspace?: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id);
      this.checkWorkspace(t, workspace);
      if (run) {
        const selected = t.runs.find((r) => r.id === run);
        if (!selected) throw new Error("RUN_NOT_FOUND");
        if (selected.state !== "complete" || !selected.reply)
          throw new Error("RESULT_NOT_COMPLETE");
      }
      const targets = t.runs.filter(
        (r) =>
          r.state === "complete" &&
          r.reply &&
          (!run || r.id === run) &&
          (!r.reply.markdown || (run && r.id === run)),
      );
      const captured: string[] = [];
      const unchanged: string[] = [];
      const gaps: { runId: string; code: string }[] = [];
      if (targets.length) {
        const b = await this.page(t);
        for (const r of targets) {
          const before = r.reply?.markdown;
          const attempt = await this.attemptCapture(t, b, r);
          const after = r.reply?.markdown;
          if (!attempt.ok)
            gaps.push({
              runId: r.id,
              code: attempt.reason ?? "CAPTURE_FAILED",
            });
          else if (after && after !== before) captured.push(r.id);
          // Taking the same bytes again proves the capture path works; it is not a gap.
          else if (after) unchanged.push(r.id);
        }
      }
      return {
        taskId: id,
        captured,
        unchanged,
        gaps,
        archive: publishSafely(this.store.root, id),
      };
    });
  }
  private safeCompleted(t: Task, p: PageState, r = this.current(t)) {
    if (r.state !== "complete" || !r.reply || !t.url || !r.userMessageId)
      throw new Error("RESULT_NOT_COMPLETE");
    if (
      !p.hasComposer ||
      p.draft === undefined ||
      p.draft?.trim() ||
      p.attachments ||
      p.generating ||
      p.blocked
    )
      throw new PageNotIdleError(p);
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
    return this.exclusive(id, async () => {
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
      // The last-tab keepalive decision and the close must be one cross-process
      // critical section, or two releases can strand zero tabs or double-create.
      const binding = t.binding;
      return this.tabRelease(async () => {
        this.guard(t);
        let { tabs } = await this.browser.tabs("list");
        this.guard(t);
        if (!tabs.some((x: any) => x.targetId === binding.target)) {
          binding.closed = true;
          t.cleanup = { closed: true, alreadyGone: true };
          this.save(t);
          return t.cleanup;
        }
        const b = await this.browser.page(binding.target);
        this.safeCompleted(t, await this.observe(t, b));
        if (tabs.length === 1) {
          this.store.write("keepalive", {
            version: 1,
            opening: true,
            epoch: binding.epoch,
          });
          const k = await this.browser.tabs("new", "about:blank");
          this.guard(t);
          this.store.write("keepalive", {
            version: 1,
            target: k.targetId,
            epoch: binding.epoch,
          });
        }
        this.safeCompleted(t, await this.observe(t, b));
        this.guard(t);
        await this.browser.tabs("close", binding.target);
        this.guard(t);
        tabs = (await this.browser.tabs("list")).tabs;
        if (tabs.some((x: any) => x.targetId === binding.target))
          throw new Error("CLOSE_UNVERIFIED");
        binding.closed = true;
        t.cleanup = {
          closed: true,
          target: binding.target,
          organizationPending: !!t.organization?.error,
        };
        this.save(t);
        return t.cleanup;
      }).catch((error) => {
        if (error instanceof PageNotIdleError) {
          t.cleanup = {
            closed: false,
            target: binding.target,
            error: error.message,
            reasons: error.reasons,
            observedAt: error.observedAt,
            page: error.page,
          };
          this.save(t);
        }
        throw error;
      });
    });
  }
  async attach(id: string, url: string, userMessageId: string) {
    return this.exclusive(id, async () => {
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
      await this.publish(async () => {
        this.claim(t);
        this.save(t);
      });
      return this.reconcile(t, await this.page(t));
    });
  }
  private async applyOrganization(t: Task, b: any, naming: Naming) {
    const check = async () => {
      const p = await this.observe(t, b),
        r = this.current(t);
      if (!t.url || !r.userMessageId) throw new Error("DELIVERY_NOT_CONFIRMED");
      if (p.draft?.trim() || p.attachments) throw new PageNotIdleError(p);
      const out = classify(p, t.url, r.userMessageId);
      if (!["waiting", "complete"].includes(out.state))
        throw new Error(out.reason || "CONVERSATION_CHANGED");
      if (r.state === "complete") this.safeCompleted(t, p);
      return p;
    };
    // A second, task-owned page observes persisted metadata while the original
    // page keeps streaming. It never sends or mutates conversation content.
    let observer: Awaited<ReturnType<Browser["page"]>> | undefined;
    const metadataPage = async () => {
      await check();
      if (observer) return observer;
      const epoch = await this.browser.epoch();
      const prior = t.organizationObservation;
      if (prior && !prior.closed)
        throw new Error(
          "ORGANIZATION_OBSERVER_PENDING: inspect the recorded target",
        );
      t.organizationObservation = { epoch, opening: true };
      this.save(t);
      const created = await this.browser.tabs("new", t.url!);
      this.guard(t);
      if (!created.targetId) throw new Error("ORGANIZATION_OBSERVER_UNKNOWN");
      t.organizationObservation = { epoch, target: created.targetId };
      this.save(t);
      observer = await this.browser.page(created.targetId);
      for (let n = 0; n < 20; n++) {
        const p = await observer.read();
        if (same(p.url, t.url!)) return observer;
        if (p.url !== "about:blank") throw new Error("METADATA_PAGE_CHANGED");
        await Bun.sleep(250);
      }
      throw new Error("METADATA_PAGE_UNAVAILABLE");
    };
    const attempts = (t.organization?.attempts ?? (t.organization ? 1 : 0)) + 1;
    const lastVerified = t.organization?.lastVerified;
    t.organization = { verified: false, attempts, lastVerified };
    this.save(t);
    try {
      await check();
      const guarded = {
        session: b.session,
        read: check,
        run: async (...args: string[]) => {
          await check();
          const result = await b.run(...args);
          if (args[0] === "reload") {
            for (let n = 0; ; n++) {
              try {
                await check();
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
      const metadata =
        this.current(t).state !== "complete"
          ? {
              session: b.session,
              read: async () => (await metadataPage()).read(),
              run: async (...args: string[]) => {
                const page = await metadataPage();
                const p = await page.read();
                if (!same(p.url, t.url!))
                  throw new Error("METADATA_PAGE_CHANGED");
                if (p.blocked) throw new Error(p.blocked);
                return page.run(...args);
              },
            }
          : undefined;
      t.organization = await this.organizer(
        guarded,
        t.url!,
        {
          projectUrl: t.config.projectUrl,
          projectName: t.config.projectName,
          timezone: "Asia/Shanghai",
          language: naming.language ?? "en",
        },
        naming.type,
        naming.topic,
        (progress) => {
          this.guard(t);
          t.organization = {
            ...structuredClone(progress),
            verified: false,
            lastVerified,
          };
          this.save(t);
        },
        metadata,
      );
    } catch (e) {
      t.organization = { ...t.organization, verified: false, error: String(e) };
    } finally {
      const owned = t.organizationObservation;
      const observerTarget = owned?.target;
      if (observerTarget && !owned?.closed)
        await this.tabRelease(async () => {
          try {
            if (owned.epoch !== (await this.browser.epoch()))
              throw new Error("BROWSER_RESTARTED");
            this.guard(t);
            const page = await this.browser.page(observerTarget);
            const p = await page.read();
            if (!same(p.url, t.url!) || p.draft?.trim() || p.attachments)
              throw new Error("METADATA_PAGE_CHANGED");
            await this.browser.tabs("close", observerTarget);
            if (
              (await this.browser.tabs("list")).tabs.some(
                (x: any) => x.targetId === observerTarget,
              )
            )
              throw new Error("CLOSE_UNVERIFIED");
            owned.closed = true;
          } catch (e) {
            owned.error = String(e);
          }
        });
    }
    this.guard(t);
    t.organization.lastVerified = t.organization.verified
      ? {
          observedAt: new Date().toISOString(),
          naming: { ...naming, language: naming.language ?? "en" },
          title: t.organization.title,
          project: t.organization.project,
        }
      : lastVerified;
    t.organization.attempts = attempts;
    if (!t.organization.verified && attempts <= ORGANIZATION_DELAYS.length)
      t.organization.nextRetryAt = new Date(
        Date.now() + ORGANIZATION_DELAYS[attempts - 1],
      ).toISOString();
    this.save(t);
    return t.organization;
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
    return this.exclusive(id, async () => {
      const t = this.get(id);
      const r = this.current(t, run);
      if (!t.url || !r.userMessageId) throw new Error("DELIVERY_NOT_CONFIRMED");
      conversationTitle("2000-01-01T00:00:00Z", type, topic, {
        timezone: "Asia/Shanghai",
        language,
      });
      this.begin(t);
      const b = await this.page(t);
      if (t.organization?.verified && !t.organization.lastVerified) {
        t.organization.lastVerified = {
          observedAt: t.organization.verifiedAt ?? null,
          naming: t.naming
            ? { ...t.naming, language: t.naming.language ?? "en" }
            : null,
          title: t.organization.title,
          project: t.organization.project,
        };
      }
      t.naming = { type, topic, language };
      // A new attempt does not erase evidence from the last successful one.
      t.organization = { lastVerified: t.organization?.lastVerified };
      return this.applyOrganization(t, b, t.naming);
    });
  }
}
