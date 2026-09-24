import { conversationId, type PageState } from "../browser/chatgpt/page.ts";
import { copyMarkdownScript } from "../browser/chatgpt/copy.ts";
import { publishSafely } from "../archive/post-archive.ts";
import { sha } from "../hash.ts";
import type { CaptureAttempt, Page, Run, Task } from "./types.ts";

export interface CaptureContext {
  get: (id: string) => Task;
  guard: (t: Task) => void;
  save: (t: Task, note?: boolean) => void;
  checkWorkspace: (t: Task, expected?: string) => void;
  page: (t: Task, completedFollowup?: boolean) => Promise<Page>;
  readonly stateRoot: string;
}

/** The reply this run submitted, still mounted after its own user message, still the
 * stored bytes. Later completed turns are allowed; a missing anchor is not "no later
 * turn" but a reply that cannot be tied to this run. */
export function captureAttributionValid(t: Task, p: PageState, r: Run) {
  try {
    if (!t.url || conversationId(p.url) !== conversationId(t.url)) return false;
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
export function captureTargetValid(t: Task, p: PageState, r: Run) {
  if (!captureAttributionValid(t, p, r)) return false;
  return !!p.messages.find((m) => m.id === r.reply?.id)?.final;
}

/** The page's own copy control is the only capture path: it never changes
 * delivery state, the stored rendered text, or the send authorization. */
export function createCapture(ctx: CaptureContext) {
  /**
   * Takes the reply's Markdown through the page's own copy control. This is a copy
   * path only: it never changes delivery state, the stored rendered text, or the
   * authorization to send again, and it never throws into the operation that called it.
   */
  async function attemptCapture(
    t: Task,
    b: Page,
    r: Run,
  ): Promise<CaptureAttempt> {
    try {
      if (!r.reply?.id || r.state !== "complete")
        return { ok: false, reason: "RESULT_NOT_COMPLETE" };
      const p: PageState = await b.read();
      ctx.guard(t);
      if (!captureTargetValid(t, p, r))
        return { ok: false, reason: "TARGET_NOT_RENDERED" };
      const observed = (await b.run("eval", copyMarkdownScript(r.reply.id)))
        .result;
      ctx.guard(t);
      if (
        observed?.ok === true &&
        typeof observed.text === "string" &&
        observed.text.trim()
      ) {
        if (await captureStillAttributable(t, b, r)) {
          r.reply.markdown = observed.text;
          delete r.reply.markdownError;
        } else r.reply.markdownError = "TARGET_CHANGED";
      } else
        r.reply.markdownError = String(observed?.reason ?? "COPY_NOT_CAPTURED");
      ctx.save(t);
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
  async function captureStillAttributable(
    t: Task,
    b: { read: () => Promise<PageState> },
    r: Run,
  ) {
    let settled = false;
    for (let attempt = 0; attempt < 4 && !settled; attempt++) {
      if (attempt) await Bun.sleep(750);
      const page = await b.read();
      ctx.guard(t);
      if (!captureAttributionValid(t, page, r)) return false;
      settled = !!page.messages.find((m) => m.id === r.reply?.id)?.final;
    }
    return true;
  }
  /** Backfill path: capture and archive completed runs of one task on demand. */
  async function capture(id: string, run?: string, workspace?: string) {
    const t = ctx.get(id);
    ctx.checkWorkspace(t, workspace);
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
      let b: Page | undefined;
      try {
        b = await ctx.page(t);
      } catch (error) {
        for (const r of targets)
          gaps.push({
            runId: r.id,
            code: String(error).includes("HISTORY_HYDRATING")
              ? "TARGET_NOT_RENDERED"
              : "CAPTURE_PAGE_UNAVAILABLE",
          });
      }
      if (b) {
        for (const r of targets) {
          const before = r.reply?.markdown;
          const attempt = await attemptCapture(t, b, r);
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
    }
    return {
      taskId: id,
      captured,
      unchanged,
      gaps,
      archive: publishSafely(ctx.stateRoot, id),
    };
  }
  return { attemptCapture, capture };
}
