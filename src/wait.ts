import { setTimeout as sleep } from "node:timers/promises";
import type { Conversation } from "./conversation.ts";
import type { State } from "./state.ts";
import { ObservationError } from "./browser.ts";
import { conversationStatus } from "./conversation-status.ts";

export function watcherLockName(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("INVALID_TASK_ID");
  return "watch-" + id;
}

export async function waitForConversation(
  store: State,
  conversation: Pick<Conversation, "poll" | "get">,
  id: string,
  run: string,
  seconds: number,
  signal: AbortSignal,
  report: (value: unknown) => void,
) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
    throw new Error("INVALID_TIMEOUT");
  return store.locked(async () => {
    const deadline = Date.now() + seconds * 1000;
    let observationFailures = 0;
    let lastSummary: ReturnType<typeof conversationStatus> | undefined;
    while (!signal.aborted && Date.now() < deadline) {
      let t;
      try {
        t = await conversation.poll(id, run);
        observationFailures = 0;
      } catch (e) {
        if (!(e instanceof ObservationError)) throw e;
        t = conversation.get(id);
        if (t.currentRun !== run) throw new Error("STALE_RUN");
        observationFailures++;
        report({
          ...conversationStatus(t),
          observationRetry: { attempt: observationFailures, limit: 3 },
          nextAction: observationFailures >= 3 ? "inspect" : "resume",
          error: String(e),
        });
        if (observationFailures >= 3) return 2;
        try {
          await sleep(
            Math.min(
              observationFailures * 1000,
              Math.max(1, deadline - Date.now()),
            ),
            undefined,
            { signal },
          );
        } catch (e: any) {
          if (e.name !== "AbortError") throw e;
        }
        continue;
      }
      const r = t.runs.find((r) => r.id === run);
      if (t.currentRun !== run || !r) throw new Error("STALE_RUN");
      const summary = conversationStatus(t);
      lastSummary = summary;
      report(summary);
      const retryNaming = summary.organization?.state === "retry_pending";
      if (r.state === "complete" && !retryNaming)
        return (summary.organization &&
          summary.organization.state !== "verified") ||
          summary.phase === "cleanup_pending"
          ? 2
          : 0;
      if (
        !["waiting", "complete", "submitting", "delivery_unknown"].includes(
          r.state,
        )
      )
        return 2;
      const delay = retryNaming
        ? Math.max(
            1,
            Date.parse(
              summary.organization!.nextRetryAt ?? new Date().toISOString(),
            ) - Date.now(),
          )
        : ["submitting", "delivery_unknown"].includes(r.state)
          ? 1000
          : 60000;
      try {
        await sleep(
          Math.min(delay, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
      } catch (e: any) {
        if (e.name !== "AbortError") throw e;
      }
    }
    report({
      ...lastSummary,
      id,
      runId: run,
      runState: lastSummary?.state ?? null,
      state: signal.aborted ? "cancelled" : "timeout",
      remoteGenerationStopped: false,
    });
    return 2;
  }, watcherLockName(id));
}
