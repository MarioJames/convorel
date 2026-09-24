import {
  classify,
  conversationId,
  PageNotIdleError,
  type PageState,
} from "../browser/chatgpt/page.ts";
import { ObservationError } from "../browser/browser.ts";
import { sha } from "../hash.ts";
import { diagnosticCode } from "../storage/diagnostics.ts";
import type { DiagnosticStep } from "../storage/diagnostics.ts";
import type {
  CaptureAttempt,
  DiagnosticFailure,
  Page,
  Run,
  Task,
} from "./types.ts";

export const same = (a: string, b: string) => {
  try {
    return conversationId(a) === conversationId(b);
  } catch {
    return false;
  }
};

/** A completed turn must present an idle, unedited page whose classify outcome
 * still yields the reply under its own user message; the branch is the message
 * ids from that user message onward. */
export function completedPage(t: Task, p: PageState, r: Run) {
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
  if (out.state !== "complete") throw new Error("COMPLETED_TURN_CHANGED");
  return { out, branch };
}

export function replyChanged(t: Task, p: PageState, r: Run) {
  const { out, branch } = completedPage(t, p, r);
  return (
    out.reply?.id !== r.reply!.id ||
    sha(out.reply!.text) !== r.replyHash ||
    JSON.stringify(branch) !== JSON.stringify(r.branch)
  );
}

export function safeCompleted(t: Task, p: PageState, r: Run) {
  if (replyChanged(t, p, r)) throw new Error("COMPLETED_TURN_CHANGED");
}

export interface ObservationContext {
  current: (t: Task, run?: string) => Run;
  guard: (t: Task) => void;
  save: (t: Task, note?: boolean) => void;
  claim: (t: Task) => void;
  publish: <T>(fn: () => Promise<T>) => Promise<T>;
  archiveCompleted: (t: Task) => Task;
  getStep: () => DiagnosticStep;
  setStep: (step: DiagnosticStep) => void;
  recordDiagnosticFailure: (input: DiagnosticFailure) => void;
  // Cross-module capabilities wired by the coordinator.
  releaseOrganizationObserver: (t: Task) => Promise<void>;
  attemptCapture: (t: Task, b: Page, r: Run) => Promise<CaptureAttempt>;
}

/** Observation, delivery confirmation and stalled-reply reconciliation. The
 * coordinator hands in only the state-commit and conflict-check capabilities it
 * keeps for itself, plus the capture and observer-release capabilities that
 * belong to other modules. */
export function createObservation(ctx: ObservationContext) {
  async function observe(
    t: Task,
    b: Page,
    purpose: "observe" | "delivery" | "naming" = "observe",
  ): Promise<PageState> {
    ctx.setStep("observe");
    const p: PageState = await b.read();
    ctx.guard(t);
    const r = ctx.current(t);
    r.lastObservedAt = new Date().toISOString();
    const pageUrl = new URL(p.url);
    if (
      pageUrl.origin !== "https://chatgpt.com" &&
      !(p.url === "about:blank" && !p.hasComposer)
    )
      throw new Error("PAGE_ORIGIN_CHANGED");
    if (t.url && !same(p.url, t.url)) throw new Error("CONVERSATION_CHANGED");
    if (
      p.blocked &&
      !(
        purpose !== "observe" &&
        p.blocked === "Conversation UI reported an error"
      )
    )
      throw new Error("NEEDS_ATTENTION: " + p.blocked);
    if (purpose === "naming") return p;
    if (r.observationError?.retryable && r.error === r.observationError.message)
      r.error = undefined;
    r.observationError = undefined;
    return p;
  }
  function recordFailure(t: Task, e: unknown, observing = false) {
    ctx.guard(t);
    const r = ctx.current(t);
    r.error = String(e);
    const observation = observing || e instanceof ObservationError;
    r.observationError = observation
      ? {
          at: new Date().toISOString(),
          message: String(e),
          retryable: e instanceof ObservationError,
        }
      : undefined;
    ctx.save(t);
    ctx.recordDiagnosticFailure({
      taskId: t.id,
      runId: r.id,
      event: observation ? "observe_failed" : "operation_result",
      step: observation ? "observe" : ctx.getStep(),
      code: diagnosticCode(e),
      retryable: e instanceof ObservationError,
    });
  }
  async function refreshStalledReply(
    t: Task,
    b: Page,
    page: PageState,
  ): Promise<PageState> {
    const r = ctx.current(t);
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
    if (probe.failures >= 3) {
      // Three failed reloads start a cool-off, not a permanent lockout. The
      // saved fingerprint and last attempt make this survive process restarts.
      if (
        Date.now() - Date.parse(probe.lastRefreshedAt ?? probe.unchangedSince) <
        600000
      ) {
        probe.error = "STALLED_REPLY: refresh cooling down after failures";
        return page;
      }
      probe.failures = 0;
    }
    // Refresh is never a send. Preserve user input and recheck target/branch just
    // before navigation; unknown delivery is never permission to recreate.
    const before = await observe(t, b);
    if (fingerprint(before) !== current) return before;
    if (before.draft?.trim() || before.attachments) {
      probe.error =
        "STALLED_REPLY: refresh deferred to preserve draft or attachments";
      return before;
    }
    probe.lastRefreshedAt = new Date().toISOString();
    probe.refreshes++;
    delete probe.error;
    ctx.save(t); // Durable budget before navigation, including process interruption.
    try {
      await b.run("reload");
      for (let n = 0; n < 80; n++) {
        const p: PageState = await b.read();
        ctx.guard(t);
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
      ctx.save(t);
      if (
        /CONVERSATION_CHANGED|NEEDS_ATTENTION|SUBMITTED_MESSAGE_CHANGED/.test(
          String(e),
        )
      )
        throw e;
      // Reload is observation only. Keep the confirmed delivery and let the
      // next poll retry after the durable interval instead of ending the run.
      return page;
    }
  }
  async function reconcile(t: Task, b: Page): Promise<Task> {
    await ctx.releaseOrganizationObserver(t);
    // Completed reply bytes are durable; observation never renames a conversation.
    if (ctx.current(t).state === "complete") {
      const completed = ctx.current(t);
      if (completed.reply && !completed.reply.markdown)
        await ctx.attemptCapture(t, b, completed);
      return ctx.archiveCompleted(t);
    }
    const r = ctx.current(t);
    let p = await observe(t, b, "delivery");
    if (!r.userMessageId || !t.url) {
      const found = p.messages.filter(
        (m) => m.role === "user" && m.text.includes(r.marker),
      );
      if (!found.length && r.state === "prepared") {
        ctx.save(t);
        return t;
      }
      if (found.length !== 1 || !found[0].id) {
        if (r.userMessageId) throw new Error("SUBMITTED_MESSAGE_MISSING");
        r.state = "delivery_unknown";
        r.error = "No unique submitted user message matches the marker";
        ctx.save(t);
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
        ctx.save(t);
        return t;
      }
      // Publish the conversation URL atomically with its cross-task conflict
      // check. On CONVERSATION_CONFLICT the in-memory URL is rolled back so a
      // later failure record cannot persist a URL another task already owns.
      await ctx.publish(async () => {
        const previousUrl = t.url;
        t.url = p.url;
        try {
          ctx.claim(t);
          ctx.save(t);
        } catch (e) {
          t.url = previousUrl;
          throw e;
        }
      });
    }
    if (classify(p, t.url!, r.userMessageId).state === "waiting")
      p = await refreshStalledReply(t, b, p);
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
    ctx.save(t);
    if (outcome.state === "complete" && !r.reply?.markdown)
      await ctx.attemptCapture(t, b, r);
    return r.state === "complete" ? ctx.archiveCompleted(t) : t;
  }
  return { observe, recordFailure, refreshStalledReply, reconcile };
}
