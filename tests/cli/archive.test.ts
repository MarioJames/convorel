import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { State } from "../../src/storage/state.ts";
import { childEnv } from "../../src/process.ts";
import { taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function cli(args: string[], stateDir = root) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../../src/cli.ts"),
      "--state-dir",
      stateDir,
      "--config-dir",
      join(base, "prefs"),
      ...args,
    ],
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = async (stream: ReadableStream) =>
    new TextDecoder().decode(
      new Uint8Array(await new Response(stream).arrayBuffer()),
    );
  const out = await text(child.stdout as ReadableStream);
  return { code: await child.exited, out: out.trim() };
}

test("archive and local doctor fail when the store cannot be opened", async () => {
  mkdirSync(root);
  const foreign = new Database(join(root, "conversations.db"));
  foreign.exec("create table other_app (value text)");
  foreign.close();
  const archived = await cli(["conversation", "archive", "--all", "true"]);
  expect(JSON.parse(archived.out).summary.status).toBe("failed");
  expect(archived.code).toBe(1);
  const doctor = await cli(["doctor", "--local", "true"]);
  expect(JSON.parse(doctor.out).archive.status).toBe("failed");
  expect(doctor.code).toBe(1);
});

test("the archive surface needs no config, workspace or browser", async () => {
  const store = new State(root);
  store.write("config", {
    version: 1,
    workspace: "/home/mocha/project",
    cdp: "http://127.0.0.1:9222",
  });
  store.write("task-review", taskDoc());
  const imported = await cli(["conversation", "archive", "--all", "true"]);
  expect(imported.code).toBe(2);
  expect(JSON.parse(imported.out).archived[0]).toMatchObject({
    taskId: "review",
    status: "partial",
  });
  rmSync(join(root, "config.json"), { force: true });
  const search = await cli([
    "conversation",
    "search",
    "--query",
    "防枚举",
    "--fields",
    "hits",
  ]);
  expect(search.code).toBe(0);
  expect(JSON.parse(search.out).hits.length).toBe(1);
  const history = await cli([
    "conversation",
    "history",
    "--id",
    "review",
    "--fields",
    "turns",
  ]);
  expect(history.code).toBe(0);
  expect(JSON.parse(history.out).turns[0].run_id).toBe("r1");
  const listed = await cli([
    "conversation",
    "history",
    "--id",
    "review",
    "--fields",
    "versions",
  ]);
  const versionId = JSON.parse(listed.out).versions[0].version_id as string;
  const content = await cli([
    "conversation",
    "content",
    "--version",
    versionId,
    "--fields",
    "version",
  ]);
  expect(content.code).toBe(0);
  expect(JSON.parse(content.out).version).toMatchObject({
    version_id: versionId,
    role: "user",
    format: "prompt-source",
  });
  expect(JSON.parse(content.out).version.text).toContain("防枚举");
  const badVersion = await cli([
    "conversation",
    "content",
    "--version",
    "not-a-uuid",
  ]);
  expect(badVersion.code).toBe(1);
  const doctor = await cli(["doctor", "--local", "true"]);
  expect(doctor.code).toBe(2);
  const report = JSON.parse(doctor.out);
  expect(report.archive.fts_integrity_check).toBe("ok");
  expect(report.archive.coverage[0].state).toBe("markdown-incomplete");
  const rejected = await cli([
    "conversation",
    "search",
    "--query",
    "x",
    "--nope",
    "y",
  ]);
  expect(rejected.code).toBe(1);
  const empty = join(base, "empty");
  mkdirSync(empty);
  const nothing = await cli(["conversation", "search", "--query", "x"], empty);
  expect(nothing.code).toBe(1);
  expect(JSON.parse(nothing.out).notice.error).toBe("ARCHIVE_MISSING");
  const badScope = await cli(["conversation", "archive"]);
  expect(badScope.code).toBe(1);
  // --all is a boolean flag: a truthy string must not widen a single-task import.
  // --all is read as a boolean: "false" must not widen a single-task import to everything.
  const falseAll = await cli([
    "conversation",
    "archive",
    "--id",
    "review",
    "--all",
    "false",
  ]);
  expect(falseAll.code).toBe(2);
  expect(JSON.parse(falseAll.out).archived.length).toBe(1);
  expect(JSON.parse(falseAll.out).scope).toBe("review");
  // Re-running the same import writes nothing but still reports the gap it holds.
  const again = await cli(["conversation", "archive", "--id", "review"]);
  expect(again.code).toBe(2);
  expect(JSON.parse(again.out).archived[0]).toMatchObject({
    taskId: "review",
    status: "partial",
    versions: 0,
  });
  const exported = await cli([
    "conversation",
    "export",
    "--directory",
    join(base, "cli-backup"),
  ]);
  expect(exported.code).toBe(0);
  const offline = await cli([
    "conversation",
    "search",
    "--query",
    "防枚举",
    "--from",
    join(base, "cli-backup", "conversations.db"),
    "--fields",
    "hits,source",
  ]);
  expect(offline.code).toBe(0);
  expect(JSON.parse(offline.out).hits.length).toBe(1);
});
