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
        if (!(e instanceof ObservationError)) throw e;
        t = conversation.get(id);
        if (t.currentRun !== run) throw new Error("STALE_RUN");
        lastSummary = conversationStatus(t);
        observationFailures++;
        report({
          ...conversationStatus(t),
          observationRetry: { attempt: observationFailures, limit: 3 },
          nextAction: observationFailures >= 3 ? "inspect" : "resume",
          error: String(e),
        });
        if (observationFailures >= 3) {
          await namingCheckpoint();
          report({
            ...lastSummary,
            observationRetry: { attempt: observationFailures, limit: 3 },
            nextAction: "inspect",
            error: String(e),
          });
          return 2;
        }
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
      if (r.state === "complete") {
        await namingCheckpoint();
        const final = lastSummary!;
        return (final.organization &&
          final.organization.state !== "verified") ||
          final.phase === "cleanup_pending"
          ? 2
          : 0;
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
