import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Archive } from "../../src/archive/store.ts";
import { openArchive } from "../../src/archive/post-archive.ts";
import { sha } from "../../src/hash.ts";
import { taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("an exported snapshot stands alone and refuses overwrite or impersonation", () => {
  const a = new Archive(root);
  a.publish(taskDoc(), "fh-1");
  const backup = join(base, "backup");
  const snapshot = a.exportSnapshot(backup);
  expect(snapshot.bytes).toBeGreaterThan(0);
  expect(snapshot.journalMode).toBe("delete");
  expect(lstatSync(backup + "/conversations.db").mode & 0o777).toBe(0o600);
  // Only the snapshot stays behind: the staging directory is this call's own scratch.
  expect(readdirSync(backup)).toEqual(["conversations.db"]);
  // The checksum must be the file's own bytes, so an independent sha256sum matches.
  expect(snapshot.sha256).toBe(sha(readFileSync(snapshot.path)));
  expect(() => a.exportSnapshot(backup)).toThrow("EXPORT_EXISTS");
  const reopened = new Archive(backup, { create: false });
  expect(reopened.history("review").turns.length).toBe(1);
  expect(reopened.search({ query: "防枚举" }).length).toBe(1);
  expect(() => reopened.exportSnapshot(join(base, "again"))).toThrow(
    "ARCHIVE_READONLY",
  );
  reopened.close();
  a.close();
  // A renamed snapshot is read at the path given, not at its directory's default name.
  const renamed = join(base, "backup", "review-2026-09-21.db");
  linkSync(join(backup, "conversations.db"), renamed);
  const byFile = openArchive(root, { from: renamed });
  expect(byFile.notice).toBeUndefined();
  expect(byFile.archive?.path).toBe(renamed);
  expect(byFile.archive?.search({ query: "防枚举" }).length).toBe(1);
  byFile.archive?.close();
  const imposter = join(base, "imposter");
  mkdirSync(imposter);
  new Database(join(imposter, "conversations.db")).exec(
    "create table something(a)",
  );
  expect(() => new Archive(imposter, { create: false })).toThrow(
    "NOT_A_CONVOREL_ARCHIVE",
  );
  // Opening a foreign file for writing must not extend it into a half-Convorel store.
  expect(() => new Archive(imposter)).toThrow(
    "NOT_A_CONVOREL_ARCHIVE: database already holds other objects",
  );
  const wrongKind = join(base, "wrong-kind");
  mkdirSync(wrongKind);
  const foreign = new Database(join(wrongKind, "conversations.db"));
  foreign.exec("create table meta (key text primary key, value text not null)");
  foreign
    .query("insert into meta (key, value) values ('dbKind', 'other-app-db')")
    .run();
  foreign.close();
  expect(() => new Archive(wrongKind, { create: false })).toThrow(
    "NOT_A_CONVOREL_ARCHIVE: dbKind",
  );
  const linked = join(base, "linked");
  mkdirSync(linked);
  symlinkSync(join(root, "conversations.db"), join(linked, "conversations.db"));
  expect(() => new Archive(linked)).toThrow("ARCHIVE_PATH_UNSAFE");
});
