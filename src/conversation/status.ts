import { organizationRecovery } from "./organization-recovery.ts";
import type { Task } from "./types.ts";

/** A projection of durable facts, not a second state machine. */
export function conversationStatus(task: Task) {
  const run = task.runs.find((r) => r.id === task.currentRun);
  if (!run) throw new Error("RUN_MISSING");
  const delivery = run.userMessageId
    ? "confirmed"
    : run.state === "prepared"
      ? "not_attempted"
      : "unknown";
  const organization = organizationRecovery(task);
  let phase: string, nextAction: string;
  if (run.state === "complete") {
    if (run.reply && !run.reply.markdown) {
      phase = "capture_pending";
      nextAction = "capture";
    } else if (task.archive && task.archive.status !== "stored") {
      phase = "archive_pending";
      nextAction = "archive";
    } else {
      phase =
        organization && organization.state !== "verified"
          ? "organization_pending"
          : "complete";
      nextAction = organization?.nextAction ?? "result";
    }
    if (
      phase === "complete" &&
      task.organizationObservation &&
      !task.organizationObservation.closed
    ) {
      phase = "cleanup_pending";
      nextAction = "finish";
    }
  } else if (run.observationError) {
    phase = run.observationError.retryable
      ? "observation_interrupted"
      : "needs_attention";
    nextAction = run.observationError.retryable ? "resume" : "inspect";
  } else if (run.state === "prepared") {
    phase = "before_send";
    nextAction = run.error ? "inspect" : "start";
  } else if (["submitting", "delivery_unknown"].includes(run.state)) {
    phase = "confirming_delivery";
    nextAction = "resume";
  } else if (run.state === "waiting") {
    phase =
      run.userMessageId && task.url ? "awaiting_reply" : "confirming_delivery";
    nextAction = "wait";
  } else {
    phase = "needs_attention";
    nextAction = "inspect";
  }
  return {
    id: task.id,
    runId: run.id,
    workspace: task.config.workspace,
    workspaceId: task.workspaceId,
    state: run.state,
    replyComplete: run.state === "complete",
    delivery,
    phase,
    nextAction,
    // Each task records the browser tab it owns; exposed so callers can see
    // which tab is theirs and whether it is currently free to contend for.
    tab: task.binding
      ? {
          target: task.binding.target,
          epoch: task.binding.epoch,
          owned: task.binding.owned,
          closed: !!task.binding.closed,
        }
      : null,
    detachedTabs: task.detachedBindings ?? [],
    lastObservedAt: run.lastObservedAt ?? null,
    observationError: run.observationError ?? null,
    error: run.error ?? null,
    organization,
    completionProbe: run.completionProbe ?? null,
    cleanup: task.cleanup ?? null,
    observerCleanup: task.organizationObservation ?? null,
    ...(task.archive ? { archive: task.archive } : {}),
  };
}

export function conversationExitCode(
  task: Task,
  operation: "start" | "resume",
) {
  const summary = conversationStatus(task);
  if (summary.state === "complete")
    return operation === "resume" && summary.phase !== "complete" ? 2 : 0;
  // start confirms submission; resume confirms completion. A readable status alone is not completion.
  return operation === "start" &&
    summary.state === "waiting" &&
    !summary.observationError
    ? 0
    : 2;
}
