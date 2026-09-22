import { resolve } from "node:path";
import {
  openArchive,
  type OpenedArchive,
  publishTask,
  scanTasks,
} from "../archive/post-archive.ts";
import { required } from "../command.ts";
import type { Printer } from "./args.ts";

export const archiveCommands = [
  "archive",
  "history",
  "search",
  "content",
  "export",
];

// The archive surface reads and writes only private state, so it is dispatched before
// the config, workspace and browser prerequisites: a deleted project or a stopped
// Chrome must not block reading back what was recorded.
export async function runArchive(
  sub: string,
  o: Record<string, string>,
  stateRoot: string,
  assertOutsideSharedRoots: (path: string) => void,
  print: Printer,
) {
  if (sub === "archive") {
    if (o.all !== undefined && !["true", "false"].includes(o.all))
      throw new Error("ARCHIVE_ALL_BOOLEAN: --all takes true or false");
    // Exactly one scope, read as a boolean: a truthy string such as "false" must not
    // turn a single-task import into an import of every task.
    const all = o.all === "true";
    if (all === !!o.id)
      throw new Error("ARCHIVE_SCOPE_REQUIRED: pass --id ID or --all true");
    assertOutsideSharedRoots(stateRoot);
    const scanned = scanTasks(stateRoot);
    const selected = all
      ? scanned.found
      : scanned.found.filter((item) => item.taskId === o.id);
    if (o.id && !selected.length)
      throw new Error(
        scanned.errors.some(
          (error) => error.taskId === o.id || error.taskId === null,
        )
          ? "TASK_UNREADABLE: inspect sourceErrors"
          : "TASK_NOT_FOUND",
      );
    const archived = [];
    for (const item of selected) {
      archived.push({
        taskId: item.taskId,
        ...(await publishTask(stateRoot, item.taskId)),
      });
    }
    const opened = openArchive(stateRoot, { write: true });
    const summary = opened.archive ? opened.archive.stats() : opened.notice;
    opened.archive?.close();
    print({
      scope: all ? "all" : o.id,
      archived,
      sourceErrors: scanned.errors,
      unreadable: scanned.errors.length > 0,
      summary,
    });
    return opened.notice || archived.some((item) => item.status === "failed")
      ? 1
      : archived.some((item) => item.status === "partial") ||
          scanned.errors.length > 0
        ? 2
        : 0;
  }
  if (sub === "export") {
    const directory = required(o, "directory");
    // An export carries every archived prompt and reply, so it neither lands inside a
    // directory the connected assistant can already read nor replaces the state store.
    assertOutsideSharedRoots(stateRoot);
    if (resolve(directory) === resolve(stateRoot))
      throw new Error("EXPORT_TARGET_IS_STATE_DIRECTORY");
    assertOutsideSharedRoots(directory);
    const opened = openArchive(stateRoot, { write: true });
    if (opened.notice || !opened.archive) {
      print({
        notice: opened.notice ?? {
          status: "failed",
          error: "ARCHIVE_UNOPENABLE",
        },
      });
      return 1;
    }
    try {
      print({
        status: "stored",
        ...opened.archive.exportSnapshot(directory),
      });
    } finally {
      opened.archive.close();
    }
    return 0;
  }
  const opened: OpenedArchive = openArchive(stateRoot, { from: o.from });
  if (opened.notice || !opened.archive) {
    print({
      notice: opened.notice ?? {
        status: "failed",
        error: "ARCHIVE_UNOPENABLE",
      },
    });
    return 1;
  }
  const archive = opened.archive!;
  try {
    if (sub === "search") {
      const source =
        o.task && !o.from
          ? scanTasks(stateRoot).found.find((item) => item.taskId === o.task)
          : undefined;
      print({
        source: o.from ?? stateRoot,
        query: required(o, "query"),
        hits: archive.search({
          query: o.query!,
          taskId: o.task,
          role: o.role as "user" | "assistant" | undefined,
          limit: o.limit === undefined ? undefined : Number(o.limit),
        }),
        // Counts describe the store. Coverage is a claim about one task document, so
        // it is only made when that document can be compared with the archive.
        stats: archive.stats(),
        coverage: o.task
          ? archive.coverage(source?.task ?? null, source?.hash ?? null)
          : null,
      });
      return 0;
    }
    if (sub === "content") {
      print({
        source: o.from ?? stateRoot,
        version: archive.contentVersion(required(o, "version")),
      });
      return 0;
    }
    const id = required(o, "id");
    const view = archive.history(id, { runId: o.run });
    const source =
      !o.from && o.coverage !== "false"
        ? scanTasks(stateRoot).found.find((item) => item.taskId === id)
        : undefined;
    print({
      source: o.from ?? stateRoot,
      ...view,
      coverage:
        o.coverage === "false"
          ? null
          : archive.coverage(source?.task ?? null, source?.hash ?? null),
    });
    return 0;
  } finally {
    archive.close();
  }
}
