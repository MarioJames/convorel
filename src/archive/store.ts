import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "../conversation/types.ts";
import type { ArchiveStore } from "./context.ts";
import { ARCHIVE_VERSION, archivePath, migrate, verify } from "./schema.ts";
import * as projection from "./projection.ts";
import * as queries from "./queries.ts";
import * as snapshot from "./snapshot.ts";

export class Archive {
  readonly db: Database;
  readonly path: string;
  private readonly directory: string;
  private writable: boolean;
  /** Built once after the connection opens: the capability handle the projection
   * and query modules work through. The transaction stays owned here. */
  private readonly store: ArchiveStore;
  /** `create: false` reads an existing store, including an exported snapshot, without
   * touching the state directory or running migrations. `file` selects an exact
   * database file, so a renamed snapshot is read rather than its directory. */
  constructor(root: string, options: { create?: boolean; file?: string } = {}) {
    const create = options.create !== false;
    this.path = options.file ?? archivePath(root);
    this.directory = dirname(this.path);
    if (!create && !existsSync(this.path)) throw new Error("ARCHIVE_MISSING");
    this.checkPrivate();
    if (create) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
    }
    // A read-only handle is the post-disaster path: it must not create sidecars,
    // migrate, or depend on the original state directory existing.
    this.db = new Database(
      this.path,
      create ? { create } : { create, readonly: true },
    );
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec("pragma foreign_keys = on");
    this.db.exec("pragma temp_store = memory");
    this.writable = create;
    this.store = this.createStore();
    // This holds content that cannot be rebuilt from the task documents, so durability
    // outranks throughput and deliberately has no override.
    this.db.exec("pragma synchronous = full");
    if (create) this.db.exec("pragma journal_mode = wal");
    this.harden();
    if (create) migrate(this.store);
    else verify(this.store);
  }
  static available(root: string) {
    return existsSync(archivePath(root));
  }
  private createStore(): ArchiveStore {
    return {
      db: this.db,
      path: this.path,
      writable: this.writable,
      one: (sql, ...args) => this.one(sql, ...args),
      all: (sql, ...args) => this.db.query(sql).all(...args) as any[],
      writeTransaction: (work) => this.writeTransaction(work),
      harden: () => this.harden(),
    };
  }
  close() {
    this.db.close();
  }
  private checkPrivate() {
    for (const candidate of [
      this.path,
      this.path + "-wal",
      this.path + "-shm",
    ]) {
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`ARCHIVE_PATH_UNSAFE: ${candidate}`);
    }
  }
  /** The 0700 directory is the primary control; the WAL sidecars are covered too. */
  private harden() {
    if (!this.writable) return;
    for (const suffix of ["", "-wal", "-shm"])
      try {
        chmodSync(this.path + suffix, 0o600);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
  }
  private one(sql: string, ...args: any[]) {
    return this.db.query(sql).get(...args) as any;
  }
  /** Read-then-write projections need write access from the first statement, or two
   * importers can each read the pre-image and one commit loses. */
  private writeTransaction(work: () => void) {
    if (!this.writable) throw new Error("ARCHIVE_READONLY");
    this.db.exec("begin immediate");
    try {
      work();
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }
  publish(task: Task, taskFileHash: string) {
    return projection.publish(this.store, task, taskFileHash);
  }
  search(input: {
    query: string;
    taskId?: string;
    role?: string;
    limit?: number;
  }) {
    return queries.search(this.store, input);
  }
  history(taskId: string, options: { runId?: string } = {}) {
    return queries.history(this.store, taskId, options);
  }
  coverage(task: Task | null, taskFileHash: string | null) {
    return queries.coverage(this.store, task, taskFileHash);
  }
  contentVersion(versionId: string) {
    return queries.contentVersion(this.store, versionId);
  }
  exportSnapshot(directory: string) {
    return snapshot.exportSnapshot(this.store, directory);
  }
  integrity() {
    let fts = "ok";
    try {
      this.db
        .query(
          `insert into content_fts (content_fts, rank)
           values ('integrity-check', 1)`,
        )
        .run();
    } catch (e) {
      fts = String(e);
    }
    return {
      integrity_check: (this.db.query("pragma integrity_check").get() as any)
        .integrity_check,
      fts_integrity_check: fts,
    };
  }
  /** Rebuilds the derived index only; content versions are never regenerated. */
  reindex() {
    if (!this.writable) throw new Error("ARCHIVE_READONLY");
    this.db
      .query("insert into content_fts (content_fts) values ('rebuild')")
      .run();
    this.db
      .query(
        `insert into content_fts (content_fts, rank) values ('integrity-check', 1)`,
      )
      .run();
  }
  stats() {
    const pages = (this.db.query("pragma page_count").get() as any).page_count;
    const pageSize = (this.db.query("pragma page_size").get() as any).page_size;
    return {
      path: this.path,
      archiveVersion: ARCHIVE_VERSION,
      conversations: this.one("select count(*) c from conversation").c,
      tasks: this.one("select count(*) c from task").c,
      runs: this.one("select count(*) c from run").c,
      versions: this.one("select count(*) c from content_version").c,
      markdownVersions: this.one(
        "select count(*) c from content_version where format = 'markdown'",
      ).c,
      bytes: pages * pageSize,
      journalMode: (this.db.query("pragma journal_mode").get() as any)
        .journal_mode,
    };
  }
}
