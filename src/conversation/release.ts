import { PageNotIdleError, type PageState } from "../browser/chatgpt/page.ts";
import { diagnosticCode } from "../storage/diagnostics.ts";
import type { Browser } from "../browser/browser.ts";
import { completedPage, replyChanged } from "./observation.ts";
import type { DiagnosticFailure, Page, Task } from "./types.ts";

export interface ReleaseContext {
  get: (id: string) => Task;
  current: (t: Task, run?: string) => Task["runs"][number];
  result: (id: string, run?: string) => unknown;
  begin: (t: Task) => void;
  guard: (t: Task) => void;
  save: (t: Task, note?: boolean) => void;
  tabRelease: <T>(fn: () => Promise<T>) => Promise<T>;
  observe: (t: Task, b: Page) => Promise<PageState>;
  writeKeepalive: (value: {
    version: 1;
    opening?: boolean;
    target?: string;
    epoch: string;
  }) => void;
  readonly browser: Browser;
  // Cross-module capabilities wired by the coordinator.
  namingCheckpoint: (t: Task) => Promise<void>;
  releaseOrganizationObserver: (t: Task) => Promise<void>;
  recordDiagnosticFailure: (input: DiagnosticFailure) => void;
}

/** Caller holds the cross-task close lock. Every owned-page close, including
 * observer retries, uses this same last-tab protection. */
export async function preserveLastTab(
  ctx: Pick<ReleaseContext, "browser" | "writeKeepalive">,
  target: string,
  epoch: string,
) {
  const { tabs } = await ctx.browser.tabs("list");
  if (tabs.some((tab: any) => tab.targetId !== target)) return;
  ctx.writeKeepalive({ version: 1, opening: true, epoch });
  const keepalive = await ctx.browser.tabs("new", "about:blank");
  if (!keepalive.targetId || keepalive.targetId === target)
    throw new Error("KEEPALIVE_UNVERIFIED");
  ctx.writeKeepalive({ version: 1, target: keepalive.targetId, epoch });
  if (
    !(await ctx.browser.tabs("list")).tabs.some(
      (tab: any) => tab.targetId === keepalive.targetId,
    )
  )
    throw new Error("KEEPALIVE_UNVERIFIED");
}

/** Read-only preflight inside the pacing lock: creating a new tab here would
 * recursively acquire that lock. If the keepalive vanished, preserve the target. */
export async function verifyCloseTarget(
  browser: Browser,
  target: string,
  epoch: string,
) {
  if (epoch !== (await browser.epoch()))
    throw new Error("BROWSER_RESTARTED: ownership expired");
  if (
    !(await browser.tabs("list")).tabs.some(
      (tab: any) => tab.targetId !== target,
    )
  )
    throw new Error("KEEPALIVE_UNVERIFIED");
}

/** Wait for hydration outside the cross-task lock, then serialize last-tab
 * keepalive, closing and close verification inside that lock. */
export function createRelease(ctx: ReleaseContext) {
  /** Attaching to an idle background tab can precede composer hydration. Read
   * only, outside the cross-task close lock; never reload or clear a draft. */
  async function waitForRelease(t: Task, b: Page) {
    for (let n = 0; ; n++) {
      const p = await ctx.observe(t, b);
      const loading =
        (!p.hasComposer || !p.messages.length) &&
        p.draft === "" &&
        !p.attachments &&
        !p.generating &&
        !p.blocked;
      if (!loading || n >= 40) {
        completedPage(t, p, ctx.current(t));
        return;
      }
      await Bun.sleep(250);
    }
  }
  async function finish(id: string, run?: string) {
    const t = ctx.get(id);
    ctx.current(t, run);
    ctx.result(id, run);
    ctx.begin(t);
    await ctx.namingCheckpoint(t);
    await ctx.releaseOrganizationObserver(t);
    if (!t.binding?.owned || t.binding.closed) {
      t.cleanup = {
        closed: !!t.binding?.closed,
        reason: "Borrowed, untracked or already closed",
      };
      ctx.save(t);
      return t.cleanup;
    }
    if (t.binding.epoch !== (await ctx.browser.epoch()))
      throw new Error("BROWSER_RESTARTED: ownership expired");
    // The last-tab keepalive decision and the close must be one cross-process
    // critical section, or two releases can strand zero tabs or double-create.
    const binding = t.binding;
    const release = async () => {
      const { tabs } = await ctx.browser.tabs("list");
      if (tabs.some((x: any) => x.targetId === binding.target))
        await waitForRelease(t, await ctx.browser.page(binding.target));
      return ctx.tabRelease(async () => {
        ctx.guard(t);
        let { tabs } = await ctx.browser.tabs("list");
        ctx.guard(t);
        if (!tabs.some((x: any) => x.targetId === binding.target)) {
          binding.closed = true;
          t.cleanup = { closed: true, alreadyGone: true };
          ctx.save(t);
          return t.cleanup;
        }
        const b = await ctx.browser.page(binding.target);
        ctx.guard(t);
        completedPage(t, await ctx.observe(t, b), ctx.current(t));
        await preserveLastTab(ctx, binding.target, binding.epoch);
        ctx.guard(t);
        // Closing an idle owned tab does not overwrite its durable reply. A
        // later assistant rendering in the same user turn is not user work.
        let changed = false;
        await ctx.browser.closeTab(binding.target, async () => {
          await verifyCloseTarget(ctx.browser, binding.target, binding.epoch);
          changed = replyChanged(t, await ctx.observe(t, b), ctx.current(t));
          ctx.guard(t);
        });
        ctx.guard(t);
        tabs = (await ctx.browser.tabs("list")).tabs;
        if (tabs.some((x: any) => x.targetId === binding.target))
          throw new Error("CLOSE_UNVERIFIED");
        binding.closed = true;
        t.cleanup = {
          closed: true,
          target: binding.target,
          organizationPending: !!t.naming && t.organization?.verified !== true,
          replyChanged: changed,
        };
        ctx.save(t);
        return t.cleanup;
      });
    };
    return release().catch((error) => {
      if (typeof t.currentRun === "string")
        ctx.recordDiagnosticFailure({
          taskId: t.id,
          runId: t.currentRun,
          event: "operation_result",
          step: "release",
          code: diagnosticCode(error),
        });
      if (error instanceof PageNotIdleError) {
        t.cleanup = {
          closed: false,
          target: binding.target,
          error: error.message,
          reasons: error.reasons,
          observedAt: error.observedAt,
          page: error.page,
        };
        ctx.save(t);
      } else {
        t.cleanup = {
          closed: false,
          target: binding.target,
          error: String(error),
          nextAction: "finish",
        };
        ctx.save(t);
      }
      throw error;
    });
  }
  return { finish };
}
