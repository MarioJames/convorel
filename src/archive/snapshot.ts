import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha } from "../hash.ts";
import type { ArchiveStore } from "./context.ts";
import { archivePath } from "./schema.ts";

export function fileHash(path: string) {
  // Raw bytes: decoding as latin1 and re-encoding as utf8 would hash something
  // that is neither the file nor a stable representation of it.
  return sha(readFileSync(path));
}

function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A consistent copy in another directory. Copying the live file would miss committed
 * bytes still held in the WAL, so the snapshot comes from VACUUM INTO. */
export function exportSnapshot(store: ArchiveStore, directory: string) {
  if (!store.writable) throw new Error("ARCHIVE_READONLY");
  const target = archivePath(directory);
  if (existsSync(target)) throw new Error("EXPORT_EXISTS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // VACUUM INTO creates and fills the file itself, so the writing phase is kept behind
  // a directory only this process can enter. The published file inherits 0600 through
  // the link, which leaves no readable window inside a directory with looser modes.
  const staging = join(
    directory,
    ".convorel-export-" + process.pid + "." + randomUUID(),
  );
  mkdirSync(staging, { mode: 0o700 });
  const temporary = join(staging, "conversations.db");
  try {
    store.db.query("vacuum into ?").run(temporary);
    const copy = new Database(temporary);
    try {
      // A standalone copy should not depend on WAL sidecars to open.
      copy.exec("pragma journal_mode = delete");
      const check = (copy.query("pragma integrity_check").get() as any)
        .integrity_check;
      if (check !== "ok") throw new Error("EXPORT_CORRUPT: " + check);
    } finally {
      copy.close();
    }
    chmodSync(temporary, 0o600);
    syncFile(temporary);
    // rename would replace an existing target; a hard link cannot.
    linkSync(temporary, target);
    syncFile(directory);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
    try {
      rmdirSync(staging);
    } catch {}
  }
  return {
    path: target,
    bytes: statSync(target).size,
    sha256: fileHash(target),
    journalMode: "delete",
    permissions: "0600",
  };
}
