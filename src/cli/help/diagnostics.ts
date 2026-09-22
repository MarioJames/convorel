import { fields, page } from "./shared.ts";

export const diagnosticsPage = page(
  ["diagnostics"],
  ["diagnostics --task ID [--run UUID] [--fields LIST]"],
  "Read one task's diagnostic events from the private diagnostics database. Chrome is not opened.",
  [
    ["--task ID", "Task whose events are read."],
    ["--run UUID", "Limit events to one run. The id must be a UUID."],
    fields,
  ],
  [
    "status is missing when the database is absent, empty when the task has no rows, and ok when rows were read. complete is always false: the rows are not a full history and do not authorize a retry or another send.",
    "diagnostics.enabled unset or true records events. false disables recording. Any other stored value, or a failed preference read, also disables it. An unreadable database exits 1 instead of looking like an empty task.",
  ],
);
