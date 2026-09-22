import { State } from "./state.ts";
import { browserPacingSettings, MAX_BROWSER_PACING_MS } from "./user-config.ts";

export interface PacingClock {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

const actions = new Set([
  "click",
  "fill",
  "press",
  "focus",
  "select",
  "open",
  "reload",
]);
const key = "browser-pacing";
// Bounded contention: one command has a 25s transport timeout, plus <=10s pacing.
const lockWaitMs = 60_000;

/** Shares only timestamps across CLI instances. The lock spans one action, not
 * a page/session lifecycle; observations never acquire it. */
export class BrowserPacing {
  private readonly store: State;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(root: string, clock: PacingClock = {}) {
    this.store = new State(root);
    this.now = clock.now ?? Date.now;
    this.sleep = clock.sleep ?? ((ms) => Bun.sleep(ms));
  }

  async run<T>(args: string[], execute: () => Promise<T>): Promise<T> {
    const tabAction = args[0] === "tab" && ["new", "close"].includes(args[1]!);
    if (!actions.has(args[0]!) && !tabAction) return execute();
    const navigation =
      ["open", "reload"].includes(args[0]!) ||
      (args[0] === "tab" && args[1] === "new");
    const { actionIntervalMs, navigationWaitMs } = browserPacingSettings();
    const interval = navigation
      ? Math.max(actionIntervalMs, navigationWaitMs)
      : actionIntervalMs;
    let dispatched = false;
    try {
      return await this.store.locked(
        async () => {
          if (this.store.has(key)) {
            const record = this.store.read<{
              version: 1;
              nextActionAt: number;
            }>(key);
            if (
              !Number.isSafeInteger(record.nextActionAt) ||
              record.nextActionAt < 0
            )
              throw new Error("BROWSER_PACING_METADATA_INVALID");
            // Clock skew must not turn a stale private record into an unbounded wait.
            const delay = Math.min(
              MAX_BROWSER_PACING_MS,
              Math.max(0, record.nextActionAt - this.now()),
            );
            if (delay) await this.sleep(delay);
          }
          const recordNext = () =>
            this.store.write(key, {
              version: 1,
              nextActionAt: this.now() + interval,
            });
          // Persist before dispatch as well as after completion (including errors).
          recordNext();
          dispatched = true;
          try {
            return await execute();
          } finally {
            recordNext();
          }
        },
        key,
        lockWaitMs,
      );
    } finally {
      // Keep stabilization outside the lock. Other readers are never delayed;
      // other writers honor the durable timestamp through their own lock.
      if (dispatched && navigation) await this.sleep(navigationWaitMs);
    }
  }
}
