import {
  conversationTitle,
  type ConversationMetadata,
  organizeConversation,
} from "../browser/chatgpt/organize.ts";
import { PageNotIdleError, type PageState } from "../browser/chatgpt/page.ts";
import { organizationCheckpointDue } from "./organization-recovery.ts";
import { diagnosticCode } from "../storage/diagnostics.ts";
import type { Browser } from "../browser/browser.ts";
import { same } from "./observation.ts";
import {
  preserveLastTab,
  verifyCloseTarget,
  type ReleaseContext,
} from "./release.ts";
import type {
  DiagnosticFailure,
  DiagnosticStep,
  Naming,
  Page,
  Task,
} from "./types.ts";

export interface OrganizationContext {
  get: (id: string) => Task;
  current: (t: Task, run?: string) => Task["runs"][number];
  guard: (t: Task) => void;
  begin: (t: Task) => void;
  save: (t: Task, note?: boolean) => void;
  page: (t: Task, completedFollowup?: boolean) => Promise<Page>;
  observe: (
    t: Task,
    b: Page,
    purpose?: "observe" | "delivery" | "naming",
  ) => Promise<PageState>;
  setStep: (step: DiagnosticStep) => void;
  recordNamingProgress: (taskId: string, runId: string, phase: string) => void;
  recordDiagnosticFailure: (input: DiagnosticFailure) => void;
  tabRelease: ReleaseContext["tabRelease"];
  writeKeepalive: ReleaseContext["writeKeepalive"];
  readonly browser: Browser;
  readonly organizer: typeof organizeConversation;
}

/** Naming is a title policy, not an operation: resolve it before any page exists. */
export function validateNaming(naming: Naming): Naming {
  conversationTitle("2000-01-01T00:00:00Z", naming.type, naming.topic, {
    timezone: "Asia/Shanghai",
    language: naming.language ?? "en",
  });
  if (naming.language && !["en", "zh"].includes(naming.language))
    throw new Error("Title language must be en or zh");
  return {
    type: naming.type,
    topic: naming.topic.trim(),
    language: naming.language ?? "en",
  };
}

/** Organization, naming checkpoints and the task-owned metadata observer. */
export function createOrganization(ctx: OrganizationContext) {
  async function namingCheckpoint(t: Task) {
    if (!t.naming || !t.url || !ctx.current(t).userMessageId) return;
    if (!t.organization?.verified && !organizationCheckpointDue(t)) return;
    // A released task remains released. Explicit organize can restore a page.
    if (t.binding?.closed) return;
    ctx.begin(t);
    try {
      const page = await ctx.page(t);
      if (t.organization?.verified) {
        const p = await ctx.observe(t, page, "naming");
        const title = t.organization.title ?? t.organization.rename?.title;
        // Read the current document title, not a stale local verified flag.
        // The provider can finish auto-titling after our initial rename.
        if (
          title &&
          (p.title === title ||
            p.title?.endsWith(" - " + title) ||
            p.title?.startsWith(title + " - "))
        )
          return;
      }
      await applyOrganization(t, page, t.naming);
    } catch (e) {
      t.organization = {
        ...t.organization,
        ...(t.organization?.verified ? { phase: "metadata" } : {}),
        verified: false,
        error: String(e),
      };
      ctx.save(t);
    }
  }
  async function releaseOrganizationObserver(t: Task) {
    const owned = t.organizationObservation;
    if (!owned || owned.closed) return;
    // Page reads can be slow: first inspect outside the close lock, then
    // recheck identity/activity under the same cross-task lock as main release.
    try {
      const epoch = await ctx.browser.epoch();
      ctx.guard(t);
      if (owned.epoch !== epoch) {
        owned.closed = true;
        owned.ownershipExpired = true;
        delete owned.error;
        return;
      }
      if (!owned.target)
        throw new Error(
          "ORGANIZATION_OBSERVER_UNKNOWN: inspect the opening page",
        );
      // A previous close may have succeeded even when its acknowledgement failed.
      const { tabs } = await ctx.browser.tabs("list");
      if (!tabs.some((x: any) => x.targetId === owned.target)) {
        owned.closed = true;
        delete owned.error;
        return;
      }
      const page = await ctx.browser.page(owned.target);
      const p = await page.read();
      ctx.guard(t);
      if (!same(p.url, t.url!) || p.draft?.trim() || p.attachments)
        throw new Error("METADATA_PAGE_CHANGED");
      await ctx.tabRelease(async () => {
        ctx.guard(t);
        if (owned.epoch !== (await ctx.browser.epoch()))
          throw new Error("BROWSER_RESTARTED: ownership expired");
        const { tabs } = await ctx.browser.tabs("list");
        if (!tabs.some((x: any) => x.targetId === owned.target)) {
          owned.closed = true;
          delete owned.error;
          return;
        }
        const check = async (closing: boolean) => {
          const p = await page.read();
          ctx.guard(t);
          const user = ctx.current(t).userMessageId;
          const index = p.messages.findIndex(
            (m) => m.role === "user" && m.id === user,
          );
          if (
            !same(p.url, t.url!) ||
            p.draft?.trim() ||
            p.attachments ||
            !user ||
            index < 0 ||
            p.messages.slice(index + 1).some((m) => m.role === "user")
          )
            throw new Error("METADATA_PAGE_CHANGED");
          if (
            closing &&
            (!p.hasComposer ||
              p.draft === undefined ||
              p.generating ||
              p.blocked)
          )
            throw new PageNotIdleError(p);
        };
        await check(false);
        if (
          t.binding &&
          !t.binding.closed &&
          (t.binding.target === owned.target ||
            !tabs.some((x: any) => x.targetId === t.binding!.target))
        ) {
          // Transfer is not a close: the original turn may still be streaming.
          t.binding = { target: owned.target!, epoch, owned: true };
          owned.closed = true;
          owned.transferredToMain = true;
          delete owned.error;
          return;
        }
        await check(true);
        await preserveLastTab(ctx, owned.target!, epoch);
        await ctx.browser.closeTab(owned.target!, async () => {
          await verifyCloseTarget(ctx.browser, owned.target!, epoch);
          await check(true);
        });
        ctx.guard(t);
        if (
          (await ctx.browser.tabs("list")).tabs.some(
            (x: any) => x.targetId === owned.target,
          )
        )
          throw new Error("CLOSE_UNVERIFIED");
        owned.closed = true;
        delete owned.error;
      });
    } catch (e) {
      owned.error = String(e);
    } finally {
      ctx.guard(t);
      ctx.save(t);
    }
  }
  async function applyOrganization(
    t: Task,
    b: Page,
    naming: Naming,
  ): Promise<any> {
    await releaseOrganizationObserver(t);
    const check = async () => {
      const p = await ctx.observe(t, b, "naming"),
        r = ctx.current(t);
      if (!t.url || !r.userMessageId) throw new Error("DELIVERY_NOT_CONFIRMED");
      if (p.draft?.trim() || p.attachments) throw new PageNotIdleError(p);
      // Title ownership is the persisted conversation identity, not the
      // assistant's rendered text, completion status or composer hydration.
      // observe() checks that identity before every action; the organizer
      // separately verifies creation time, project and saved title metadata.
      return p;
    };
    // A second, task-owned page observes persisted metadata while the original
    // page keeps streaming. It never sends or mutates conversation content.
    let observer: Page | undefined;
    const metadataPage = async (): Promise<Page> => {
      await check();
      if (observer) return observer;
      const epoch = await ctx.browser.epoch();
      const prior = t.organizationObservation;
      if (prior && !prior.closed)
        throw new Error(
          "ORGANIZATION_OBSERVER_PENDING: inspect the recorded target",
        );
      t.organizationObservation = { epoch, opening: true };
      ctx.save(t);
      const created = await ctx.browser.tabs("new", t.url!);
      ctx.guard(t);
      if (!created.targetId) throw new Error("ORGANIZATION_OBSERVER_UNKNOWN");
      t.organizationObservation = { epoch, target: created.targetId };
      ctx.save(t);
      observer = await ctx.browser.page(created.targetId);
      for (let n = 0; n < 20; n++) {
        const p = await observer.read();
        if (same(p.url, t.url!)) return observer;
        if (p.url !== "about:blank") throw new Error("METADATA_PAGE_CHANGED");
        await Bun.sleep(250);
      }
      throw new Error("METADATA_PAGE_UNAVAILABLE");
    };
    const checkpoint = t.organization;
    const verificationOnly = ["save_pending", "verifying"].includes(
      checkpoint?.phase,
    );
    const attempts = (t.organization?.attempts ?? (t.organization ? 1 : 0)) + 1;
    const startedAt = new Date().toISOString();
    const lastVerified = t.organization?.lastVerified;
    t.organization = {
      phase: "metadata",
      ...(verificationOnly ? checkpoint : {}),
      verified: false,
      attempts,
      lastVerified,
      startedAt,
    };
    ctx.save(t);
    ctx.recordNamingProgress(t.id, t.currentRun, t.organization.phase);
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
      const metadata = {
        session: b.session,
        read: async () => (await metadataPage()).read(),
        run: async (...args: string[]) => {
          const page = await metadataPage();
          const p = await page.read();
          if (!same(p.url, t.url!)) throw new Error("METADATA_PAGE_CHANGED");
          // A response-rendering alert does not invalidate a successful,
          // identity-checked metadata response. Login/challenge still stop.
          if (p.blocked && p.blocked !== "Conversation UI reported an error")
            throw new Error(p.blocked);
          if (p.draft?.trim() || p.attachments) throw new PageNotIdleError(p);
          return page.run(...args);
        },
      };
      t.organization = await ctx.organizer(
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
          ctx.guard(t);
          t.organization = {
            ...structuredClone(progress),
            verified: false,
            attempts,
            lastVerified,
            startedAt,
          };
          ctx.save(t);
          ctx.recordNamingProgress(t.id, t.currentRun, progress.phase);
        },
        metadata,
        {
          verificationOnly,
          baseline: verificationOnly
            ? (checkpoint?.baseline as ConversationMetadata)
            : undefined,
        },
      );
    } catch (e) {
      ctx.setStep("naming");
      t.organization = { ...t.organization, verified: false, error: String(e) };
      if (typeof t.currentRun === "string")
        ctx.recordDiagnosticFailure({
          taskId: t.id,
          runId: t.currentRun,
          event: "operation_result",
          step: "naming",
          code: diagnosticCode(e),
        });
    } finally {
      await releaseOrganizationObserver(t);
    }
    ctx.guard(t);
    t.organization.startedAt = startedAt;
    t.organization.lastVerified = t.organization.verified
      ? {
          observedAt: new Date().toISOString(),
          naming: { ...naming, language: naming.language ?? "en" },
          title: t.organization.title,
          project: t.organization.project,
        }
      : lastVerified;
    t.organization.attempts = attempts;
    delete t.organization.nextRetryAt;
    ctx.save(t);
    return t.organization;
  }
  async function organize(
    id: string,
    run: string,
    type: string,
    topic: string,
    language: "en" | "zh",
  ) {
    const t = ctx.get(id);
    const r = ctx.current(t, run);
    if (!t.url || !r.userMessageId) throw new Error("DELIVERY_NOT_CONFIRMED");
    conversationTitle("2000-01-01T00:00:00Z", type, topic, {
      timezone: "Asia/Shanghai",
      language,
    });
    ctx.begin(t);
    const b = await ctx.page(t);
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
    const unresolved = ["editing", "save_pending", "verifying"].includes(
      t.organization?.phase,
    );
    if (
      unresolved &&
      (t.naming?.type !== type ||
        t.naming?.topic !== topic ||
        (t.naming?.language ?? "en") !== language)
    )
      throw new Error(
        "ORGANIZATION_WRITE_UNRESOLVED: verify the previous title before changing naming",
      );
    if (t.organization?.phase === "editing")
      throw new Error(
        "ORGANIZATION_WRITE_UNRESOLVED: inspect the interrupted title editor",
      );
    t.naming = { type, topic, language };
    // Keep uncertain saves for read-only verification, including explicit recovery.
    if (!unresolved)
      t.organization = { lastVerified: t.organization?.lastVerified };
    return applyOrganization(t, b, t.naming);
  }
  return {
    namingCheckpoint,
    releaseOrganizationObserver,
    applyOrganization,
    organize,
  };
}
