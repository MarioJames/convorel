import { conversationId, type PageState } from "../browser/chatgpt/page.ts";
import { sha } from "../hash.ts";
import type { Browser } from "../browser/browser.ts";
import { safeCompleted } from "./observation.ts";
import type { Page, RejectedSendRecovery, Task } from "./types.ts";

export interface RecoveryContext {
  get: (id: string) => Task;
  current: (t: Task, run?: string) => Task["runs"][number];
  checkWorkspace: (t: Task, expected?: string) => void;
  guard: (t: Task) => void;
  begin: (t: Task) => void;
  readonly browser: Browser;
  // Cross-module capability wired by the coordinator: the shared submit boundary.
  submitPrepared: (
    t: Task,
    recovery?: {
      b: Page;
      checkPage: (p: PageState) => void;
      beforeSend: () => Promise<void>;
    },
  ) => Promise<Task>;
}

/** Operator-authorized recovery of a verified Cloudflare-rejected followup.
 * DOM absence alone never grants permission to send again. */
export function createRecovery(ctx: RecoveryContext) {
  async function recoverSend(
    id: string,
    run: string,
    options: RejectedSendRecovery,
    workspace?: string,
  ) {
    const t = ctx.get(id),
      r = ctx.current(t, run);
    ctx.checkWorkspace(t, workspace);
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
      r.sendRecoveries?.some((a) => a.evidence.timestamp === options.rejectedAt)
    )
      throw new Error("REJECTED_SEND_EVIDENCE_REQUIRED");
    const binding = t.binding;
    if (!binding?.owned || binding.closed || binding.opening || t.opening)
      throw new Error("RECOVERY_REQUIRES_OWNED_TARGET");
    const checkTarget = async () => {
      if (binding.epoch !== (await ctx.browser.epoch()))
        throw new Error("BROWSER_RESTARTED");
      ctx.guard(t);
      const { tabs } = await ctx.browser.tabs("list");
      ctx.guard(t);
      if (
        !tabs.some((x: any) => x.targetId === binding.target && x.url === t.url)
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
            m.id === options.expectedUserMessageId || m.text.includes(r.marker),
        )
      )
        throw new Error("RECOVERY_MESSAGE_OR_URL_CHANGED");
      safeCompleted(t, { ...p, draft: "" }, previous);
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
    const b = await ctx.browser.page(binding.target);
    const p: PageState = await b.read();
    ctx.guard(t);
    checkPage(p);
    if (p.draft === undefined || p.draft.trim())
      throw new Error("RECOVERY_REQUIRES_EMPTY_COMPOSER");
    const priorAttemptId = t.attemptId;
    ctx.begin(t);
    return ctx.submitPrepared(t, {
      b,
      checkPage,
      beforeSend: async () => {
        await checkTarget();
        const latest: PageState = await b.read();
        ctx.guard(t);
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
  }
  return { recoverSend };
}
