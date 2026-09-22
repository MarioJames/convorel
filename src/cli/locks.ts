import {
  registryLockName,
  type State,
  tabsLockName,
  taskLockName,
} from "../storage/state.ts";
import { watcherLockName } from "../conversation/wait.ts";
import { opts, rejectUnknown, type Printer } from "./args.ts";

export function runRecoverLock(args: string[], store: State, print: Printer) {
  const o = opts(args.slice(1));
  rejectUnknown("recover-lock", Object.keys(o), [
    "task",
    "watch-task",
    "registry",
    "tabs",
    "name",
  ]);
  const selected = (
    ["watch-task", "task", "registry", "tabs", "name"] as const
  ).filter((key) => o[key] !== undefined);
  if (selected.length !== 1)
    throw new Error(
      "LOCK_SELECTOR_REQUIRED: pass exactly one of --task ID, --watch-task ID, --registry true, --tabs true, or --name NAME",
    );
  const selector = selected[0];
  if (
    (selector === "registry" || selector === "tabs") &&
    o[selector] !== "true"
  )
    throw new Error("LOCK_SELECTOR_BOOLEAN: --registry and --tabs take true");
  const name =
    selector === "watch-task"
      ? watcherLockName(o["watch-task"])
      : selector === "task"
        ? taskLockName(o.task)
        : selector === "registry"
          ? registryLockName()
          : selector === "tabs"
            ? tabsLockName()
            : o.name;
  if (!name)
    throw new Error(
      "LOCK_NAME_REQUIRED: pass --task ID | --watch-task ID | --registry true | --tabs true | --name NAME",
    );
  print(store.recoverLock(name));
  return 0;
}
