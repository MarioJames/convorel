// Package store owns durable task documents and local diagnostics. Open returns
// a SQLiteStore implementing Store; callers close it with Close. One daemon owns
// one store. Cross-process locks and legacy JSON-file imports are not provided.
//
// Schema 2 retains the 0.9 task_document table and legacy_hash evidence. Migration
// preserves unknown JSON fields and all rows. Legacy submitting/waiting phases
// become delivered when a user message ID exists, otherwise delivery_unknown.
// Prepared runs with an existing user ID become delivered as well. Unknown old
// phases become failed with legacyState retained; terminal phases remain intact.
// Legacy naming verification is projected independently into NamingState, and
// interrupted legacy rename operations are marked failed for verification.
// Migration is transactional and rerunning it makes no changes.
//
// CreateTask and AppendRun claim explicit request IDs globally. The special
// initial key is scoped to a task. Replays compare input hashes and return the
// original run. Legacy duplicate explicit keys retain both task histories; the
// first task in ID order holds the claim, so conflicting replays fail closed.
// Transition checks the old phase and immutable prompt identity before publishing
// a run. Unknown or confirmed delivery never grants retry permission. Rejected
// requires a recorded non-2xx response; rejected to prepared resets delivery
// facts before a new attempt. UpdateTask edits metadata without altering runs.
//
// Diagnostics retain old events verbatim and add a bounded UTF-8 error excerpt.
// RecordFailure and RememberPhase return errors independently of task writes;
// their caller must treat failures as diagnostic loss, never as run failure.
// SetDiagnosticsEnabled applies the configuration preference (default enabled).
// Writes skip when less than 64 MiB is free; the database has a 32 MiB page cap.
package store
