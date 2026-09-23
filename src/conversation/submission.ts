import { randomUUID } from "node:crypto";
import {
  clearDraft as clearDraftOnPage,
  sendPrompt,
} from "../browser/browser.ts";
import { Workspace } from "../workspace/workspace.ts";
import { sha } from "../hash.ts";
import { assertNewConversationPage } from "../browser/chatgpt/project.ts";
import { verifyProjectComposer } from "../browser/chatgpt/project.ts";
import { conversationId, type PageState } from "../browser/chatgpt/page.ts";
import { conversationConfig, type Config } from "../config/config.ts";
import { withTaskStateLock } from "../storage/task-lock.ts";
import type { State } from "../storage/state.ts";
import type { Workspace as WorkspaceType } from "../workspace/workspace.ts";
import { safeCompleted } from "./observation.ts";
import { validateNaming } from "./organization.ts";
import type { Naming, Page, Run, Task } from "./types.ts";
import type { DiagnosticStep } from "../storage/diagnostics.ts";

export interface SubmissionContext {
  readonly store: State;
  readonly verify: (
    b: any,
    opts: Record<string, string>,
  ) => Promise<{ observedModel: string }>;
  get: (id: string) => Task;
  save: (t: Task, note?: boolean) => void;
  begin: (t: Task) => void;
  guard: (t: Task) => void;
  current: (t: Task, run?: string) => Run;
  checkWorkspace: (t: Task, expected?: string) => void;
  workspace: (path: string) => WorkspaceType;
  claim: (t: Task) => void;
  publish: <T>(fn: () => Promise<T>) => Promise<T>;
  assertRequestFree: (id: string, requestId: string) => void;
  notePhase: (taskId: string, runId: string, state: string) => void;
  page: (t: Task, completedFollowup?: boolean) => Promise<Page>;
  observe: (
    t: Task,
    b: Page,
    purpose?: "observe" | "delivery" | "naming",
  ) => Promise<PageState>;
  recordFailure: (t: Task, e: unknown, observing?: boolean) => void;
  reconcile: (t: Task, b: Page) => Promise<Task>;
  setStep: (step: DiagnosticStep) => void;
}

/** Request intake, page reading and the one submit boundary. */
export function createSubmission(ctx: SubmissionContext) {
  async function create(
    id: string,
    input: string,
    requestId = "initial",
    followup = false,
    workspace?: string,
    naming?: Naming,
  ) {
    if (naming) {
      if (followup) throw new Error("NAMING_REQUIRES_CREATE_OR_ORGANIZE");
      naming = validateNaming(naming);
    }
    if (
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) ||
      !requestId ||
      requestId.length > 120 ||
      !input.trim() ||
      Buffer.byteLength(input) > 100000
    )
      throw new Error("INVALID_REQUEST");
    return withTaskStateLock(ctx.store, id, async () => {
      ctx.store.assertTaskWritable(id);
      let t: Task;
      const inputHash = sha(input);
      if (ctx.store.has("task-" + id)) {
        t = ctx.get(id);
        ctx.checkWorkspace(t, workspace);
        const previous = t.runs.find((r) => r.requestId === requestId);
        if (previous) {
          if (naming && JSON.stringify(t.naming) !== JSON.stringify(naming))
            throw new Error("NAMING_CONFLICT");
          if (previous.inputHash !== inputHash)
            throw new Error("REQUEST_CONFLICT");
          if (previous.id !== t.currentRun)
            throw new Error(
              `REQUEST_RUN_SUPERSEDED: original run ${previous.id}; inspect that run instead of starting the current one`,
            );
          return t;
        }
        if (!followup)
          throw new Error("TASK_EXISTS: use followup with a new request-id");
        if (ctx.current(t).state !== "complete")
          throw new Error("PRIOR_RUN_NOT_COMPLETE");
      } else {
        if (followup) throw new Error("TASK_NOT_FOUND");
        const config = conversationConfig(ctx.store.read<Config>("config"));
        if (workspace) config.workspace = ctx.workspace(workspace).root;
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
      ctx.assertRequestFree(id, requestId);
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
      await ctx.publish(async () => {
        ctx.assertRequestFree(id, requestId);
        ctx.save(t);
      });
      return t;
    });
  }
  /** Execute a durable, exact run. Repeated start never retries a failed send. */
  async function start(id: string, run: string, workspace?: string) {
    const t = ctx.get(id);
    ctx.checkWorkspace(t, workspace);
    const r = ctx.current(t, run);
    if (r.state !== "prepared" || r.userMessageId || r.error) return t;
    ctx.begin(t);
    return submitPrepared(t);
  }
  async function retry(id: string, run: string, workspace?: string) {
    const t = ctx.get(id);
    ctx.checkWorkspace(t, workspace);
    if (
      ctx.current(t, run).state !== "prepared" ||
      ctx.current(t, run).userMessageId
    )
      throw new Error("RUN_NOT_PREPARED");
    ctx.begin(t);
    return submitPrepared(t);
  }
  async function rebindWorkspace(
    id: string,
    run: string,
    from: string,
    path: string,
  ) {
    const t = ctx.get(id),
      r = ctx.current(t, run);
    if (
      r.state !== "prepared" ||
      r.userMessageId ||
      t.runs.length !== 1 ||
      t.url
    )
      throw new Error("RUN_NOT_PREPARED");
    ctx.checkWorkspace(t, from);
    const workspace = ctx.workspace(path);
    t.workspaceBindingChange = {
      from: t.config.workspace,
      to: workspace.root,
      at: new Date().toISOString(),
    };
    t.config.workspace = workspace.root;
    t.workspaceId = workspace.id;
    ctx.begin(t);
    return t;
  }
  async function clearDraft(id: string, run: string, expected: string) {
    const t = ctx.get(id),
      r = ctx.current(t, run);
    if (r.state !== "prepared" || r.userMessageId)
      throw new Error("RUN_NOT_PREPARED");
    if (t.url || t.runs.length !== 1 || !t.binding?.owned || t.binding.closed)
      throw new Error("DRAFT_RECOVERY_REQUIRES_OWNED_NEW_PAGE");
    if (!expected.trim()) throw new Error("EXPECTED_DRAFT_REQUIRED");
    ctx.begin(t);
    try {
      const b = await ctx.page(t),
        p = await ctx.observe(t, b);
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
      ctx.save(t); // Durable backup before the only destructive action.
      ctx.guard(t);
      await clearDraftOnPage(b, p);
      ctx.guard(t);
      r.draftRecovery.cleared = true;
      r.error = undefined;
      ctx.save(t);
      return t;
    } catch (e) {
      ctx.recordFailure(t, e);
      throw e;
    }
  }
  async function submitPrepared(
    t: Task,
    recovery?: {
      b: Page;
      checkPage: (p: PageState) => void;
      beforeSend: () => Promise<void>;
    },
  ) {
    const r = ctx.current(t),
      prompt = r.prompt;
    if (sha(prompt) !== r.promptHash || !prompt.startsWith(`${r.marker}\n\n`))
      throw new Error("PROMPT_INTEGRITY_FAILED");
    const draftText = (text: string) => text.replace(/\u00a0/g, " ").trim();
    let submittingSaved = false;
    try {
      const b = recovery?.b ?? (await ctx.page(t, t.runs.indexOf(r) > 0));
      let p = await ctx.observe(t, b);
      recovery?.checkPage(p);
      if (recovery && (p.draft === undefined || p.draft.trim()))
        throw new Error("RECOVERY_REQUIRES_EMPTY_COMPOSER");
      // A new page may still be loading. No side effects during this bounded readiness wait.
      for (let n = 0; !p.hasComposer && !p.blocked && n < 20; n++) {
        await Bun.sleep(250);
        p = await ctx.observe(t, b);
      }
      if (
        p.messages.some((m) => m.role === "user" && m.text.includes(r.marker))
      )
        return await ctx.reconcile(t, b);
      const checkDraft = (page: PageState) => {
        recovery?.checkPage(page);
        if (page.generating || !page.hasComposer || page.attachments)
          throw new Error("PAGE_NOT_IDLE");
        if (page.draft?.trim() && draftText(page.draft) !== draftText(prompt))
          throw new Error("DRAFT_CHANGED");
        const previous = t.runs.at(-2);
        if (previous) safeCompleted(t, { ...page, draft: "" }, previous);
        else if (!recovery)
          assertNewConversationPage(page, t.config.projectUrl);
        else if (page.messages.length)
          throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
      };
      checkDraft(p);
      if (!t.url && t.config.projectUrl)
        await verifyProjectComposer(b, t.config.projectUrl);
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
      ctx.setStep("model");
      const observed = await ctx.verify(b, {
        url: p.url,
        target: t.binding!.target,
        model,
      });
      ctx.guard(t);
      r.observedModel = observed.observedModel;
      p = await ctx.observe(t, b);
      checkDraft(p);
      ctx.setStep("fill");
      if (!p.draft?.trim()) await b.run("fill", "#prompt-textarea", prompt);
      ctx.guard(t);
      p = await ctx.observe(t, b);
      // Model popovers can leave a closing overlay after their label has updated.
      // Wait for a genuinely enabled, unobstructed Send button before crossing the send boundary.
      for (let n = 0; p.sendReady === false && n < 20; n++) {
        checkDraft(p);
        await Bun.sleep(100);
        p = await ctx.observe(t, b);
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
      ctx.setStep("model");
      const finalModel = await ctx.verify(b, {
        url: p.url,
        target: t.binding!.target,
        model: r.observedModel!,
        "verify-only": "true",
      });
      if (finalModel.observedModel !== r.observedModel)
        throw new Error("MODEL_CHANGED_BEFORE_SEND");
      p = await ctx.observe(t, b);
      checkDraft(p);
      if (draftText(p.draft || "") !== draftText(prompt))
        throw new Error("DRAFT_CHANGED");
      if (!p.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
      if (!t.url && t.config.projectUrl)
        await verifyProjectComposer(b, t.config.projectUrl);
      await recovery?.beforeSend();
      r.error = undefined;
      // Durable write precedes the first action capable of submitting a message.
      // The submitting diagnostic waits until click returns so the sync cannot
      // widen the gap between the saved intent and the click.
      r.state = "submitting";
      r.submittedAt = new Date().toISOString();
      ctx.setStep("persist");
      ctx.save(t, false);
      submittingSaved = true;
      ctx.guard(t);
      ctx.setStep("send");
      await sendPrompt(b, p);
      ctx.notePhase(t.id, r.id, "submitting");
      ctx.guard(t);
      for (let n = 0; n < 12; n++) {
        await ctx.reconcile(t, b);
        if (r.userMessageId) return t;
        await Bun.sleep(250);
      }
      return t;
    } catch (e) {
      if (submittingSaved && r.state === "submitting")
        ctx.notePhase(t.id, r.id, "submitting");
      if (r.state === "submitting") r.state = "delivery_unknown";
      if (
        r.userMessageId &&
        ["prepared", "submitting", "delivery_unknown"].includes(r.state)
      )
        r.state = "waiting";
      ctx.recordFailure(t, e);
      return t;
    }
  }
  async function attach(id: string, url: string, userMessageId: string) {
    conversationId(url);
    if (ctx.store.has("task-" + id)) throw new Error("TASK_EXISTS");
    const config = conversationConfig(ctx.store.read<Config>("config")),
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
    await ctx.publish(async () => {
      ctx.claim(t);
      ctx.save(t);
    });
    return ctx.reconcile(t, await ctx.page(t));
  }
  return {
    create,
    start,
    retry,
    rebindWorkspace,
    clearDraft,
    submitPrepared,
    attach,
  };
}
