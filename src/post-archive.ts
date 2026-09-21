import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Archive, archivePath, fileHash } from "./archive.ts";
import { sha } from "./workspace.ts";
import { State, taskLockName } from "./state.ts";
import { preference } from "./user-config.ts";
import type { Task } from "./conversation.ts";

/**
 * Archive outcome is reported apart from run state: a rejected write, a full disk or a
 * missing capture must never look like a delivery problem to the caller.
 */
export interface ArchiveNotice {
  status: "stored" | "partial" | "failed" | "unavailable";
  error?: string;
  runs?: number;
  versions?: number;
  gaps?: { runId: string; code: string }[];
  stats?: Record<string, unknown>;
}

function notice(error: unknown): ArchiveNotice {
  const code = (error as any)?.code;
  const text = String(error);
  return {
    status: "failed",
    error:
      typeof code === "string" && code.startsWith("SQLITE")
        ? code + ": " + text.slice(0, 200)
        : "ARCHIVE_FAILED: " + text.slice(0, 200),
  };
}

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

function readTask(root: string, taskId: string) {
  taskLockName(taskId);
  const bytes = readFileSync(join(root, "task-" + taskId + ".json"));
  const task = JSON.parse(bytes.toString("utf8")) as Task;
  if (task.version !== 1) throw new Error("TASK_VERSION_UNSUPPORTED");
  if (task.id !== taskId) throw new Error("TASK_ID_MISMATCH");
  if (!Array.isArray(task.runs)) throw new Error("TASK_RUNS_MISSING");
  return { task, hash: sha(bytes) };
}

/** Reads task documents one by one. State.tasks() stays strict, because it participates
 * in the runtime conflict check; a corrupt file must be an item, not a total failure. */
export function scanTasks(root: string) {
  const found: { taskId: string; task: Task; hash: string }[] = [];
  const errors: { file: string; error: string }[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (e: any) {
    if (e.code === "ENOENT") return { found, errors };
    throw e;
  }
  for (const name of names.sort()) {
    if (!name.startsWith("task-") || !name.endsWith(".json")) continue;
    try {
      const taskId = name.slice(5, -5);
      found.push({ taskId, ...readTask(root, taskId) });
    } catch (e) {
      errors.push({ file: name, error: String(e) });
    }
  }
  return { found, errors };
}

export function taskFileHash(root: string, taskId: string) {
  return fileHash(join(root, "task-" + taskId + ".json"));
}

/** Imports the current source document, not a snapshot taken before acquiring
 * its writer lock. Every failure, including lock contention, is an archive notice. */
export async function publishTask(
  root: string,
  taskId: string,
): Promise<ArchiveNotice> {
  try {
    taskLockName(taskId);
    return await withTaskStateLock(new State(root), taskId, async () =>
      publishSafely(root, taskId),
    );
  } catch (e) {
    return notice(e);
  }
}

/** Caller must already hold withTaskStateLock. Re-read and hash the same durable
 * bytes inside that lock, then project them in one short SQLite transaction.
 * Browser boundaries report failure without turning it into a delivery failure. */
export function publishSafely(root: string, taskId: string): ArchiveNotice {
  let archive: Archive | undefined;
  try {
    const { task, hash } = readTask(root, taskId);
    archive = new Archive(root);
    const result = archive.publish(task, hash);
    const stats = archive.stats();
    archive.close();
    return {
      status: result.gaps.length ? "partial" : "stored",
      runs: result.runs,
      versions: result.versions,
      gaps: result.gaps,
      stats,
    };
  } catch (e) {
    try {
      archive?.close();
    } catch {}
    return notice(e);
  }
}

export type OpenedArchive = {
  archive?: Archive;
  notice?: ArchiveNotice & { status: "failed" | "unavailable" };
};

/**
 * Opens the live archive, or an exported one by path. A read needs no write handle and an
 * exported store is never migrated implicitly; absence from the live path is an outcome.
 */
export function openArchive(
  root: string,
  options: { from?: string; write?: boolean } = {},
): OpenedArchive {
  try {
    if (options.from) {
      // An exported store is addressed by the path given, whether that is the export
      // directory or a snapshot renamed to something else.
      if (!existsSync(options.from))
        return {
          notice: {
            status: "unavailable",
            error: "ARCHIVE_MISSING: " + options.from,
          },
        };
      return {
        archive: new Archive(root, {
          create: false,
          file: statSync(options.from).isDirectory()
            ? archivePath(options.from)
            : options.from,
        }),
      };
    }
    if (options.write) return { archive: new Archive(root) };
    return {
      archive: Archive.available(root)
        ? new Archive(root, { create: false })
        : undefined,
      notice: Archive.available(root)
        ? undefined
        : { status: "unavailable" as const, error: "ARCHIVE_MISSING" },
    };
  } catch (e) {
    return { notice: { ...notice(e), status: "failed" } };
  }
}
