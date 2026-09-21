import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Archive, archivePath, fileHash } from "./archive.ts";
import { sha } from "./workspace.ts";
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
    const file = join(root, name);
    try {
      // One read per document: hashing a second copy could pair content A with the
      // fingerprint of a newer content B.
      const bytes = readFileSync(file);
      const task = JSON.parse(bytes.toString("utf8")) as Task;
      const taskId = name.slice(5, -5);
      if (task.version !== 1) throw new Error("TASK_VERSION_UNSUPPORTED");
      if (task.id !== taskId) throw new Error("TASK_ID_MISMATCH");
      if (!Array.isArray(task.runs)) throw new Error("TASK_RUNS_MISSING");
      found.push({ taskId, task, hash: sha(bytes) });
    } catch (e) {
      errors.push({ file: name, error: String(e) });
    }
  }
  return { found, errors };
}

export function taskFileHash(root: string, taskId: string) {
  return fileHash(join(root, "task-" + taskId + ".json"));
}

/** Imports one task. Every failure stays inside this call. */
export function publishTask(
  root: string,
  task: Task,
  sourceHash: string,
): ArchiveNotice {
  let archive: Archive | undefined;
  try {
    archive = new Archive(root);
    const result = archive.publish(task, sourceHash);
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

/** For a browser boundary that must not fail: reports instead of throwing. */
export function publishSafely(root: string, task: Task) {
  try {
    return publishTask(root, task, taskFileHash(root, task.id));
  } catch (e) {
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
