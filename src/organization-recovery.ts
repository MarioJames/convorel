import type { Task } from "./conversation.ts";

export const ORGANIZATION_ATTEMPTS = 3;
export const ORGANIZATION_DELAYS = [5000, 30000];

export function organizationRecovery(task: Task) {
  if (!task.naming) return null;
  const o = task.organization;
  const attempts = o?.attempts ?? (o ? 1 : 0);
  // Progress is published before any rename interaction. Never retry an unknown
  // write outcome, a changed target, or an observer whose cleanup is unresolved.
  const transient =
    !o?.rename &&
    /^(?:Error: )?(?:NEEDS_ATTENTION: )?(?:Conversation UI reported an error|METADATA_PAGE_UNAVAILABLE|Fresh conversation metadata unavailable after reload; organization not verified|Conversation metadata request rejected \(HTTP (?:429|5\d\d)\); organization not verified)$/.test(
      o?.error ?? "",
    );
  const retryable =
    !o?.verified &&
    transient &&
    attempts < ORGANIZATION_ATTEMPTS &&
    (!task.organizationObservation ||
      task.organizationObservation.closed === true);
  return {
    state: o?.verified
      ? "verified"
      : !o
        ? "pending"
        : retryable
          ? "retry_pending"
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
