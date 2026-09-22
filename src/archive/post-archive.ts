import { existsSync, statSync } from "node:fs";
import { Archive } from "./store.ts";
import { archivePath } from "./schema.ts";
import { sha } from "../hash.ts";
import { State, taskLockName } from "../storage/state.ts";
import { withTaskStateLock } from "../storage/task-lock.ts";
import type { Task } from "../conversation/types.ts";

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

function readTask(root: string, taskId: string) {
  taskLockName(taskId);
  const bytes = new State(root).bytes("task-" + taskId);
  const task = JSON.parse(bytes) as Task;
  if (task.version !== 1) throw new Error("TASK_VERSION_UNSUPPORTED");
  if (task.id !== taskId) throw new Error("TASK_ID_MISMATCH");
  if (!Array.isArray(task.runs)) throw new Error("TASK_RUNS_MISSING");
  return { task, hash: sha(bytes) };
}

/** Reads task documents from SQLite or unmigrated JSON one by one. State.tasks() stays strict, because it participates
 * in the runtime conflict check; a corrupt document must be an item, not a total failure. */
export function scanTasks(root: string) {
  const found: { taskId: string; task: Task; hash: string }[] = [];
  const errors: { taskId: string | null; error: string }[] = [];
  let ids: string[];
  try {
    if (!existsSync(root)) return { found, errors };
    ids = new State(root).taskIds();
  } catch (e) {
    // Source integrity affects coverage, not access to independently archived content.
    errors.push({ taskId: null, error: String(e) });
    return { found, errors };
  }
  for (const taskId of ids) {
    try {
      found.push({ taskId, ...readTask(root, taskId) });
    } catch (e) {
      errors.push({ taskId, error: String(e) });
    }
  }
  return { found, errors };
}

export function taskFileHash(root: string, taskId: string) {
  return sha(new State(root).bytes("task-" + taskId));
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
