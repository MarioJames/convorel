import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
import { waitForConversation } from "../src/wait.ts";

test("watchers exclude other runs of the same task and release the lock promptly on cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-watch-"));
  const store = new State(root),
    abort = new AbortController();
  let reportStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const observations: any[] = [];
  const poll = async () =>
    ({ currentRun: "r1", runs: [{ id: "r1", state: "waiting" }] }) as any;
  try {
    const first = waitForConversation(
      store,
      { poll },
      "task",
      "r1",
      120,
      abort.signal,
      (x) => {
        observations.push(x);
        reportStarted();
      },
    );
    await started;
    await expect(
      waitForConversation(
        store,
        { poll },
        "task",
        "r2",
        120,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("LOCK_BUSY");
    abort.abort();
    expect(await first).toBe(2);
    expect(observations.at(-1)).toMatchObject({
      state: "cancelled",
      remoteGenerationStopped: false,
      runId: "r1",
    });
    expect(store.has("lock-watch-task")).toBe(false);
    const complete = async () =>
      ({ currentRun: "r2", runs: [{ id: "r2", state: "complete" }] }) as any;
    expect(
      await waitForConversation(
        store,
        { poll: complete },
        "task",
        "r2",
        1,
        new AbortController().signal,
        () => {},
      ),
    ).toBe(0);
  } finally {
    abort.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a watcher never follows a newer run and releases ownership on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-watch-"));
  try {
    const store = new State(root);
    const poll = async () =>
      ({ currentRun: "r2", runs: [{ id: "r2", state: "complete" }] }) as any;
    await expect(
      waitForConversation(
        store,
        { poll },
        "task",
        "r1",
        1,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("STALE_RUN");
    expect(store.has("lock-watch-task")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
