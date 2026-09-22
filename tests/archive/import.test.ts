import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive/store.ts";
import { publishTask, scanTasks } from "../../src/archive/post-archive.ts";
import { State } from "../../src/storage/state.ts";
import { writePreference } from "../../src/config/preferences.ts";
import { taskDoc } from "../support/archive.ts";

let base: string, root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-archive-"));
  root = join(base, "state");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("a corrupt task document is reported without blocking the others", async () => {
  const store = new State(root);
  store.write("config", {
    version: 1,
    workspace: "/home/mocha/project",
    cdp: "http://127.0.0.1:9222",
  });
  store.write("task-review", taskDoc());
  store.write("task-half", { version: 1, id: "half", runs: "not-an-array" });
  writeFileSync(join(root, "task-truncated.json"), "{");
  const scanned = scanTasks(root);
  expect(scanned.found.map((item) => item.taskId)).toEqual(["review"]);
  expect(scanned.errors.map((error) => error.taskId).sort()).toEqual([
    "half",
    "truncated",
  ]);
  expect(await publishTask(root, scanned.found[0].taskId)).toMatchObject({
    status: "partial",
    versions: 2,
  });
  // State.tasks() stays strict: it participates in the runtime conflict check, so a
  // bad document must fail loudly there instead of quietly disappearing.
  expect(() => store.tasks()).toThrow();
});

test("archive lock timeout is reported separately and never steals the writer lock", async () => {
  const store = new State(root);
  store.write("task-review", taskDoc());
  writePreference("locks.taskWaitMs", "50");
  try {
    await store.locked(async () => {
      const before = readFileSync(store.path("lock-task-review"), "utf8");
      expect(await publishTask(root, "review")).toMatchObject({
        status: "failed",
        error: expect.stringContaining("LOCK_BUSY"),
      });
      expect(readFileSync(store.path("lock-task-review"), "utf8")).toBe(before);
      expect(Archive.available(root)).toBe(false);
    }, "task-review");
    expect((await publishTask(root, "review")).status).toBe("partial");
  } finally {
    writePreference("locks.taskWaitMs", "");
  }
});

test("an unreadable current source cannot replace the archive with an earlier scan", async () => {
  const store = new State(root);
  const task = taskDoc();
  task.runs[0].reply.markdown = "## Retained";
  store.write("task-review", task);
  const stale = scanTasks(root).found[0];
  expect((await publishTask(root, "review")).status).toBe("stored");
  writeFileSync(store.path("task-review"), "{");
  expect(await publishTask(root, stale.taskId)).toMatchObject({
    status: "failed",
  });
  const archive = new Archive(root);
  expect(archive.history("review").turns[0].reply).toBe("## Retained");
  archive.close();
});
