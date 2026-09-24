import { savedResult } from "./result.ts";
import { randomUUID } from "node:crypto";
import { State, registryLockName, tabsLockName } from "../storage/state.ts";
import { ObservationError, type Browser } from "../browser/browser.ts";
import { Workspace } from "../workspace/workspace.ts";
import { sha } from "../hash.ts";
import { conversationId, type PageState } from "../browser/chatgpt/page.ts";
import { ensureModel } from "../browser/chatgpt/model.ts";
import { organizeConversation } from "../browser/chatgpt/organize.ts";
import { publishSafely } from "../archive/post-archive.ts";
import { withTaskStateLock } from "../storage/task-lock.ts";
import { Diagnostics, type DiagnosticStep } from "../storage/diagnostics.ts";
import {
  createObservation,
  type ObservationContext,
  same,
} from "./observation.ts";
import { createSubmission, type SubmissionContext } from "./submission.ts";
import {
  createOrganization,
  type OrganizationContext,
} from "./organization.ts";
import { createCapture, type CaptureContext } from "./capture.ts";
import { createRelease, type ReleaseContext } from "./release.ts";
import { createRecovery, type RecoveryContext } from "./recovery.ts";
import type { Naming, Page, RejectedSendRecovery, Task } from "./types.ts";

const REGISTRY_WAIT_MS = 10_000;
const TABS_WAIT_MS = 15_000;

/** The sole coordinator: it owns task locks, the state-commit right, durable
 * checkpoints and the browser target identity. The behavior modules receive
 * capability closures built here and never see this object. */
export class Conversation {
  private readonly diagnostics: Diagnostics;
  private readonly loggedPhase = new Map<string, string>();
  private step: DiagnosticStep = "observe";
  private readonly observation: ReturnType<typeof createObservation>;
  private readonly captureModule: ReturnType<typeof createCapture>;
  private readonly organization: ReturnType<typeof createOrganization>;
  private readonly submission: ReturnType<typeof createSubmission>;
  private readonly release: ReturnType<typeof createRelease>;
  private readonly recovery: ReturnType<typeof createRecovery>;
  constructor(
    public store: State,
    public browser: Browser,
    private verify: (
      b: any,
      opts: Record<string, string>,
    ) => Promise<{ observedModel: string }> = ensureModel,
    private organizer: typeof organizeConversation = organizeConversation,
  ) {
    this.diagnostics = new Diagnostics(store.root);
    this.observation = createObservation(this.observationContext());
    this.captureModule = createCapture(this.captureContext());
    this.organization = createOrganization(this.organizationContext());
    this.submission = createSubmission(this.submissionContext());
    this.release = createRelease(this.releaseContext());
    this.recovery = createRecovery(this.recoveryContext());
  }
  private observationContext(): ObservationContext {
    return {
      current: (t, run) => this.current(t, run),
      guard: (t) => this.guard(t),
      save: (t, note) => this.save(t, note),
      claim: (t) => this.claim(t),
      publish: (fn) => this.publish(fn),
      archiveCompleted: (t) => this.archiveCompleted(t),
      getStep: () => this.step,
      setStep: (step) => {
        this.step = step;
      },
      recordDiagnosticFailure: (input) => this.diagnostics.failure(input),
      releaseOrganizationObserver: (t) =>
        this.organization.releaseOrganizationObserver(t),
      attemptCapture: (t, b, r) => this.captureModule.attemptCapture(t, b, r),
    };
  }
  private captureContext(): CaptureContext {
    return {
      get: (id) => this.get(id),
      guard: (t) => this.guard(t),
      save: (t, note) => this.save(t, note),
      checkWorkspace: (t, expected) => this.checkWorkspace(t, expected),
      page: (t, completedFollowup) => this.page(t, completedFollowup),
      stateRoot: this.store.root,
    };
  }
  private organizationContext(): OrganizationContext {
    return {
      get: (id) => this.get(id),
      current: (t, run) => this.current(t, run),
      guard: (t) => this.guard(t),
      begin: (t) => this.begin(t),
      save: (t, note) => this.save(t, note),
      page: (t, completedFollowup) => this.page(t, completedFollowup),
      observe: (t, b, purpose) => this.observation.observe(t, b, purpose),
      setStep: (step) => {
        this.step = step;
      },
      recordNamingProgress: (taskId, runId, phase) =>
        this.diagnostics.namingProgress(taskId, runId, phase),
      recordDiagnosticFailure: (input) => this.diagnostics.failure(input),
      tabRelease: (fn) => this.tabRelease(fn),
      writeKeepalive: (value) => this.store.write("keepalive", value),
      browser: this.browser,
      organizer: this.organizer,
    };
  }
  private submissionContext(): SubmissionContext {
    return {
      store: this.store,
      verify: (b, opts) => this.verify(b, opts),
      get: (id) => this.get(id),
      save: (t, note) => this.save(t, note),
      begin: (t) => this.begin(t),
      guard: (t) => this.guard(t),
      current: (t, run) => this.current(t, run),
      checkWorkspace: (t, expected) => this.checkWorkspace(t, expected),
      workspace: (path) => this.workspace(path),
      claim: (t) => this.claim(t),
      publish: (fn) => this.publish(fn),
      assertRequestFree: (id, requestId) =>
        this.assertRequestFree(id, requestId),
      notePhase: (taskId, runId, state) => this.notePhase(taskId, runId, state),
      page: (t, completedFollowup) => this.page(t, completedFollowup),
      observe: (t, b, purpose) => this.observation.observe(t, b, purpose),
      recordFailure: (t, e, observing) =>
        this.observation.recordFailure(t, e, observing),
      reconcile: (t, b) => this.observation.reconcile(t, b),
      setStep: (step) => {
        this.step = step;
      },
    };
  }
  private releaseContext(): ReleaseContext {
    return {
      get: (id) => this.get(id),
      current: (t, run) => this.current(t, run),
      result: (id, run) => this.result(id, run),
      begin: (t) => this.begin(t),
      guard: (t) => this.guard(t),
      save: (t, note) => this.save(t, note),
      tabRelease: (fn) => this.tabRelease(fn),
      observe: (t, b) => this.observation.observe(t, b),
      writeKeepalive: (value) => this.store.write("keepalive", value),
      browser: this.browser,
      namingCheckpoint: (t) => this.organization.namingCheckpoint(t),
      releaseOrganizationObserver: (t) =>
        this.organization.releaseOrganizationObserver(t),
      recordDiagnosticFailure: (input) => this.diagnostics.failure(input),
    };
  }
  private recoveryContext(): RecoveryContext {
    return {
      get: (id) => this.get(id),
      current: (t, run) => this.current(t, run),
      checkWorkspace: (t, expected) => this.checkWorkspace(t, expected),
      guard: (t) => this.guard(t),
      begin: (t) => this.begin(t),
      browser: this.browser,
      submitPrepared: (t, recovery) =>
        this.submission.submitPrepared(t, recovery),
    };
  }
  get(id: string): Task {
    return this.store.read<Task>("task-" + id);
  }
  private save(t: Task, note = true) {
    const { archive: _archive, ...document } = t;
    try {
      this.store.write("task-" + t.id, document);
    } catch (error) {
      const runId = t.currentRun;
      if (typeof runId === "string")
        this.diagnostics.failure({
          taskId: t.id,
          runId,
          event: "operation_result",
          step: "persist",
          code: "STATE_PERSIST_FAILED",
        });
      throw error;
    }
    if (note) this.notePhases(t);
  }
  /** Log a phase only after the task document is durable. Repeated saves of the same phase do not append. */
  private notePhases(t: Task) {
    for (const run of t.runs) this.notePhase(t.id, run.id, run.state);
  }
  private notePhase(taskId: string, runId: string, state: string) {
    if (this.loggedPhase.get(runId) === state) return;
    const recorded = this.diagnostics.rememberPhase(taskId, runId, state);
    if (recorded === "stored" || recorded === "same" || recorded === "disabled")
      this.loggedPhase.set(runId, state);
  }
  /** Serializes one task's browser side effects on its own tab, releasing every
   * session it opened. Different tasks proceed concurrently; config browser.serial=true
   * restores the single global browser lock for environments that cannot. */
  private exclusive<T>(id: string, fn: () => Promise<T>) {
    return withTaskStateLock(this.store, id, async () => {
      this.store.assertTaskWritable(id);
      return this.browser.withSessionScope(fn);
    });
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
      if (!t.url || same(previous.url, t.url))
        return { target: previous.targetId, created: false };
      // The known conversation can be observed on a fresh page. Preserve a
      // navigated or blank original target, including any user draft on it.
      (t.detachedBindings ??= []).push({
        ...t.binding!,
        reason: previous.url === "about:blank" ? "blank" : "navigated",
      });
      t.binding = undefined;
      this.save(t);
    }
    if (
      !t.url &&
      t.binding &&
      !previous &&
      !t.opening &&
      t.runs.length === 1 &&
      this.current(t).state === "prepared" &&
      !this.current(t).submittedAt &&
      !this.current(t).userMessageId
    ) {
      t.pageRecreations = (t.pageRecreations ?? 0) + 1;
      t.binding = undefined;
      this.save(t);
    }
    if (
      !t.url &&
      t.opening &&
      !t.binding &&
      t.runs.length === 1 &&
      this.current(t).state === "prepared" &&
      !this.current(t).submittedAt &&
      !this.current(t).userMessageId
    ) {
      // No run could send before its target binding was published. A lost
      // creation acknowledgement may leave an unclaimed empty tab behind.
      t.opening = false;
      t.pageRecreations = (t.pageRecreations ?? 0) + 1;
      this.save(t);
    }
    if (!t.url && (t.opening || t.binding))
      throw new Error(
        "OPEN_UNKNOWN: inspect the created page; no automatic replacement",
      );
    // URL recovery cannot borrow any other task's main or metadata target.
    const claimed = new Set(
      (this.store.tasks() as Task[])
        .filter((other) => other.id !== t.id)
        .flatMap((other) =>
          [other.binding, other.organizationObservation]
            .filter(
              (binding) =>
                binding && !binding.closed && binding.epoch === epoch,
            )
            .map((binding) => binding!.target),
        ),
    );
    const existing = t.url
      ? tabs.filter((x: any) => same(x.url, t.url!) && !claimed.has(x.targetId))
      : [];
    if (existing.length === 1) {
      t.binding = { target: existing[0].targetId, epoch, owned: false };
      t.opening = false;
      await this.publish(async () => {
        this.claim(t);
        this.save(t);
      });
      return { target: t.binding.target, created: false };
    }
    if (t.opening && !t.url)
      throw new Error("OPEN_UNKNOWN: no automatic second creation attempt");
    if (t.opening && t.url) {
      // A lost acknowledgement for opening a known URL cannot grant Send.
      // The earlier unbound page may remain; a new page only observes the URL.
      t.opening = false;
      t.pageRecreations = (t.pageRecreations ?? 0) + 1;
      this.save(t);
    }
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
  private async page(t: Task, completedFollowup = false): Promise<Page> {
    const { target, created } = await this.open(t, completedFollowup);
    this.guard(t);
    const b = await this.browser.page(target);
    // Bound and restored pages can both expose partial history during hydration.
    // Only read while loading; changed URLs and blocked pages still fail closed.
    if (t.url) {
      const current = this.current(t);
      const anchor = current.userMessageId ? current : t.runs.at(-2);
      const userId = anchor?.userMessageId;
      const replyId = anchor?.reply?.id;
      let last: PageState | undefined;
      for (let n = 0; n < (created ? 12 : 4); n++) {
        const p: PageState = await b.read();
        last = p;
        this.guard(t);
        const reply = replyId
          ? p.messages.find((m) => m.id === replyId)
          : undefined;
        const blank =
          p.url === "about:blank" && !p.hasComposer && !p.messages.length;
        const anchorMissing =
          !!userId && !p.messages.some((m) => m.id === userId);
        const replyLoading =
          !!replyId &&
          (!reply ||
            (created &&
              (!reply.final ||
                (!!anchor?.replyHash &&
                  sha(reply.text) !== anchor.replyHash))));
        const loading =
          same(p.url, t.url) &&
          ((!p.hasComposer && !userId) || anchorMissing || replyLoading);
        if (
          p.blocked ||
          (!anchorMissing &&
            (p.draft?.trim() || p.attachments || p.generating)) ||
          (!blank && !loading)
        )
          break;
        await Bun.sleep(250);
      }
      if (
        last &&
        userId &&
        same(last.url, t.url) &&
        !last.blocked &&
        !last.messages.some((m) => m.id === userId) &&
        (created || !last.hasComposer || !last.messages.length)
      )
        throw new ObservationError(
          "HISTORY_HYDRATING: saved user message has not mounted",
        );
    }
    return b;
  }
  private archiveCompleted(t: Task) {
    t.archive = publishSafely(this.store.root, t.id);
    return t;
  }
  async create(
    id: string,
    input: string,
    requestId = "initial",
    followup = false,
    workspace?: string,
    naming?: Naming,
  ) {
    return this.submission.create(
      id,
      input,
      requestId,
      followup,
      workspace,
      naming,
    );
  }
  /** Execute a durable, exact run. Repeated start never retries a failed send. */
  async start(id: string, run: string, workspace?: string) {
    return this.exclusive(id, () => this.submission.start(id, run, workspace));
  }
  async retry(id: string, run: string, workspace?: string) {
    return this.exclusive(id, () => this.submission.retry(id, run, workspace));
  }
  /** Operator-authorized recovery of a verified Cloudflare-rejected followup.
   * DOM absence alone never grants permission to send again. */
  async recoverSend(
    id: string,
    run: string,
    options: RejectedSendRecovery,
    workspace?: string,
  ) {
    return this.exclusive(id, () =>
      this.recovery.recoverSend(id, run, options, workspace),
    );
  }
  async rebindWorkspace(id: string, run: string, from: string, path: string) {
    return this.exclusive(id, () =>
      this.submission.rebindWorkspace(id, run, from, path),
    );
  }
  async clearDraft(id: string, run: string, expected: string) {
    return this.exclusive(id, () =>
      this.submission.clearDraft(id, run, expected),
    );
  }
  async poll(id: string, run?: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id);
      this.current(t, run);
      this.begin(t);
      if (t.organizationObservation && !t.organizationObservation.closed)
        await this.organization.releaseOrganizationObserver(t);
      if (this.current(t, run).state === "complete") {
        const completed = this.current(t, run);
        if (completed.reply && !completed.reply.markdown) {
          try {
            await this.captureModule.attemptCapture(
              t,
              await this.page(t),
              completed,
            );
          } catch {
            completed.reply.markdownError = "CAPTURE_PAGE_UNAVAILABLE";
            this.save(t);
          }
        }
        return this.archiveCompleted(t);
      }
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
          return await this.observation.reconcile(t, b);
        }
        return await this.observation.reconcile(t, await this.page(t));
      } catch (e) {
        this.observation.recordFailure(t, e, true);
        throw e;
      }
    });
  }
  resume(id: string, run?: string) {
    return this.poll(id, run);
  }
  /** A bounded naming check at a wait/finish boundary, independent of reply
   * monitoring. Never sends, replaces captured results, or resets a write checkpoint. */
  async ensureNaming(id: string, run: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id);
      this.current(t, run);
      await this.organization.namingCheckpoint(t);
      return this.current(t).state === "complete"
        ? this.archiveCompleted(t)
        : t;
    });
  }
  result(id: string, run?: string) {
    return savedResult(this.get(id), run);
  }
  /** Backfill path: capture and archive completed runs of one task on demand. */
  capture(id: string, run?: string, workspace?: string) {
    return this.exclusive(id, () =>
      this.captureModule.capture(id, run, workspace),
    );
  }
  async finish(id: string, run?: string) {
    return this.exclusive(id, () => this.release.finish(id, run));
  }
  async attach(id: string, url: string, userMessageId: string) {
    return this.exclusive(id, () =>
      this.submission.attach(id, url, userMessageId),
    );
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
    return this.exclusive(id, () =>
      this.organization.organize(id, run, type, topic, language),
    );
  }
}
