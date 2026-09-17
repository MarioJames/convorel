import { setTimeout as sleep } from "node:timers/promises";
import type { Conversation } from "./conversation.ts";
import type { State } from "./state.ts";

export function watcherLockName(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("INVALID_TASK_ID");
  return "watch-" + id;
}

export async function waitForConversation(
  store: State,
  conversation: Pick<Conversation, "poll">,
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
    while (!signal.aborted && Date.now() < deadline) {
      const t = await conversation.poll(id, run);
      const r = t.runs.find((r) => r.id === run);
      if (t.currentRun !== run || !r) throw new Error("STALE_RUN");
      report({ id, runId: run, state: r.state, error: r.error });
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
