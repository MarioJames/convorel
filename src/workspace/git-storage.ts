import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

/** Check metadata only, once per observation: packed repositories stay cheap. */
export function checkGitObjects(objects: string) {
  const started = Date.now();
  let entries = 0;
  const visit = (path: string, depth: number) => {
    if (++entries > 200_000 || depth > 8 || Date.now() - started > 2000)
      throw new Error("GIT_STORAGE_SCAN_LIMIT");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error("GIT_STORAGE_LINK_DENIED");
    if (stat.isFile()) return;
    if (!stat.isDirectory()) throw new Error("GIT_STORAGE_NOT_REGULAR");
    const dir = opendirSync(path);
    try {
      let entry;
      while ((entry = dir.readSync())) visit(join(path, entry.name), depth + 1);
    } finally {
      dir.closeSync();
    }
  };
  try {
    visit(objects, 0);
  } catch (error: any) {
    if (error.message?.startsWith("GIT_STORAGE_")) throw error;
    // Disappearing/unreadable files must not be mistaken for a validated store.
    throw new Error("GIT_STORAGE_UNREADABLE");
  }
}
