import { sha } from "../hash.ts";
import type { Task } from "../conversation/types.ts";
import type { ArchiveStore } from "./context.ts";
import { remoteConversationId, runContentFingerprint } from "./projection.ts";

/** FTS5 trigram needs three code points; shorter queries scan literally instead. */
const MATCH_MIN = 3;
const SNIPPET_TOKENS = 32;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const QUERY_MAX_BYTES = 512;

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

export function search(
  store: ArchiveStore,
  input: {
    query: string;
    taskId?: string;
    role?: string;
    limit?: number;
  },
) {
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
  return store
    .all(
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
    )
    .map((row: any) => ({ ...row, engine: search.engine }));
}

export function history(
  store: ArchiveStore,
  taskId: string,
  options: { runId?: string } = {},
) {
  const task = store.one(
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
    turns: store.all(
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
    versions: store.all(
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
export function coverage(
  store: ArchiveStore,
  task: Task | null,
  taskFileHash: string | null,
) {
  if (!task)
    return {
      state: "unknown",
      reason: "task_document_unavailable",
      remoteHistory: "unknown",
    };
  const remoteId = remoteConversationId(task);
  const stored = store.all(
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
export function contentVersion(store: ArchiveStore, versionId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      versionId,
    )
  )
    throw new Error("INVALID_VERSION_ID");
  const row = store.one(
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
