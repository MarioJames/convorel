import { setTimeout as sleep } from "node:timers/promises";
import type { Conversation } from "./conversation.ts";
import type { State } from "../storage/state.ts";
import { ObservationError } from "../browser/browser.ts";
import { conversationStatus } from "./status.ts";

export function watcherLockName(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("INVALID_TASK_ID");
  return "watch-" + id;
}

function retryableObservation(error: unknown) {
  return (
    error instanceof ObservationError ||
    /^Error: LOCK_BUSY: (?:task-|operation;|registry;|tabs;)/.test(
      String(error),
    )
  );
}

export async function waitForConversation(
  store: State,
  conversation: Pick<Conversation, "poll" | "get"> &
    Partial<Pick<Conversation, "ensureNaming">>,
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
    const namingCheckpoint = async () => {
      if (
        signal.aborted ||
        !conversation.ensureNaming ||
        !lastSummary?.organization
      )
        return;
      const t = await conversation.ensureNaming(id, run);
      if (t.currentRun !== run) throw new Error("STALE_RUN");
      lastSummary = conversationStatus(t);
      report(lastSummary);
    };
    while (!signal.aborted && Date.now() < deadline) {
      let t;
      try {
        t = await conversation.poll(id, run);
        observationFailures = 0;
      } catch (e) {
        if (!retryableObservation(e)) throw e;
        t = conversation.get(id);
        if (t.currentRun !== run) throw new Error("STALE_RUN");
        lastSummary = conversationStatus(t);
        observationFailures++;
        const delay = Math.min(
          30_000,
          500 * 2 ** Math.min(observationFailures - 1, 6),
        );
        report({
          ...conversationStatus(t),
          observationRetry: {
            attempt: observationFailures,
            nextDelayMs: delay,
          },
          nextAction: "resume",
          error: String(e),
        });
        try {
          await sleep(
            Math.min(delay, Math.max(1, deadline - Date.now())),
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
      if (r.state === "complete") {
        await namingCheckpoint();
        const final = lastSummary!;
        return final.phase !== "complete" ? 2 : 0;
      }
      if (
        !["waiting", "complete", "submitting", "delivery_unknown"].includes(
          r.state,
        )
      ) {
        await namingCheckpoint();
        return 2;
      }
      const delay = summary.phase === "confirming_delivery" ? 1000 : 60000;
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
    await namingCheckpoint();
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
