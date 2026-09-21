import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { conversationId } from "./chatgpt/page.ts";
import { sha } from "./workspace.ts";
import type { Run, Task } from "./conversation.ts";

export const ARCHIVE_VERSION = 1;
export const archivePath = (root: string) => join(root, "conversations.db");
/** Refuses another application's SQLite file, which a version number cannot tell apart. */
export const DB_KIND = "convorel-conversation-db";
/** FTS5 trigram needs three code points; shorter queries scan literally instead. */
const MATCH_MIN = 3;
const SNIPPET_TOKENS = 32;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const QUERY_MAX_BYTES = 512;
export const FINGERPRINT_VERSION = 1;

const SCHEMA = `
create table workspace (
  id text primary key,
  root text not null,
  first_seen_at text not null,
  last_seen_at text not null
);
create table conversation (
  id integer primary key,
  provider text not null default 'chatgpt',
  scope text not null default '',
  remote_id text not null,
  url text,
  workspace_id text references workspace (id),
  project_name text,
  opened_at text,
  closed_at text,
  unique (provider, scope, remote_id)
);
create table task (
  id text primary key,
  conversation_id integer references conversation (id),
  workspace_id text references workspace (id),
  naming_type text,
  topic text,
  state text not null,
  origin text not null,
  first_run_at text,
  updated_at text not null
);
create table run (
  id text primary key,
  task_id text not null references task (id) on delete cascade,
  seq integer not null,
  request_key text not null,
  state text not null,
  observed_model text,
  created_at text,
  submitted_at text,
  last_observed_at text,
  error text,
  unique (task_id, seq),
  unique (task_id, request_key)
);
-- Immutable content: a regenerated or re-captured reply becomes a new version,
-- because earlier versions are already cited by callers.
create table content_version (
  id integer primary key,
  version_id text not null unique,
  task_id text not null references task (id) on delete cascade,
  run_id text not null references run (id) on delete cascade,
  role text not null,
  message_key text not null,
  format text not null,
  text text not null,
  content_hash text not null,
  source text not null,
  captured_at text not null,
  superseded_at text,
  supersedes text references content_version (version_id),
  unique (task_id, run_id, role, message_key, format, content_hash)
);
-- Which version represents the run, and what the capture still lacks.
create table run_selection (
  run_id text primary key references run (id) on delete cascade,
  task_id text not null references task (id) on delete cascade,
  prompt_version_id text references content_version (version_id),
  reply_version_id text references content_version (version_id),
  rendered_version_id text references content_version (version_id),
  capture_status text not null,
  capture_error text,
  last_capture_attempt_at text,
  source_reply_hash text,
  content_fingerprint text not null,
  task_file_hash text,
  indexed_at text not null
);
create table meta (key text primary key, value text not null);
create index run_task on run (task_id);
create index content_task on content_version (task_id, run_id);
create index selection_task on run_selection (task_id);
create virtual table content_fts using fts5 (
  text,
  content='content_version',
  content_rowid='id',
  tokenize='trigram case_sensitive 0',
  detail='full'
);
create trigger content_version_ai after insert on content_version begin
  insert into content_fts (rowid, text) values (new.id, new.text);
end;
create trigger content_version_ad after delete on content_version begin
  insert into content_fts (content_fts, rowid, text)
  values ('delete', old.id, old.text);
end;
`;

/** A search term is one literal phrase: NEAR, wildcards and quotes are not syntax a
 * caller gets to inject. */
export function literalQuery(input: string) {
  const query = input.trim();
  if (!query || query.includes("\0")) throw new Error("INVALID_SEARCH_QUERY");
  if (Buffer.byteLength(query) > QUERY_MAX_BYTES)
    throw new Error("SEARCH_QUERY_TOO_LONG");
  const codePoints = [...query].length;
  return {
    query,
    codePoints,
    engine: codePoints < MATCH_MIN ? "literal-scan" : "trigram",
    match: '"' + query.replaceAll('"', '""') + '"',
  };
}

/** Only facts that change the archived content. Attempt, binding, cleanup and
 * observation time move on their own and must not look like content drift. */
export function runContentFingerprint(
  taskId: string,
  remoteId: string | null,
  run: Run,
) {
  return sha(
    JSON.stringify({
      version: FINGERPRINT_VERSION,
      taskId,
      runId: run.id,
      remoteId,
      promptHash: run.promptHash ?? null,
      userMessageId: run.userMessageId ?? null,
      replyId: run.reply?.id ?? null,
      renderedHash: run.replyHash ?? null,
    }),
  );
}

function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fileHash(path: string) {
  // Raw bytes: decoding as latin1 and re-encoding as utf8 would hash something
  // that is neither the file nor a stable representation of it.
  return sha(readFileSync(path));
}

export class Archive {
  readonly db: Database;
  readonly path: string;
  private readonly directory: string;
  private writable: boolean;
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
    // This holds content that cannot be rebuilt from the task documents, so durability
    // outranks throughput and deliberately has no override.
    this.db.exec("pragma synchronous = full");
    if (create) this.db.exec("pragma journal_mode = wal");
    this.harden();
    if (create) this.migrate();
    else this.verify();
  }
  static available(root: string) {
    return existsSync(archivePath(root));
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
  private verify() {
    // A missing table is a foreign file, not a database that needs repairing.
    if (
      !this.one(
        "select 1 from sqlite_master where name = 'meta' and type = 'table'",
      )
    )
      throw new Error("NOT_A_CONVOREL_ARCHIVE");
    const kind = this.one("select value from meta where key = 'dbKind'");
    if (kind?.value !== DB_KIND)
      throw new Error(
        "NOT_A_CONVOREL_ARCHIVE: dbKind is " +
          JSON.stringify(kind?.value ?? null),
      );
    const version = (this.db.query("pragma user_version").get() as any)
      .user_version as number;
    if (version < 1 || version > ARCHIVE_VERSION)
      throw new Error(`ARCHIVE_VERSION_UNSUPPORTED: found ${version}`);
  }
  /** BEGIN IMMEDIATE takes write access up front, so two first-run processes cannot
   * both create the schema. */
  private migrate() {
    const version = (this.db.query("pragma user_version").get() as any)
      .user_version as number;
    if (version > ARCHIVE_VERSION)
      throw new Error(`ARCHIVE_VERSION_UNSUPPORTED: found ${version}`);
    if (version === ARCHIVE_VERSION) return this.verify();
    // A zero-version file that already holds someone else's tables is a foreign
    // database; extending it would leave a half-Convorel store behind.
    if (
      this.one(
        `select name from sqlite_master
         where type in ('table','view','index','trigger') and name not like 'sqlite_%'
         limit 1`,
      )
    )
      throw new Error(
        "NOT_A_CONVOREL_ARCHIVE: database already holds other objects",
      );
    this.db.exec("begin immediate");
    try {
      if (!this.one("select 1 from sqlite_master where name = 'meta'")) {
        this.db.exec(SCHEMA);
        this.db
          .query("insert into meta (key, value) values ('dbKind', ?)")
          .run(DB_KIND);
        this.db
          .query("insert into meta (key, value) values ('createdAt', ?)")
          .run(new Date().toISOString());
      }
      this.db.exec("pragma user_version = " + ARCHIVE_VERSION);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    this.harden();
  }
  close() {
    this.db.close();
  }
  private one(sql: string, ...args: any[]) {
    return this.db.query(sql).get(...args) as any;
  }
  private all(sql: string, ...args: any[]) {
    return this.db.query(sql).all(...args) as any[];
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
  private upsertWorkspace(root: string, id: string, at: string) {
    if (this.one("select id from workspace where id = ?", id))
      this.db
        .query("update workspace set last_seen_at = ? where id = ?")
        .run(at, id);
    else
      this.db
        .query(
          `insert into workspace (id, root, first_seen_at, last_seen_at)
           values (?, ?, ?, ?)`,
        )
        .run(id, root, at, at);
  }
  /** The remote conversation identity is the trailing id; `scope` keeps the project
   * prefix so a project conversation and a plain one never collide. */
  private upsertConversation(task: Task, at: string) {
    const remoteId = remoteConversationId(task);
    if (!task.url || !remoteId) return null;
    const scope = task.url.slice(
      0,
      task.url.length - remoteId.length - "/c/".length,
    );
    const existing = this.one(
      `select id from conversation
       where provider = 'chatgpt' and scope = ? and remote_id = ?`,
      scope,
      remoteId,
    );
    if (existing) {
      this.db
        .query(
          `update conversation set url = ?, workspace_id = ?, project_name = ?,
           closed_at = null where id = ?`,
        )
        .run(
          task.url,
          task.workspaceId,
          task.config.projectName ?? null,
          existing.id,
        );
      return existing.id as number;
    }
    const created = this.one(
      `insert into conversation (provider, scope, remote_id, url, workspace_id,
        project_name, opened_at)
       values ('chatgpt', ?, ?, ?, ?, ?, ?) returning id`,
      scope,
      remoteId,
      task.url,
      task.workspaceId,
      task.config.projectName ?? null,
      task.runs[0]?.createdAt ?? at,
    );
    return created.id as number;
  }
  /** Inserts a content version or returns the existing one. Existing bytes are never
   * rewritten; a different answer appends a version and supersedes the previous one. */
  private addVersion(
    task: Task,
    runId: string,
    role: string,
    messageKey: string,
    format: string,
    text: string,
    source: string,
    at: string,
  ) {
    const contentHash = sha(text);
    const known = this.one(
      `select version_id from content_version
       where task_id = ? and run_id = ? and role = ? and message_key = ?
         and format = ? and content_hash = ?`,
      task.id,
      runId,
      role,
      messageKey,
      format,
      contentHash,
    );
    if (known) return { versionId: known.version_id as string, created: false };
    const prior = this.one(
      `select version_id from content_version
       where task_id = ? and run_id = ? and role = ? and format = ?
         and superseded_at is null order by id desc limit 1`,
      task.id,
      runId,
      role,
      format,
    );
    if (prior)
      this.db
        .query(
          "update content_version set superseded_at = ? where version_id = ?",
        )
        .run(at, prior.version_id);
    const versionId = randomUUID();
    this.one(
      `insert into content_version (version_id, task_id, run_id, role, message_key,
        format, text, content_hash, source, captured_at, supersedes)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      versionId,
      task.id,
      runId,
      role,
      messageKey,
      format,
      text,
      contentHash,
      source,
      at,
      prior?.version_id ?? null,
    );
    return { versionId, created: true };
  }
  /**
   * Imports one task document in a single short transaction. Browser work stays outside,
   * because no transaction may span a page interaction. Gaps are judged from the document
   * being archived, so re-importing an unchanged task still reports the same incompleteness
   * instead of making a partial archive look complete.
   */
  publish(task: Task, taskFileHash: string) {
    const at = new Date().toISOString();
    const remoteId = remoteConversationId(task);
    const result = {
      taskId: task.id,
      unchanged: false,
      runs: 0,
      versions: 0,
      gaps: runGaps(task),
    };
    this.writeTransaction(() => {
      const stored = this.one(
        "select task_file_hash from run_selection where task_id = ? limit 1",
        task.id,
      );
      if (
        this.one("select id from task where id = ?", task.id) &&
        stored?.task_file_hash === taskFileHash
      ) {
        result.unchanged = true;
        return;
      }
      this.upsertWorkspace(task.config.workspace, task.workspaceId, at);
      const conversationKey = this.upsertConversation(task, at);
      const origin = task.runs.some((run) => run.requestId === "import")
        ? "attach"
        : "convorel";
      const state = task.runs.at(-1)?.state ?? "unknown";
      if (this.one("select id from task where id = ?", task.id))
        this.db
          .query(
            `update task set conversation_id = ?, workspace_id = ?, naming_type = ?,
              topic = ?, state = ?, updated_at = ? where id = ?`,
          )
          .run(
            conversationKey,
            task.workspaceId,
            task.naming?.type ?? null,
            task.naming?.topic ?? null,
            state,
            at,
            task.id,
          );
      else
        this.db
          .query(
            `insert into task (id, conversation_id, workspace_id, naming_type, topic,
              state, origin, first_run_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            conversationKey,
            task.workspaceId,
            task.naming?.type ?? null,
            task.naming?.topic ?? null,
            state,
            origin,
            task.runs[0]?.createdAt ?? null,
            at,
          );
      // No per-run skip: the content fingerprint excludes captured Markdown on purpose,
      // so only comparing it would silently drop a re-capture, and run metadata would
      // keep its previous values. addVersion deduplicates by hash, so re-importing costs
      // no new content rows.
      task.runs.forEach((run, index) => {
        result.runs++;
        const fingerprint = runContentFingerprint(task.id, remoteId, run);
        this.db
          .query(
            `insert into run (id, task_id, seq, request_key, state, observed_model,
              created_at, submitted_at, last_observed_at, error)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set seq = excluded.seq,
               request_key = excluded.request_key, state = excluded.state,
               observed_model = excluded.observed_model,
               created_at = excluded.created_at,
               submitted_at = excluded.submitted_at,
               last_observed_at = excluded.last_observed_at,
               error = excluded.error`,
          )
          .run(
            run.id,
            task.id,
            index,
            run.requestId,
            run.state,
            run.observedModel ?? null,
            run.createdAt ?? null,
            run.submittedAt ?? null,
            run.lastObservedAt ?? null,
            run.error ?? null,
          );
        let promptVersionId: string | null = null;
        if (run.prompt) {
          const added = this.addVersion(
            task,
            run.id,
            "user",
            "run:" + run.id,
            "prompt-source",
            run.prompt,
            origin === "attach" ? "attach" : "convorel-submit",
            run.createdAt ?? at,
          );
          promptVersionId = added.versionId;
          result.versions += added.created ? 1 : 0;
        }
        let replyVersionId: string | null = null;
        let renderedVersionId: string | null = null;
        let captureStatus = "not-applicable";
        if (run.reply) {
          const rendered = this.addVersion(
            task,
            run.id,
            "assistant",
            run.reply.id,
            "rendered-text",
            run.reply.text,
            "page-observation",
            run.lastObservedAt ?? at,
          );
          renderedVersionId = rendered.versionId;
          result.versions += rendered.created ? 1 : 0;
          if (run.reply.markdown) {
            const added = this.addVersion(
              task,
              run.id,
              "assistant",
              run.reply.id,
              "markdown",
              run.reply.markdown,
              "copy-button",
              at,
            );
            replyVersionId = added.versionId;
            result.versions += added.created ? 1 : 0;
            captureStatus = "captured";
          } else
            // Rendered text is retained for traceability, but it is never selected as
            // the reply body: the archived reply is the Markdown the page produced.
            captureStatus =
              run.state === "complete" ? "pending" : "not-applicable";
        }
        this.db
          .query(
            `insert into run_selection (run_id, task_id, prompt_version_id,
              reply_version_id, rendered_version_id, capture_status, capture_error,
              last_capture_attempt_at, source_reply_hash, content_fingerprint,
              task_file_hash, indexed_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (run_id) do update set
               prompt_version_id = excluded.prompt_version_id,
               reply_version_id = excluded.reply_version_id,
               rendered_version_id = excluded.rendered_version_id,
               capture_status = excluded.capture_status,
               capture_error = excluded.capture_error,
               last_capture_attempt_at = excluded.last_capture_attempt_at,
               source_reply_hash = excluded.source_reply_hash,
               content_fingerprint = excluded.content_fingerprint,
               task_file_hash = excluded.task_file_hash,
               indexed_at = excluded.indexed_at`,
          )
          .run(
            run.id,
            task.id,
            promptVersionId,
            replyVersionId,
            renderedVersionId,
            captureStatus,
            run.reply?.markdownError ?? null,
            run.reply ? at : null,
            run.replyHash ?? null,
            fingerprint,
            taskFileHash,
            at,
          );
      });
    });
    this.harden();
    return result;
  }
  search(input: {
    query: string;
    taskId?: string;
    role?: string;
    limit?: number;
  }) {
    const search = literalQuery(input.query);
    if (input.role && !["user", "assistant"].includes(input.role))
      throw new Error("INVALID_ROLE");
    const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT)
      throw new Error("INVALID_LIMIT: 1.." + SEARCH_MAX_LIMIT);
    const scan = search.engine === "literal-scan";
    const args: (string | number)[] = [
      // The literal form references the term twice: the window and the predicate.
      ...(scan ? [search.query, search.query] : [search.match]),
    ];
    const filters = [
      scan ? "instr(lower(v.text), lower(?)) > 0" : "content_fts match ?",
      // Search reports what a run currently represents: its selected prompt and its best
      // available reply body, which is the captured Markdown when there is one and the
      // rendered copy until then. Superseded versions stay citable through content
      // and history, not through search.
      `v.version_id in (
        select prompt_version_id from run_selection where prompt_version_id is not null
        union select coalesce(reply_version_id, rendered_version_id) from run_selection
          where coalesce(reply_version_id, rendered_version_id) is not null)`,
    ];
    if (input.taskId) {
      filters.push("v.task_id = ?");
      args.push(input.taskId);
    }
    if (input.role) {
      filters.push("v.role = ?");
      args.push(input.role);
    }
    args.push(limit);
    return this.all(
      `select v.version_id, v.task_id, v.run_id, v.role, v.message_key, v.format,
        v.content_hash, v.source, v.captured_at, v.superseded_at,
        t.state as task_state, c.url, c.remote_id, c.workspace_id,
        ${
          scan
            ? `substr(v.text, max(1, instr(lower(v.text), lower(?)) - 40), 240)`
            : `snippet(content_fts, 0, '[', ']', ' ... ', ${SNIPPET_TOKENS})`
        } as excerpt,
        ${scan ? "null" : "bm25(content_fts)"} as rank
      from content_version v
        ${scan ? "" : "join content_fts on content_fts.rowid = v.id"}
        join task t on t.id = v.task_id
        left join conversation c on c.id = t.conversation_id
      where ${filters.join(" and ")}
      ${scan ? "order by v.id" : "order by rank asc, v.id asc"}
      limit ?`,
      ...args,
    ).map((row: any) => ({ ...row, engine: search.engine }));
  }
  history(taskId: string, options: { runId?: string } = {}) {
    const task = this.one(
      `select t.*, c.url, c.scope, c.remote_id, c.project_name
       from task t left join conversation c on c.id = t.conversation_id
       where t.id = ?`,
      taskId,
    );
    if (!task) throw new Error("TASK_NOT_ARCHIVED");
    const args: string[] = [taskId];
    if (options.runId) args.push(options.runId);
    return {
      task,
      turns: this.all(
        `select r.seq, r.id as run_id, r.request_key, r.state as run_state,
          r.observed_model, r.created_at, r.submitted_at, r.last_observed_at,
          r.error as run_error, s.capture_status, s.capture_error,
          s.source_reply_hash, s.content_fingerprint, s.task_file_hash,
          s.indexed_at,
          pu.text as prompt, pu.version_id as prompt_version_id,
          pu.content_hash as prompt_content_hash,
          rv.text as reply, rv.version_id as reply_version_id,
          rv.format as reply_format, rv.content_hash as reply_content_hash,
          rv.source as reply_source, rv.captured_at as reply_captured_at,
          dv.text as reply_rendered, dv.version_id as rendered_version_id
        from run r
          join run_selection s on s.run_id = r.id
          left join content_version pu on pu.version_id = s.prompt_version_id
          left join content_version rv on rv.version_id = s.reply_version_id
          left join content_version dv on dv.version_id = s.rendered_version_id
        where r.task_id = ? ${options.runId ? "and r.id = ?" : ""}
        order by r.seq`,
        ...args,
      ),
      versions: this.all(
        `select version_id, run_id, role, message_key, format, content_hash,
          source, captured_at, superseded_at, supersedes,
          length(cast(text as blob)) as bytes
        from content_version where task_id = ?
        ${options.runId ? "and run_id = ?" : ""} order by id`,
        ...args,
      ),
    };
  }
  /** Judged against the local task document read this time; the remote page is not
   * observable from here, so remoteHistory stays unknown. */
  coverage(task: Task | null, taskFileHash: string | null) {
    if (!task)
      return {
        state: "unknown",
        reason: "task_document_unavailable",
        remoteHistory: "unknown",
      };
    const remoteId = remoteConversationId(task);
    const stored = this.all(
      `select s.run_id, s.content_fingerprint, s.capture_status,
         pu.content_hash as prompt_hash, rv.content_hash as markdown_hash,
         dv.content_hash as rendered_hash
       from run_selection s
         left join content_version pu on pu.version_id = s.prompt_version_id
         left join content_version rv on rv.version_id = s.reply_version_id
         left join content_version dv on dv.version_id = s.rendered_version_id
       where s.task_id = ?`,
      task.id,
    );
    const missing: string[] = [];
    const markdownGaps: string[] = [];
    const promptGaps: string[] = [];
    for (const run of task.runs) {
      const row = stored.find(
        (item: any) =>
          item.run_id === run.id &&
          item.content_fingerprint ===
            runContentFingerprint(task.id, remoteId, run) &&
          item.prompt_hash === (run.prompt ? sha(run.prompt) : null) &&
          item.markdown_hash ===
            (run.reply?.markdown ? sha(run.reply.markdown) : null) &&
          item.rendered_hash === (run.reply ? sha(run.reply.text) : null),
      );
      if (!row) missing.push(run.id);
      else if (row.capture_status === "pending") markdownGaps.push(run.id);
      if (!run.prompt && run.userMessageId) promptGaps.push(run.id);
    }
    return {
      state:
        missing.length || promptGaps.length
          ? "incomplete"
          : markdownGaps.length
            ? "markdown-incomplete"
            : "current",
      scope: "convorel-recorded-runs",
      remoteHistory: "unknown",
      sourceReadable: !!taskFileHash,
      expectedRuns: task.runs.length,
      archivedRuns: stored.length,
      missingRuns: missing,
      markdownMissingRuns: markdownGaps,
      promptMissingRuns: promptGaps,
    };
  }
  /** One archived body by its immutable version id, selected or superseded. A citation
   * has to be readable, otherwise keeping the version proves nothing. */
  contentVersion(versionId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        versionId,
      )
    )
      throw new Error("INVALID_VERSION_ID");
    const row = this.one(
      `select v.version_id, v.task_id, v.run_id, v.role, v.message_key, v.format,
        v.text, v.content_hash, v.source, v.captured_at, v.superseded_at, v.supersedes,
        (select count(*) from run_selection s
          where s.prompt_version_id = v.version_id
            or s.reply_version_id = v.version_id
            or s.rendered_version_id = v.version_id) as selected_by,
        length(v.text) as characters
       from content_version v where v.version_id = ?`,
      versionId,
    );
    if (!row) throw new Error("VERSION_NOT_ARCHIVED");
    return { ...row, bytes: Buffer.byteLength(row.text) };
  }
  /** A consistent copy in another directory. Copying the live file would miss committed
   * bytes still held in the WAL, so the snapshot comes from VACUUM INTO. */
  exportSnapshot(directory: string) {
    if (!this.writable) throw new Error("ARCHIVE_READONLY");
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
      this.db.query("vacuum into ?").run(temporary);
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

function remoteConversationId(task: Task) {
  if (!task.url) return null;
  try {
    return conversationId(task.url);
  } catch {
    return null;
  }
}

/** What a replay of this document would still lack, judged from the document itself. */
export function runGaps(task: Task) {
  const gaps: { runId: string; code: string }[] = [];
  for (const run of task.runs) {
    if (!run.prompt && run.userMessageId)
      // An attach anchor proves a user turn existed, not what it said.
      gaps.push({ runId: run.id, code: "prompt_not_captured" });
    if (run.reply && !run.reply.markdown)
      gaps.push({
        runId: run.id,
        code: run.reply.markdownError
          ? "markdown_capture_failed"
          : "markdown_missing",
      });
  }
  return gaps;
}
