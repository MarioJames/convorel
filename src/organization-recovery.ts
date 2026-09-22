import type { Task } from "./conversation.ts";

export const ORGANIZATION_ATTEMPTS = 3;
export const ORGANIZATION_DELAYS = [5000, 30000];

export function organizationRecovery(task: Task) {
  if (!task.naming) return null;
  const o = task.organization;
  const attempts = o?.attempts ?? (o ? 1 : 0);
  // After save dispatch recovery only reads persisted metadata. An interrupted
  // edit (or a legacy checkpoint without a phase) is never replayed.
  const verificationOnly = ["save_pending", "verifying"].includes(o?.phase);
  const beforeEdit = o?.phase === "locating" || (!o?.phase && !o?.rename);
  const transient =
    (verificationOnly &&
      !/ORGANIZATION_SAVE_UNCONFIRMED|CHANGED|HTTP (?:401|403)|NEEDS_ATTENTION/.test(
        o?.error ?? "",
      )) ||
    (beforeEdit &&
      /^(?:Error: )?(?:NEEDS_ATTENTION: )?(?:Conversation UI reported an error|METADATA_PAGE_UNAVAILABLE|Target conversation not visible in sidebar; open its project\/history before retrying|Fresh conversation metadata unavailable after reload; organization not verified|Conversation metadata request rejected \(HTTP (?:429|5\d\d)\); organization not verified)$/.test(
        o?.error ?? "",
      ));
  const retryable =
    !o?.verified &&
    transient &&
    attempts < ORGANIZATION_ATTEMPTS &&
    (!task.organizationObservation ||
      task.organizationObservation.closed === true);
  const previous = o?.lastVerified;
  const revalidation =
    previous?.naming &&
    previous.naming.type === task.naming.type &&
    previous.naming.topic === task.naming.topic &&
    previous.naming.language === (task.naming.language ?? "en");
  return {
    lastVerified: previous ?? null,
    phase: o?.phase ?? null,
    recovery: verificationOnly ? "verify_only" : "locate",
    state: o?.verified
      ? "verified"
      : !o
        ? "pending"
        : retryable
          ? "retry_pending"
          : revalidation
            ? "revalidation_failed"
            : "needs_attention",
    attempts,
    limit: ORGANIZATION_ATTEMPTS,
    nextRetryAt: retryable ? (o?.nextRetryAt ?? null) : null,
    error: o?.error ?? null,
    nextAction: o?.verified ? null : !o || retryable ? "resume" : "organize",
  };
}

export function organizationDue(task: Task) {
  const recovery = organizationRecovery(task);
  return (
    recovery?.state === "pending" ||
    (recovery?.state === "retry_pending" &&
      (!recovery.nextRetryAt || Date.parse(recovery.nextRetryAt) <= Date.now()))
  );
}
