import { COMPOSER_SELECTOR } from "../browser/chatgpt/controls.ts";
import { randomUUID } from "node:crypto";
import {
  ActionNotDispatched,
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
import { composePrompt, promptContext, validPrompt } from "./prompt.ts";

class RunMessagePresent extends Error {}
class ComposerRecovered extends Error {}

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
      const context = promptContext(t.config.workspace);
      const prompt = composePrompt(marker, input, context);
      t.currentRun = runId;
      t.runs.push({
        id: runId,
        requestId,
        inputHash,
        input,
        promptContext: context,
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
    return submitPrepared(t, undefined, true);
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
      r.submittedAt ||
      t.runs.length !== 1 ||
      t.url
    )
      throw new Error("RUN_NOT_PREPARED");
    ctx.checkWorkspace(t, from);
    const workspace = ctx.workspace(path);
    if (r.promptContext && !validPrompt(r))
      throw new Error("PROMPT_INTEGRITY_FAILED");
    t.workspaceBindingChange = {
      from: t.config.workspace,
      to: workspace.root,
      at: new Date().toISOString(),
      ...(r.promptContext
        ? { priorPrompt: r.prompt, priorPromptHash: r.promptHash }
        : {}),
    };
    t.config.workspace = workspace.root;
    t.workspaceId = workspace.id;
    if (r.promptContext) {
      r.promptContext = { ...r.promptContext, workspace: workspace.root };
      r.prompt = composePrompt(r.marker, r.input!, r.promptContext);
      r.promptHash = sha(r.prompt);
    }
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
    returnToProject = false,
  ) {
    const r = ctx.current(t),
      prompt = r.prompt;
    if (!validPrompt(r)) throw new Error("PROMPT_INTEGRITY_FAILED");
    const draftText = (text: string) => text.replace(/\u00a0/g, " ").trim();
    let submittingSaved = false;
    let b: Page | undefined;
    const beforeSubmission = {
      state: r.state,
      submittedAt: r.submittedAt,
      userMessageId: r.userMessageId,
      sendRecoveries: r.sendRecoveries
        ? structuredClone(r.sendRecoveries)
        : undefined,
      observationError: r.observationError,
    };
    try {
      b = recovery?.b ?? (await ctx.page(t, t.runs.indexOf(r) > 0));
      if (
        returnToProject &&
        t.config.projectUrl &&
        !t.url &&
        t.binding?.owned
      ) {
        ctx.guard(t);
        const before = await b.read();
        ctx.guard(t);
        if (
          before.messages.some(
            (message) =>
              message.role === "user" && message.text.includes(r.marker),
          )
        )
          return await ctx.reconcile(t, b);
        try {
          await b.runChecked(["open", t.config.projectUrl], async () => {
            const current = await b!.read();
            ctx.guard(t);
            if (
              current.messages.some(
                (message) =>
                  message.role === "user" && message.text.includes(r.marker),
              )
            )
              throw new RunMessagePresent();
          });
        } catch (error) {
          if (
            error instanceof ActionNotDispatched &&
            error.cause instanceof RunMessagePresent
          )
            return await ctx.reconcile(t, b);
          throw error;
        }
        ctx.guard(t);
      }
      let p = await ctx.observe(t, b);
      recovery?.checkPage(p);
      if (recovery && (p.draft === undefined || p.draft.trim()))
        throw new Error("RECOVERY_REQUIRES_EMPTY_COMPOSER");
      // A new page may still be loading. An owned completed page gets a short
      // hydration window before a guarded reload of that same conversation.
      const previous = t.runs.at(-2);
      const recoverableComposer =
        !!previous && !!t.url && !!t.binding?.owned && !recovery;
      for (
        let n = 0;
        !p.hasComposer && !p.blocked && n < (recoverableComposer ? 4 : 20);
        n++
      ) {
        await Bun.sleep(250);
        p = await ctx.observe(t, b);
      }
      if (
        p.messages.some((m) => m.role === "user" && m.text.includes(r.marker))
      )
        return await ctx.reconcile(t, b);
      if (
        recoverableComposer &&
        !p.hasComposer &&
        p.draft === "" &&
        !p.attachments &&
        !p.generating
      ) {
        // The missing composer is the condition being repaired. Validate the
        // saved completed branch without treating that absence as history drift.
        safeCompleted(t, { ...p, hasComposer: true }, previous!);
        try {
          await b.runChecked(["reload"], async () => {
            const latest = await ctx.observe(t, b!);
            if (
              latest.messages.some(
                (m) => m.role === "user" && m.text.includes(r.marker),
              )
            )
              throw new RunMessagePresent();
            if (latest.hasComposer) throw new ComposerRecovered();
            if (latest.draft !== "" || latest.attachments || latest.generating)
              throw new Error("RECOVERY_PAGE_CHANGED");
            safeCompleted(t, { ...latest, hasComposer: true }, previous!);
          });
        } catch (error) {
          if (error instanceof ActionNotDispatched) {
            if (error.cause instanceof RunMessagePresent)
              return await ctx.reconcile(t, b);
            if (!(error.cause instanceof ComposerRecovered)) throw error;
          } else throw error;
        }
        p = await ctx.observe(t, b);
        for (let n = 0; !p.hasComposer && !p.blocked && n < 20; n++) {
          await Bun.sleep(250);
          p = await ctx.observe(t, b);
        }
      }
      const checkDraft = (page: PageState) => {
        recovery?.checkPage(page);
        if (page.generating || !page.hasComposer || page.attachments)
          throw new Error("PAGE_NOT_IDLE");
        if (page.draft?.trim() && draftText(page.draft) !== draftText(prompt))
          throw new Error("DRAFT_CHANGED");
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
      if (p.draft === "") {
        const beforeFill = async () => {
          const latest = await ctx.observe(t, b!);
          if (
            latest.messages.some(
              (message) =>
                message.role === "user" && message.text.includes(r.marker),
            )
          )
            throw new RunMessagePresent();
          checkDraft(latest);
          if (latest.draft !== "") throw new Error("DRAFT_CHANGED");
        };
        if (b.runControl)
          await b.runControl(
            "fill",
            {
              scope: "main form",
              role: "textbox",
              fallback: COMPOSER_SELECTOR,
              url: p.url,
            },
            prompt,
            beforeFill,
          );
        else
          await b.runChecked(["fill", COMPOSER_SELECTOR, prompt], beforeFill);
      }
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
      ctx.setStep("send");
      await sendPrompt(b, p, async () => {
        // The pacing lock and delay have completed. Model-menu inspection
        // reuses this adapter's lease and settles before the final page checks.
        let latest = await ctx.observe(t, b!);
        if (
          !recovery &&
          latest.messages.some(
            (message) =>
              message.role === "user" && message.text.includes(r.marker),
          )
        )
          throw new RunMessagePresent();
        checkDraft(latest);
        if (draftText(latest.draft || "") !== draftText(prompt))
          throw new Error("DRAFT_CHANGED");
        if (!latest.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
        const lastModel = await ctx.verify(b, {
          url: latest.url,
          target: t.binding!.target,
          model: r.observedModel!,
          "verify-only": "true",
        });
        if (lastModel.observedModel !== r.observedModel)
          throw new Error("MODEL_CHANGED_BEFORE_SEND");
        latest = await ctx.observe(t, b!);
        if (
          !recovery &&
          latest.messages.some(
            (message) =>
              message.role === "user" && message.text.includes(r.marker),
          )
        )
          throw new RunMessagePresent();
        checkDraft(latest);
        if (
          draftText(latest.draft || "") !== draftText(prompt) ||
          !latest.sendReady
        )
          throw new Error("DRAFT_CHANGED");
        if (!t.url && t.config.projectUrl)
          await verifyProjectComposer(b!, t.config.projectUrl);
        await recovery?.beforeSend();
        r.error = undefined;
        // Durable intent is now adjacent to the first action capable of
        // submitting. A crash after this write remains delivery-uncertain.
        r.state = "submitting";
        r.submittedAt = new Date().toISOString();
        ctx.setStep("persist");
        ctx.save(t, false);
        submittingSaved = true;
        ctx.guard(t);
        ctx.setStep("send");
      });
      ctx.notePhase(t.id, r.id, "submitting");
      ctx.guard(t);
      for (let n = 0; n < 12; n++) {
        await ctx.reconcile(t, b);
        if (r.userMessageId) return t;
        await Bun.sleep(250);
      }
      return t;
    } catch (caught) {
      let e: unknown = caught;
      if (e instanceof ActionNotDispatched) {
        const reason = e.cause;
        if (r.state === "submitting") {
          r.state = beforeSubmission.state;
          r.submittedAt = beforeSubmission.submittedAt;
          r.userMessageId = beforeSubmission.userMessageId;
          r.sendRecoveries = beforeSubmission.sendRecoveries;
          r.observationError = beforeSubmission.observationError;
          ctx.save(t, false);
          submittingSaved = false;
        }
        if (reason instanceof RunMessagePresent && b)
          return await ctx.reconcile(t, b);
        e = reason;
      }
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
