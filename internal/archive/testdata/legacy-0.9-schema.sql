-- conversations.db schema version 1, copied from Convorel 0.9.0
-- src/archive/schema.ts. Fixture databases are built from this file so the Go
-- reader is exercised against the on-disk shape produced by the previous
-- implementation rather than against its own DDL constant.
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
