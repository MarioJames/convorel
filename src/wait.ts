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
      report(conversationStatus(t));
      if (r.state === "complete") return 0;
      if (r.state !== "waiting") return 2;
      try {
        await sleep(
          Math.min(60000, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
      } catch (e: any) {
        if (e.name !== "AbortError") throw e;
      }
    }
    report({
      id,
      runId: run,
      state: signal.aborted ? "cancelled" : "timeout",
      remoteGenerationStopped: false,
    });
    return 2;
  }, watcherLockName(id));
}
