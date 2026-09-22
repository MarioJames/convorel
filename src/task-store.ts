import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sha } from "./workspace.ts";

// Task documents are authoritative. The content archive is a separate projection.
// Like the archive, this store uses a versioned SQLite schema managed transactionally.
const SCHEMA = `
create table task_document (
  id text primary key,
  document text not null check (json_valid(document)),
  legacy_hash text
);
pragma application_id = 1129600050;
pragma user_version = 1;
`;
const APPLICATION_ID = 1129600050;
type Row = { document: string; legacy_hash: string | null };

export class TaskStore {
  readonly path: string;
  constructor(readonly root: string) {
    this.path = join(root, "tasks.db");
  }
  private use<T>(write: boolean, fn: (db: Database) => T): T {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = this.path + suffix;
      let stat;
      try {
        stat = lstatSync(path);
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("TASK_DB_PATH_UNSAFE");
    }
    if (write && !existsSync(this.path)) this.initialize();
    const db = new Database(
      this.path,
      write ? { readwrite: true } : { readonly: true },
    );
    try {
      db.exec("pragma busy_timeout = 5000");
      const version = (db.query("pragma user_version").get() as any)
        .user_version;
      const kind = (db.query("pragma application_id").get() as any)
        .application_id;
      if (version !== 1 || kind !== APPLICATION_ID)
        throw new Error("TASK_DB_VERSION_OR_KIND_UNSUPPORTED");
      if (write) {
        db.exec("pragma journal_mode = wal");
        db.exec("pragma synchronous = full");
        for (const suffix of ["", "-wal", "-shm"])
          if (existsSync(this.path + suffix))
            chmodSync(this.path + suffix, 0o600);
      }
      return fn(db);
    } finally {
      db.close();
    }
  }
  /** Publish only a fully initialized database; concurrent readers must never see version 0. */
  private initialize() {
    const staging = join(this.root, `.tasks-${randomUUID()}.tmp`);
    closeSync(openSync(staging, "wx", 0o600));
    let db: Database | undefined;
    try {
      db = new Database(staging, { readwrite: true });
      db.exec("pragma synchronous = full");
      db.transaction(() => db!.exec(SCHEMA)).immediate();
      db.close();
      db = undefined;
      const file = openSync(staging, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      try {
        linkSync(staging, this.path);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
      const directory = openSync(this.root, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      db?.close();
      for (const suffix of ["", "-journal"])
        if (existsSync(staging + suffix)) unlinkSync(staging + suffix);
    }
  }
  private checkLegacy(id: string, row: Row) {
    const path = join(this.root, `task-${id}.json`);
    if (row.legacy_hash !== null) {
      if (!existsSync(path) || sha(readFileSync(path)) !== row.legacy_hash)
        throw new Error(
          `LEGACY_TASK_CHANGED: ${id}; stop old writers and reconcile preserved records`,
        );
    } else if (existsSync(path)) {
      throw new Error(
        `TASK_STORAGE_CONFLICT: ${id}; both a new database task and a legacy file exist`,
      );
    }
  }
  read(id: string): string | undefined {
    if (!existsSync(this.path)) return undefined;
    return this.use(false, (db) => {
      const row = db
        .query("select document, legacy_hash from task_document where id = ?")
        .get(id) as Row | null;
      if (!row) return undefined;
      this.checkLegacy(id, row);
      return row.document;
    });
  }
  ids(): string[] {
    if (!existsSync(this.path)) return [];
    return this.use(false, (db) =>
      (
        db.query("select id from task_document order by id").all() as {
          id: string;
        }[]
      ).map((row) => row.id),
    );
  }
  write(id: string, document: string) {
    this.use(true, (db) =>
      db
        .transaction(() => {
          const row = db
            .query(
              "select document, legacy_hash from task_document where id = ?",
            )
            .get(id) as Row | null;
          if (row) this.checkLegacy(id, row);
          else if (existsSync(join(this.root, `task-${id}.json`)))
            throw new Error(
              `TASK_MIGRATION_REQUIRED: ${id}; use conversation migrate --id ${id}`,
            );
          db.query(
            "insert into task_document (id, document) values (?, ?) on conflict(id) do update set document = excluded.document",
          ).run(id, document);
        })
        .immediate(),
    );
  }
  import(id: string, document: string) {
    return this.use(true, (db) =>
      db
        .transaction(() => {
          const row = db
            .query(
              "select document, legacy_hash from task_document where id = ?",
            )
            .get(id) as Row | null;
          if (row) {
            this.checkLegacy(id, row);
            return { id, migrated: false, alreadyStored: true };
          }
          db.query(
            "insert into task_document (id, document, legacy_hash) values (?, ?, ?)",
          ).run(id, document, sha(document));
          return { id, migrated: true, legacyRetained: true };
        })
        .immediate(),
    );
  }
}
