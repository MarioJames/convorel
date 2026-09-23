import { Database } from "bun:sqlite";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** A synchronous, cross-process mutex for short read/modify/write operations.
 * The dedicated SQLite file contains no business data and MUST NOT be unlinked
 * or replaced: all participants must lock the same inode. BEGIN IMMEDIATE uses
 * SQLite's OS-backed writer lock, released even if the process is killed.
 * Callbacks must not yield, return promises, or recursively acquire this lock.
 * This serializes side effects; it does not roll back the callback's writes.
 */
export function withSyncLock<T>(
  path: string,
  fn: () => T,
  timeoutMs = 5000,
): T {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2147483647
  )
    throw new Error("SYNC_LOCK_TIMEOUT_INVALID");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("SYNC_LOCK_PATH_UNSAFE");
  // Do not open/close an extra fd for an existing file: POSIX record locks can
  // be released when any fd for that inode is closed in the same process.
  const db = new Database(path, { readwrite: true });
  try {
    db.exec(`pragma busy_timeout = ${timeoutMs}`);
    db.exec("begin immediate");
    try {
      const value = fn();
      if (value && typeof (value as any).then === "function")
        throw new Error("SYNC_LOCK_CALLBACK_ASYNC");
      return value;
    } finally {
      db.exec("rollback");
    }
  } finally {
    db.close();
  }
}
