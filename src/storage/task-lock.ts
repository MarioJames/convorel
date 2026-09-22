import { State, taskLockName } from "./state.ts";
import { preference } from "../config/preferences.ts";

/** Both browser mutations and explicit imports use this same source lock. The
 * serial-browser escape hatch must serialize imports too. Lock order is source
 * (task/operation), then SQLite; never wait for a source lock with SQLite open. */
export function withTaskStateLock<T>(
  store: State,
  taskId: string,
  fn: () => Promise<T>,
) {
  const taskName = taskLockName(taskId);
  const name = preference("browser.serial") === "true" ? "operation" : taskName;
  const configured = Number(preference("locks.taskWaitMs"));
  const waitMs =
    Number.isSafeInteger(configured) && configured > 0 ? configured : 15_000;
  return store.locked(fn, name, waitMs);
}
