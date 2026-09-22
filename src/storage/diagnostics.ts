import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { preference } from "../config/preferences.ts";

/** Separate from the content archive. Rows are retained local records, not task truth. */
export const DIAGNOSTICS_APPLICATION_ID = 1129600051;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHASES = [
  "prepared",
  "submitting",
  "delivery_unknown",
  "waiting",
  "complete",
  "blocked",
] as const;
const STEPS = [
  "model",
  "fill",
  "send",
  "observe",
  "persist",
  "naming",
  "release",
] as const;
const CODES = new Set([
  "UNCLASSIFIED",
  "NEEDS_ATTENTION",
  "PAGE_ORIGIN_CHANGED",
  "CONVERSATION_CHANGED",
  "PAGE_NOT_IDLE",
  "SEND_CONTROL_UNAVAILABLE",
  "DRAFT_CHANGED",
  "DRAFT_CLEAR_UNVERIFIED",
  "MODEL_CHANGED_BEFORE_SEND",
  "STATE_PERSIST_FAILED",
  "LOCK_BUSY",
  "CDP_UNAVAILABLE",
  "CDP_METADATA_INVALID",
  "BROWSER_READ_FAILED",
  "BROWSER_ERROR",
  "UI_UNRECOGNIZED",
  "PROMPT_INTEGRITY_FAILED",
  "COMPOSER_UNRECOGNIZED",
  "EXPECTED_DRAFT_REQUIRED",
  "RUN_NOT_PREPARED",
  "RUN_MISSING",
  "RESULT_NOT_COMPLETE",
  "SUBMITTED_MESSAGE_MISSING",
  "REFRESH_HISTORY_UNAVAILABLE",
  "STALLED_REPLY",
  "PENDING_URL_UNVERIFIED",
  "BROWSER_RESTARTED",
  "CLOSE_UNVERIFIED",
  "METADATA_PAGE_CHANGED",
  "METADATA_PAGE_UNAVAILABLE",
  "DELIVERY_NOT_CONFIRMED",
  "INVALID_CDP",
  "COMPLETED_TURN_CHANGED",
  "NAMING_METADATA",
  "NAMING_LOCATING",
  "NAMING_EDITING",
  "NAMING_SAVE_PENDING",
  "NAMING_VERIFYING",
  "NAMING_COMPLETE",
  "NAMING_CONTROL_UNAVAILABLE",
  "NAMING_METADATA_UNAVAILABLE",
]);
const SCHEMA = `
create table diagnostic_event (
  task_id text not null,
  seq integer not null,
  run_id text,
  recorded_at text not null,
  event text not null,
  step text,
  code text not null,
  retryable integer,
  pid integer not null,
  invocation text not null,
  primary key (task_id, seq),
  check (length(task_id) between 1 and 80),
  check (run_id is null or length(run_id) = 36),
  check (event in ('phase', 'observe_failed', 'operation_result')),
  check (step is null or step in ('model', 'fill', 'send', 'observe', 'persist', 'naming', 'release')),
  check (length(code) between 1 and 64),
  check (retryable is null or retryable in (0, 1))
);
`;
const FREE_FLOOR = 64 * 1024 * 1024;
const MAX_PAGES = (32 * 1024 * 1024) / 4096;
const invocation = randomUUID();

export type DiagnosticStep = (typeof STEPS)[number];
type Phase = (typeof PHASES)[number];
type Remember = "disabled" | "same" | "stored" | "skipped";

/** Fixed token only. Page text, paths and exception bodies stay out of the store. */
export function diagnosticCode(error: unknown) {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const text = raw.replace(/^Error:\s*/, "");
  if (text.startsWith("NEEDS_ATTENTION")) return "NEEDS_ATTENTION";
  if (
    /^(Target conversation not visible in sidebar|Conversation rename action unavailable|Chat title input unavailable)/.test(
      text,
    )
  )
    return "NAMING_CONTROL_UNAVAILABLE";
  if (
    /^(Fresh conversation metadata unavailable|Conversation metadata request rejected)/.test(
      text,
    )
  )
    return "NAMING_METADATA_UNAVAILABLE";
  const token = /^[A-Z][A-Z0-9_]*/.exec(text)?.[0];
  return token && CODES.has(token) ? token : "UNCLASSIFIED";
}

/** Unset is on. An explicit false, any other value, or a failed read is off. */
export function diagnosticsEnabled(read: () => string | undefined) {
  try {
    const value = read();
    if (value === undefined) return true;
    return value === "true";
  } catch {
    return false;
  }
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}
function isStep(value: string): value is DiagnosticStep {
  return (STEPS as readonly string[]).includes(value);
}

export class Diagnostics {
  private readonly path: string;
  constructor(
    root: string,
    private readonly options: {
      freeFloor?: number;
      enabled?: () => boolean;
    } = {},
  ) {
    this.path = join(root, "diagnostics.db");
  }
  private enabled() {
    if (this.options.enabled) {
      try {
        return this.options.enabled();
      } catch {
        return false;
      }
    }
    return diagnosticsEnabled(() => preference("diagnostics.enabled"));
  }
  private room() {
    try {
      const directory = dirname(this.path);
      const stat = statfsSync(
        existsSync(directory) ? directory : dirname(directory),
      );
      return stat.bavail * stat.bsize >= (this.options.freeFloor ?? FREE_FLOOR);
    } catch {
      return false;
    }
  }
  /** Record a persisted phase once per run. A matching stored phase is not rewritten. */
  rememberPhase(taskId: string, runId: string, state: string): Remember {
    try {
      if (!this.enabled()) return "disabled";
      if (!isPhase(state) || !TASK_ID.test(taskId) || !RUN_ID.test(runId))
        return "skipped";
      if (!this.room()) return "skipped";
      return this.transaction(taskId, (db) => {
        const last = db
          .query(
            `select code from diagnostic_event
             where task_id = ? and run_id = ? and event = 'phase'
             order by seq desc limit 1`,
          )
          .get(taskId, runId) as { code: string } | null;
        if (last?.code === state) return "same" as const;
        this.insert(db, {
          taskId,
          runId,
          event: "phase",
          step: null,
          code: state,
          retryable: null,
        });
        return "stored" as const;
      });
    } catch {
      return "skipped";
    }
  }
  namingProgress(taskId: string, runId: string, phase: string) {
    this.failure({
      taskId,
      runId,
      event: "operation_result",
      step: "naming",
      code: "NAMING_" + phase.toUpperCase(),
    });
  }
  failure(input: {
    taskId: string;
    runId: string;
    event: "observe_failed" | "operation_result";
    step: DiagnosticStep;
    code: string;
    retryable?: boolean;
  }) {
    try {
      if (!this.enabled()) return;
      if (
        !TASK_ID.test(input.taskId) ||
        !RUN_ID.test(input.runId) ||
        !isStep(input.step) ||
        !CODES.has(input.code) ||
        (input.event === "observe_failed" && input.step !== "observe")
      )
        return;
      if (!this.room()) return;
      this.transaction(input.taskId, (db) => {
        this.insert(db, {
          taskId: input.taskId,
          runId: input.runId,
          event: input.event,
          step: input.step,
          code: input.code,
          retryable:
            input.event === "observe_failed" ? (input.retryable ? 1 : 0) : null,
        });
        return "stored" as const;
      });
    } catch {
      // Diagnostic loss never changes the caller.
    }
  }
  private transaction<T extends string>(
    _taskId: string,
    fn: (db: Database) => T,
  ): T | "skipped" {
    let db: Database | undefined;
    try {
      if (existsSync(this.path)) {
        const stat = lstatSync(this.path);
        if (stat.isSymbolicLink() || !stat.isFile()) return "skipped";
      } else {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      }
      db = new Database(this.path, { create: true });
      db.exec("pragma busy_timeout = 0");
      const identity = this.identity(db);
      const ready = this.tableReady(db);
      if (ready && !identity.ours) return "skipped";
      if (!ready && !identity.empty) return "skipped";
      db.exec("pragma journal_mode = wal");
      db.exec("pragma synchronous = full");
      db.exec("pragma max_page_count = " + MAX_PAGES);
      db.exec("pragma journal_size_limit = 4194304");
      db.exec("begin immediate");
      try {
        if (!this.tableReady(db)) {
          const again = this.identity(db);
          if (!again.empty) throw new Error("foreign");
          db.exec(SCHEMA);
          db.exec("pragma user_version = 1");
          db.exec("pragma application_id = " + DIAGNOSTICS_APPLICATION_ID);
        }
        const result = fn(db);
        if (result === "same") {
          db.exec("rollback");
          return result;
        }
        db.exec("commit");
        return result;
      } catch {
        try {
          db.exec("rollback");
        } catch {
          // A failed begin has no transaction. Closing the handle releases it.
        }
        return "skipped";
      }
    } catch {
      return "skipped";
    } finally {
      db?.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = this.path + suffix;
        if (!existsSync(file)) continue;
        try {
          const stat = lstatSync(file);
          if (stat.isFile()) chmodSync(file, 0o600);
        } catch {
          // Permissions are best-effort after the transaction.
        }
      }
    }
  }
  private identity(db: Database) {
    const version = (
      db.query("pragma user_version").get() as { user_version: number }
    ).user_version;
    const kind = (
      db.query("pragma application_id").get() as { application_id: number }
    ).application_id;
    return {
      empty: version === 0 && kind === 0,
      ours: version === 1 && kind === DIAGNOSTICS_APPLICATION_ID,
    };
  }
  private tableReady(db: Database) {
    return !!db
      .query(
        "select 1 as ok from sqlite_master where type = 'table' and name = 'diagnostic_event'",
      )
      .get();
  }
  private insert(
    db: Database,
    row: {
      taskId: string;
      runId: string;
      event: string;
      step: string | null;
      code: string;
      retryable: number | null;
    },
  ) {
    const current = db
      .query(
        "select coalesce(max(seq), 0) as seq from diagnostic_event where task_id = ?",
      )
      .get(row.taskId) as { seq: number };
    db.query(
      `insert into diagnostic_event (
        task_id, seq, run_id, recorded_at, event, step, code, retryable, pid, invocation
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.taskId,
      current.seq + 1,
      row.runId,
      new Date().toISOString(),
      row.event,
      row.step,
      row.code,
      row.retryable,
      process.pid,
      invocation,
    );
  }
}

export function diagnosticsPath(root: string) {
  return join(root, "diagnostics.db");
}

export function readDiagnostics(root: string, taskId: string, runId?: string) {
  if (!TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
  if (runId !== undefined && !RUN_ID.test(runId))
    throw new Error("INVALID_RUN_ID");
  const path = join(root, "diagnostics.db");
  const empty = {
    status: "missing" as const,
    complete: false,
    authority: "task-document" as const,
    events: [],
  };
  if (!existsSync(path)) return empty;
  let db: Database | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("DIAGNOSTICS_UNREADABLE");
    db = new Database(path, { readonly: true });
    db.exec("pragma busy_timeout = 0");
    const version = (
      db.query("pragma user_version").get() as { user_version: number }
    ).user_version;
    const kind = (
      db.query("pragma application_id").get() as { application_id: number }
    ).application_id;
    if (version !== 1 || kind !== DIAGNOSTICS_APPLICATION_ID)
      throw new Error("DIAGNOSTICS_UNREADABLE");
    const rows = db
      .query(
        `select seq, run_id as runId, recorded_at as recordedAt, event, step, code,
           retryable, pid, invocation
         from diagnostic_event
         where task_id = ? and (? is null or run_id = ?)
         order by seq`,
      )
      .all(taskId, runId ?? null, runId ?? null) as {
      seq: number;
      runId: string | null;
      recordedAt: string;
      event: string;
      step: string | null;
      code: string;
      retryable: number | null;
      pid: number;
      invocation: string;
    }[];
    const events = rows.map((row) => ({
      seq: row.seq,
      runId: row.runId,
      recordedAt: row.recordedAt,
      event: row.event,
      step: row.step,
      code: row.code,
      retryable: row.retryable === null ? null : row.retryable === 1,
      pid: row.pid,
      invocation: row.invocation,
    }));
    return {
      status: events.length ? ("ok" as const) : ("empty" as const),
      complete: false,
      authority: "task-document" as const,
      events,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_RUN_ID")
      throw error;
    if (error instanceof Error && error.message === "DIAGNOSTICS_UNREADABLE")
      throw error;
    throw new Error("DIAGNOSTICS_UNREADABLE");
  } finally {
    db?.close();
  }
}
