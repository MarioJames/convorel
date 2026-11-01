import { conversationId, type PageState } from "../browser/chatgpt/page.ts";
import type { Browser } from "../browser/browser.ts";
import { previousTurn } from "./observation.ts";
import type { LostDeliveryCheck, Task } from "./types.ts";

/** Counts each needle in the document's inline scripts, which carry the
 * server-rendered conversation. Only the counts leave the page. */
export function serverHistoryScript(needles: Record<string, string>) {
  return `(() => {
    const text = [...document.scripts].map((s) => s.textContent || "").join("\\n");
    const needles = ${JSON.stringify(needles)};
    return Object.fromEntries(
      Object.entries(needles).map(([k, v]) => [k, text.split(v).length - 1]),
    );
  })()`;
}

/** The server must have had time to persist an accepted message. */
export const LOST_AFTER_MS = 10 * 60_000;

export interface LostContext {
  get: (id: string) => Task;
  current: (t: Task, run?: string) => Task["runs"][number];
  checkWorkspace: (t: Task, expected?: string) => void;
  guard: (t: Task) => void;
  save: (t: Task) => void;
  readonly browser: Browser;
}

/** Settles a confirmed-in-DOM followup that the server never stored, so the
 * same conversation can take a new followup. It never resends the old prompt. */
export function createLostDelivery(ctx: LostContext) {
  async function markLost(
    id: string,
    run: string,
    options: LostDeliveryCheck,
    workspace?: string,
  ) {
    const t = ctx.get(id),
      r = ctx.current(t, run);
    ctx.checkWorkspace(t, workspace);
    if (
      !["waiting", "delivery_unknown"].includes(r.state) ||
      r.observationError?.retryable !== true ||
      !r.observationError.message.includes("HISTORY_HYDRATING") ||
      !r.userMessageId ||
      r.reply ||
      r.branch
    )
      throw new Error("LOST_REQUIRES_UNMOUNTED_DELIVERY");
    if (r.userMessageId !== options.expectedUserMessageId)
      throw new Error("EXPECTED_USER_MESSAGE_MISMATCH");
    if (!t.url || options.expectedUrl !== t.url)
      throw new Error("EXPECTED_URL_MISMATCH");
    const conversation = conversationId(t.url);
    const anchor = previousTurn(t, r);
    if (
      t.runs.at(-1) !== r ||
      anchor?.state !== "complete" ||
      !anchor.userMessageId ||
      !anchor.reply?.id
    )
      throw new Error("LOST_REQUIRES_COMPLETED_ANCHOR");
    const submitted = Date.parse(r.submittedAt ?? "");
    if (!Number.isFinite(submitted) || Date.now() - submitted < LOST_AFTER_MS)
      throw new Error("LOST_TOO_EARLY");
    const binding = t.binding;
    if (!binding?.owned || binding.closed || binding.opening || t.opening)
      throw new Error("LOST_REQUIRES_OWNED_TARGET");
    const absent = (p: PageState) => {
      if (p.url !== t.url) throw new Error("LOST_TARGET_CHANGED");
      if (
        p.messages.some(
          (m) => m.id === r.userMessageId || m.text.includes(r.marker),
        )
      )
        throw new Error("SUBMITTED_MESSAGE_PRESENT");
    };
    if (binding.epoch !== (await ctx.browser.epoch()))
      throw new Error("BROWSER_RESTARTED");
    const { tabs } = await ctx.browser.tabs("list");
    ctx.guard(t);
    if (
      !tabs.some((x: any) => x.targetId === binding.target && x.url === t.url)
    )
      throw new Error("LOST_TARGET_CHANGED");
    // Never use page(t): settlement must not reopen, rebind or create a target.
    const b = await ctx.browser.page(binding.target);
    const page: PageState = await b.read();
    ctx.guard(t);
    absent(page);
    if (page.draft?.trim() || page.attachments || page.generating)
      throw new Error("LOST_REQUIRES_IDLE_PAGE");
    await b.run("reload");
    // A full load renders the conversation into the document's own scripts; it
    // issues no conversation request to observe, and none is issued here.
    let found: Record<string, number> | undefined;
    for (let n = 0; n < 20; n++) {
      ctx.guard(t);
      found = (
        await b.run(
          "eval",
          serverHistoryScript({
            conversation,
            user: r.userMessageId,
            marker: r.marker.slice(1, -1),
            anchorUser: anchor.userMessageId,
            anchorReply: anchor.reply.id,
          }),
        )
      )?.result;
      if (found?.conversation && found.anchorUser && found.anchorReply) break;
      await Bun.sleep(250);
    }
    if (!found?.conversation || !found.anchorUser || !found.anchorReply)
      throw new Error("CONVERSATION_HISTORY_UNAVAILABLE");
    if (found.user || found.marker)
      throw new Error("SUBMITTED_MESSAGE_PRESENT");
    const reloaded: PageState = await b.read();
    ctx.guard(t);
    absent(reloaded);
    r.lost = {
      at: new Date().toISOString(),
      priorUserMessageId: r.userMessageId,
      anchorReply: anchor.reply.id,
      target: binding.target,
    };
    r.state = "lost";
    r.error = `SUBMITTED_MESSAGE_LOST: the server never stored user message ${r.userMessageId}; send a new followup`;
    r.userMessageId = undefined;
    r.observationError = undefined;
    ctx.save(t);
    return t;
  }
  return { markLost };
}
