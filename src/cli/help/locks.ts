import { page } from "./shared.ts";

export const recoverLockPage = page(
  ["recover-lock"],
  [
    "recover-lock --task ID | --watch-task ID | --registry true | --tabs true | --name NAME",
  ],
  "Remove one lock whose recorded process is gone. A live owner's lock is kept.",
  [
    ["--task ID", "Recover that task's operation lock."],
    ["--watch-task ID", "Recover that task's wait lock."],
    [
      "--registry true",
      "Recover the registry lock. The only accepted value is true.",
    ],
    [
      "--tabs true",
      "Recover the tab-accounting lock. The only accepted value is true.",
    ],
    ["--name NAME", "Recover one named lock."],
  ],
  [
    "Pass exactly one selector. A second selector is an error, not a priority rule. This command does not recover the tunnel client's lock; use tunnel recover-lock for that.",
  ],
);
