import type { Task } from "./conversation.ts";

/** A projection of durable facts, not a second state machine. */
export function conversationStatus(task: Task) {
  const run = task.runs.find((r) => r.id === task.currentRun);
  if (!run) throw new Error("RUN_MISSING");
  const delivery = run.userMessageId
    ? "confirmed"
    : run.state === "prepared"
      ? "not_attempted"
      : "unknown";
  let phase: string, nextAction: string;
  if (run.state === "complete") {
    phase = "complete";
    nextAction = "result";
  } else if (run.observationError) {
    phase = run.observationError.retryable
      ? "observation_interrupted"
      : "needs_attention";
    nextAction = run.observationError.retryable ? "resume" : "inspect";
  } else if (run.state === "prepared") {
    phase = "before_send";
    nextAction = run.error ? "inspect" : "retry";
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
    delivery,
    phase,
    nextAction,
    lastObservedAt: run.lastObservedAt ?? null,
    observationError: run.observationError ?? null,
    error: run.error ?? null,
  };
}

export function conversationExitCode(
  task: Task,
  operation: "start" | "resume",
) {
  const summary = conversationStatus(task);
  if (summary.state === "complete") return 0;
  // start confirms submission; resume confirms completion. A readable status alone is not completion.
  return operation === "start" &&
    summary.state === "waiting" &&
    !summary.observationError
    ? 0
    : 2;
}
