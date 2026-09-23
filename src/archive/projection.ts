import { randomUUID } from "node:crypto";
import { conversationId } from "../browser/chatgpt/page.ts";
import { sha } from "../hash.ts";
import type { Run, Task } from "../conversation/types.ts";
import type { ArchiveStore } from "./context.ts";
import { FINGERPRINT_VERSION } from "./schema.ts";

export function remoteConversationId(task: Task) {
  if (!task.url) return null;
  try {
    return conversationId(task.url);
  } catch {
    return null;
  }
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

function upsertWorkspace(
  store: ArchiveStore,
  root: string,
  id: string,
  at: string,
) {
  if (store.one("select id from workspace where id = ?", id))
    store.db
      .query("update workspace set last_seen_at = ? where id = ?")
      .run(at, id);
  else
    store.db
      .query(
        `insert into workspace (id, root, first_seen_at, last_seen_at)
         values (?, ?, ?, ?)`,
      )
      .run(id, root, at, at);
}

/** The remote conversation identity is the trailing id; `scope` keeps the project
 * prefix so a project conversation and a plain one never collide. */
function upsertConversation(store: ArchiveStore, task: Task, at: string) {
  const remoteId = remoteConversationId(task);
  if (!task.url || !remoteId) return null;
  const scope = task.url.slice(
    0,
    task.url.length - remoteId.length - "/c/".length,
  );
  const existing = store.one(
    `select id from conversation
     where provider = 'chatgpt' and scope = ? and remote_id = ?`,
    scope,
    remoteId,
  );
  if (existing) {
    store.db
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
  const created = store.one(
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

/** Content IDs/bytes and their original predecessor stay immutable. Re-selecting
 * known content reactivates it; superseded_at describes the current selection,
 * not an append-only event log. The next new version supersedes that selection. */
function addVersion(
  store: ArchiveStore,
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
  const known = store.one(
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
  const prior = store.one(
    `select version_id from content_version
     where task_id = ? and run_id = ? and role = ? and format = ?
       and superseded_at is null order by id desc limit 1`,
    task.id,
    runId,
    role,
    format,
  );
  if (known?.version_id === prior?.version_id && known)
    return { versionId: known.version_id as string, created: false };
  if (prior)
    store.db
      .query(
        "update content_version set superseded_at = ? where version_id = ?",
      )
      .run(at, prior.version_id);
  if (known) {
    store.db
      .query(
        "update content_version set superseded_at = null where version_id = ?",
      )
      .run(known.version_id);
    return { versionId: known.version_id as string, created: false };
  }
  const versionId = randomUUID();
  store.one(
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
 * Low-level projection of an already serialized source snapshot. Live imports must
 * hold the task/operation lock and read the source under it (see post-archive.ts).
 * Imports one task document in a single short transaction. Browser work stays outside,
 * because no transaction may span a page interaction. Gaps are judged from the document
 * being archived, so re-importing an unchanged task still reports the same incompleteness
 * instead of making a partial archive look complete.
 */
export function publish(store: ArchiveStore, task: Task, taskFileHash: string) {
  const at = new Date().toISOString();
  const remoteId = remoteConversationId(task);
  const result = {
    taskId: task.id,
    unchanged: false,
    runs: 0,
    versions: 0,
    gaps: runGaps(task),
  };
  store.writeTransaction(() => {
    const stored = store.one(
      "select task_file_hash from run_selection where task_id = ? limit 1",
      task.id,
    );
    if (
      store.one("select id from task where id = ?", task.id) &&
      stored?.task_file_hash === taskFileHash
    ) {
      result.unchanged = true;
      return;
    }
    upsertWorkspace(store, task.config.workspace, task.workspaceId, at);
    const conversationKey = upsertConversation(store, task, at);
    const origin = task.runs.some((run) => run.requestId === "import")
      ? "attach"
      : "convorel";
    const state = task.runs.at(-1)?.state ?? "unknown";
    if (store.one("select id from task where id = ?", task.id))
      store.db
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
      store.db
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
      const owner = store.one("select task_id from run where id = ?", run.id);
      if (owner && owner.task_id !== task.id)
        throw new Error(`ARCHIVE_RUN_TASK_CONFLICT: ${run.id}`);
      const fingerprint = runContentFingerprint(task.id, remoteId, run);
      store.db
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
        const added = addVersion(
          store,
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
        const rendered = addVersion(
          store,
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
          const added = addVersion(
            store,
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
      store.db
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
  store.harden();
  return result;
}
