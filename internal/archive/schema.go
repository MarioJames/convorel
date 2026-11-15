package archive

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
)

// Version is the only conversations.db schema version this binary writes.
// It matches the 0.9 archive, so an existing file is verified rather than rebuilt.
const Version = 1

// DBKind distinguishes a Convorel conversation archive from another application's
// SQLite file. A user_version alone cannot identify the owner of the file.
const DBKind = "convorel-conversation-db"

// fingerprintVersion participates in runContentFingerprint. Changing the inputs
// would make existing run_selection rows look stale, so it stays at the 0.9 value.
const fingerprintVersion = 1

// Path is the archive location inside a state directory. The 0.9 database is
// reused in place; callers must not copy or rename it on the live path.
func Path(stateDir string) string { return filepath.Join(stateDir, "conversations.db") }

// schema is the 0.9 v1 DDL reproduced byte for byte. The FTS5 trigram index and
// its external-content triggers are part of the on-disk contract: a different
// tokenizer or trigger would change search results on data that already exists.
const schema = `
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
`

type queryer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// verify accepts only a Convorel v1 archive. A missing meta table means the file
// belongs to another application; it is never repaired in place.
func verify(ctx context.Context, q queryer) error {
	var one int
	err := q.QueryRowContext(ctx,
		"select 1 from sqlite_master where name = 'meta' and type = 'table'").Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("NOT_A_CONVOREL_ARCHIVE")
	}
	if err != nil {
		return err
	}
	var kind string
	err = q.QueryRowContext(ctx, "select value from meta where key = 'dbKind'").Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("NOT_A_CONVOREL_ARCHIVE: dbKind is null")
	}
	if err != nil {
		return err
	}
	if kind != DBKind {
		return fmt.Errorf("NOT_A_CONVOREL_ARCHIVE: dbKind is %q", kind)
	}
	var version int
	if err := q.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return err
	}
	if version < 1 || version > Version {
		return fmt.Errorf("ARCHIVE_VERSION_UNSUPPORTED: found %d", version)
	}
	return nil
}

// migrate creates v1 only for an empty file. BEGIN IMMEDIATE takes write access
// up front so two first-run processes cannot both decide the file is empty.
func migrate(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var version int
	if err := conn.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return err
	}
	if version > Version {
		return fmt.Errorf("ARCHIVE_VERSION_UNSUPPORTED: found %d", version)
	}
	if version == Version {
		return verify(ctx, conn)
	}
	var name string
	err = conn.QueryRowContext(ctx, `select name from sqlite_master
		where type in ('table','view','index','trigger') and name not like 'sqlite_%'
		limit 1`).Scan(&name)
	if err == nil {
		return errors.New("NOT_A_CONVOREL_ARCHIVE: database already holds other objects")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = conn.ExecContext(ctx, "begin immediate"); err != nil {
		return err
	}
	commit := func() error {
		_, err := conn.ExecContext(ctx, "commit")
		return err
	}
	rollback := func() { _, _ = conn.ExecContext(context.Background(), "rollback") }
	var hasMeta int
	err = conn.QueryRowContext(ctx,
		"select 1 from sqlite_master where name = 'meta'").Scan(&hasMeta)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		rollback()
		return err
	}
	if errors.Is(err, sql.ErrNoRows) {
		if _, err = conn.ExecContext(ctx, schema); err != nil {
			rollback()
			return err
		}
		if _, err = conn.ExecContext(ctx,
			"insert into meta (key, value) values ('dbKind', ?)", DBKind); err != nil {
			rollback()
			return err
		}
		if _, err = conn.ExecContext(ctx,
			"insert into meta (key, value) values ('createdAt', ?)", nowISO()); err != nil {
			rollback()
			return err
		}
	}
	if _, err = conn.ExecContext(ctx, fmt.Sprintf("pragma user_version = %d", Version)); err != nil {
		rollback()
		return err
	}
	if err = commit(); err != nil {
		rollback()
		return err
	}
	return nil
}
