import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
import { waitForConversation } from "../src/wait.ts";
import { ObservationError } from "../src/browser.ts";

const unusedGet = () => {
  throw new Error("unexpected status read");
};

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
    ({
      config: { workspace: root },
      workspaceId: "fixture",
      currentRun: "r1",
      runs: [{ id: "r1", state: "waiting" }],
    }) as any;
  try {
    const first = waitForConversation(
      store,
      { poll, get: unusedGet },
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
        { poll, get: unusedGet },
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
      ({
        config: { workspace: root },
        workspaceId: "fixture",
        currentRun: "r2",
        runs: [{ id: "r2", state: "complete" }],
      }) as any;
    expect(
      await waitForConversation(
        store,
        { poll: complete, get: unusedGet },
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
      ({
        config: { workspace: root },
        workspaceId: "fixture",
        currentRun: "r2",
        runs: [{ id: "r2", state: "complete" }],
      }) as any;
    await expect(
      waitForConversation(
        store,
        { poll, get: unusedGet },
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

test("waiting retries only observation failures and stops after three consecutive failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-observation-"));
  const store = new State(root);
  const task = {
    id: "task",
    config: { workspace: root },
    workspaceId: "fixture",
    currentRun: "r1",
    runs: [{ id: "r1", state: "waiting", userMessageId: "u1" }],
  } as any;
  const reports: any[] = [];
  let calls = 0;
  try {
    const code = await waitForConversation(
      store,
      {
        get: () => task,
        poll: async () => {
          calls++;
          if (calls < 3)
            throw new ObservationError("connection reset while reading");
          return { ...task, runs: [{ ...task.runs[0], state: "complete" }] };
        },
      },
      "task",
      "r1",
      10,
      new AbortController().signal,
      (x) => reports.push(x),
    );
    expect(code).toBe(0);
    expect(calls).toBe(3);
    expect(reports[0]).toMatchObject({
      delivery: "confirmed",
      nextAction: "resume",
    });
    calls = 0;
    expect(
      await waitForConversation(
        store,
        {
          get: () => task,
          poll: async () => {
            calls++;
            throw new ObservationError("connection reset");
          },
        },
        "task",
        "r1",
        10,
        new AbortController().signal,
        (x) => reports.push(x),
      ),
    ).toBe(2);
    expect(calls).toBe(3);
    expect(reports.at(-1)).toMatchObject({
      state: "waiting",
      nextAction: "inspect",
    });
    expect(store.has("lock-watch-task")).toBe(false);
    calls = 0;
    await expect(
      waitForConversation(
        store,
        {
          get: () => task,
          poll: async () => {
            calls++;
            throw new Error("NEEDS_ATTENTION: Login required");
          },
        },
        "task",
        "r1",
        10,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("Login required");
    expect(calls).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("completed replies keep waiting for scheduled naming recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-watch-name-"));
  const store = new State(root);
  let calls = 0;
  try {
    const code = await waitForConversation(
      store,
      {
        get: unusedGet,
        poll: async () =>
          ({
            config: { workspace: root },
            workspaceId: "fixture",
            currentRun: "r1",
            naming: { type: "FIX", topic: "Naming" },
            organization:
              ++calls === 1
                ? {
                    verified: false,
                    attempts: 1,
                    error: "Error: Conversation UI reported an error",
                    nextRetryAt: new Date(0).toISOString(),
                  }
                : { verified: true, attempts: 2 },
            runs: [{ id: "r1", state: "complete" }],
          }) as any,
      },
      "task",
      "r1",
      1,
      new AbortController().signal,
      () => {},
    );
    expect(code).toBe(0);
    expect(calls).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait keeps observing an uncertain submission and never calls a send operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-watch-unknown-"));
  const store = new State(root);
  let polls = 0;
  const reports: any[] = [];
  try {
    const code = await waitForConversation(
      store,
      {
        get: unusedGet,
        poll: async () =>
          ({
            id: "task",
            config: { workspace: root },
            workspaceId: "fixture",
            currentRun: "r1",
            runs: [
              {
                id: "r1",
                state: ++polls < 2 ? "delivery_unknown" : "complete",
              },
            ],
          }) as any,
      },
      "task",
      "r1",
      3,
      new AbortController().signal,
      (x) => reports.push(x),
    );
    expect(code).toBe(0);
    expect(polls).toBe(2);
    expect(reports[0].delivery).toBe("unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed reply with unrecovered naming reports partial completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-watch-partial-"));
  try {
    const reports: any[] = [];
    const code = await waitForConversation(
      new State(root),
      {
        get: unusedGet,
        poll: async () =>
          ({
            id: "task",
            config: { workspace: root },
            workspaceId: "fixture",
            currentRun: "r1",
            naming: { type: "FIX", topic: "Recovery" },
            organization: {
              verified: false,
              attempts: 3,
              error:
                "Target conversation not visible in sidebar; open its project/history before retrying",
            },
            runs: [{ id: "r1", state: "complete", userMessageId: "u1" }],
          }) as any,
      },
      "task",
      "r1",
      1,
      new AbortController().signal,
      (x) => reports.push(x),
    );
    expect(code).toBe(2);
    expect(reports[0]).toMatchObject({
      state: "complete",
      replyComplete: true,
      nextAction: "organize",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
