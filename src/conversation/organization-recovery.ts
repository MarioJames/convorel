import type { Task } from "./types.ts";

export function organizationRecovery(task: Task) {
  if (!task.naming) return null;
  const o = task.organization;
  const attempts = o?.attempts ?? (o ? 1 : 0);
  // After save dispatch recovery only reads persisted metadata. An interrupted
  // edit (or a legacy checkpoint without a phase) is never replayed.
  const verificationOnly = ["save_pending", "verifying"].includes(o?.phase);
  const retryable = organizationCheckpointDue(task);
  const previous = o?.lastVerified;
  const revalidation =
    previous?.naming &&
    previous.naming.type === task.naming.type &&
    previous.naming.topic === task.naming.topic &&
    previous.naming.language === (task.naming.language ?? "en");
  return {
    title: o?.title ?? o?.rename?.title ?? null,
    requested: task.naming,
    startedAt: o?.startedAt ?? null,
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
    retryAt: retryable || !o ? "wait_return" : null,
    error: o?.error ?? null,
    nextAction: o?.verified ? null : !o || retryable ? "wait" : "organize",
  };
}

/** Each lifecycle checkpoint gets one fresh attempt before any title write.
 * A stale reply/composer observation must not permanently exhaust naming.
 * Interrupted edits and rejected/ambiguous writes still require inspection. */
export function organizationCheckpointDue(task: Task) {
  if (!task.naming || task.organization?.verified || !task.url) return false;
  const o = task.organization;
  if (o?.phase === "editing" || (!o?.phase && o?.rename)) return false;
  if (
    /HTTP (?:401|403)|Login required|Human verification|Project membership does not match|CONVERSATION_CHANGED|TARGET_NAVIGATED|METADATA_PAGE_CHANGED|ORGANIZATION_SAVE_UNCONFIRMED|Title save was not acknowledged|DRAFT_PRESENT|ATTACHMENTS_PRESENT/.test(
      o?.error ?? "",
    )
  )
    return false;
  if (o?.phase)
    return ["metadata", "locating", "save_pending", "verifying"].includes(
      o.phase,
    );
  // Legacy failures without a write phase need positive pre-write evidence.
  return (
    !o?.error ||
    /^(?:Error: )?(?:PAGE_NOT_IDLE|COMPLETED_TURN_CHANGED|METADATA_PAGE_UNAVAILABLE|NEEDS_ATTENTION: Conversation UI reported an error|Conversation UI reported an error|Target conversation not visible in sidebar|Fresh conversation metadata unavailable|Conversation metadata request rejected|BROWSER_READ_FAILED|CDP_UNAVAILABLE)/.test(
      o.error,
    )
  );
}
