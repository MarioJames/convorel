import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.ts";
import { childEnv } from "../src/command.ts";
import { sha } from "../src/workspace.ts";

test("CLI distinguishes saved status, interrupted observation, and a durable completed reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-cli-status-"));
  const workspace = join(root, "code");
  mkdirSync(workspace);
  const store = new State(join(root, "state"));
  // An owned local HTTP endpoint failing CDP reads; no external browser or account.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("Unavailable", { status: 503 }),
  });
  const config = {
    version: 1,
    workspace,
    cdp: `http://127.0.0.1:${server.port}`,
  };
  const task: any = {
    version: 1,
    id: "task",
    config,
    workspaceId: "fixture",
    currentRun: "r1",
    attemptId: "a1",
    url: "https://chatgpt.com/c/fixture",
    runs: [
      {
        id: "r1",
        requestId: "initial",
        inputHash: sha("Review"),
        prompt: "Review",
        promptHash: sha("Review"),
        marker: "marker",
        state: "waiting",
        userMessageId: "u1",
        createdAt: new Date().toISOString(),
      },
    ],
  };
  store.write("config", config);
  store.write("task-task", task);
  const run = async (operation: string, runId = "r1", extra: string[] = []) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "--state-dir",
        store.root,
        "--config-dir",
        join(root, "prefs"),
        "conversation",
        operation,
        "--id",
        "task",
        "--run",
        runId,
        ...extra,
      ],
      {
        env: {
          ...childEnv(),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { value: out ? JSON.parse(out) : null, err, code };
  };
  try {
    const status = await run("status");
    expect(status.code).toBe(0);
    expect(status.value.summary).toMatchObject({
      delivery: "confirmed",
      state: "waiting",
      nextAction: "wait",
    });
    const selected = await run("status", "r1", [
      "--fields",
      "id, currentRun,summary,workspaceMismatch,missing,toString,__proto__",
    ]);
    expect(selected.code).toBe(0);
    expect(selected.value).toEqual(
      JSON.parse(
        JSON.stringify({
          id: "task",
          currentRun: "r1",
          summary: status.value.summary,
          workspaceMismatch: null,
          missing: null,
          toString: null,
          ["__proto__"]: null,
        }),
      ),
    );
    const listed = await run("list", "r1", ["--fields", "id,state"]);
    expect(listed.code).toBe(0);
    expect(listed.value).toEqual([{ id: "task", state: "waiting" }]);
    for (const fields of ["", "id,", "summary.state"]) {
      const invalid = await run("finish", "r1", ["--fields", fields]);
      expect(invalid.code).toBe(1);
      expect(invalid.value).toBeNull();
      expect(invalid.err).toContain("INVALID_FIELDS");
      expect(store.read<any>("task-task")).toEqual(task);
    }
    const promptFile = join(root, "prompt.md");
    const evidenceFile = join(root, "rejection.json");
    writeFileSync(promptFile, "Review");
    writeFileSync(evidenceFile, "[]");
    const recoveryArgs = [
      "--expected-user-message",
      "u1",
      "--expected-url",
      task.url,
      "--prompt-file",
      promptFile,
      "--evidence-file",
      evidenceFile,
      "--rejected-at",
      "1789714178071",
      "--reason",
      "Verified challenge rejection",
    ];
    const incompleteRecovery = await run("recover-send", "r1", recoveryArgs);
    expect(incompleteRecovery.code).toBe(1);
    expect(incompleteRecovery.err).toContain("confirm-cloudflare-challenge");
    const unsafeRecovery = await run("recover-send", "r1", [
      ...recoveryArgs,
      "--confirm-cloudflare-challenge",
      "true",
    ]);
    expect(unsafeRecovery.code).toBe(1);
    expect(unsafeRecovery.err).toContain("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
    expect(store.read<any>("task-task")).toEqual(task);
    const otherWorkspace = join(root, "other-code");
    mkdirSync(otherWorkspace);
    const mismatch = await run("status", "r1", ["--workspace", otherWorkspace]);
    expect(mismatch.code).toBe(2);
    expect(mismatch.value.workspaceMismatch).toEqual({
      expected: otherWorkspace,
      bound: workspace,
      recovery: "inspect_saved_prompt_and_binding",
    });
    const selectedMismatch = await run("status", "r1", [
      "--workspace",
      otherWorkspace,
      "--fields",
      "id",
    ]);
    expect(selectedMismatch.code).toBe(2);
    expect(selectedMismatch.value).toEqual({ id: "task" });
    expect(
      (await run("retry", "r1", ["--workspace", otherWorkspace])).err,
    ).toContain("WORKSPACE_MISMATCH");
    expect(
      (
        await run("rebind-workspace", "r1", [
          "--from-workspace",
          workspace,
          "--workspace",
          otherWorkspace,
        ])
      ).err,
    ).toContain("RUN_NOT_PREPARED");
    expect(store.read<any>("task-task").config.workspace).toBe(workspace);
    const interrupted = await run("resume");
    expect(interrupted.code).toBe(2);
    expect(interrupted.value.summary).toMatchObject({
      delivery: "confirmed",
      state: "waiting",
      nextAction: "resume",
      phase: "observation_interrupted",
    });
    expect((await run("resume", "wrong-run")).code).toBe(1);
    task.runs[0] = {
      ...task.runs[0],
      state: "complete",
      reply: { id: "a1", role: "assistant", text: "Final result", final: true },
      replyHash: sha("Final result"),
      branch: ["u1", "a1"],
    };
    store.write("task-task", task);
    const complete = await run("resume");
    expect(complete.code).toBe(0);
    expect(complete.value.summary.nextAction).toBe("result");
    expect((await run("result")).value.reply.text).toBe("Final result");
    expect((await run("result", "r1", ["--fields", "reply"])).value).toEqual({
      reply: task.runs[0].reply,
    });
    const waited = await run("wait", "r1", ["--fields", "id,state"]);
    expect(waited.code).toBe(0);
    expect(waited.value).toEqual({ id: "task", state: "complete" });
    delete task.url;
    task.runs[0] = {
      ...task.runs[0],
      state: "prepared",
      userMessageId: undefined,
    };
    store.write("task-task", task);
    const corrected = await run("rebind-workspace", "r1", [
      "--from-workspace",
      workspace,
      "--workspace",
      otherWorkspace,
    ]);
    expect(corrected.code).toBe(0);
    expect(corrected.value.summary.workspace).toBe(otherWorkspace);
    expect(corrected.value.currentRun).toBe("r1");
    expect(corrected.value.runs[0].prompt).toBe("Review");
    expect(
      (await run("status", "r1", ["--workspace", otherWorkspace])).value
        .workspaceMismatch,
    ).toBeNull();
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI creates from stdin offline and start executes only a saved run", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-cli-queue-"));
  const workspace = join(root, "code");
  mkdirSync(workspace);
  const store = new State(join(root, "state"));
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return new Response("Unavailable", { status: 503 });
    },
  });
  store.write("config", {
    version: 1,
    workspace,
    cdp: `http://127.0.0.1:${server.port}`,
  });
  const run = async (args: string[], input?: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "--state-dir",
        store.root,
        "--config-dir",
        join(root, "prefs"),
        "conversation",
        ...args,
      ],
      {
        env: childEnv(),
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { value: out ? JSON.parse(out) : null, err, code };
  };
  try {
    const created = await run(
      [
        "create",
        "--id",
        "queued",
        "--prompt-stdin",
        "true",
        "--workspace",
        workspace,
      ],
      "完整 prompt\n第二行",
    );
    expect(created.code).toBe(0);
    expect(created.value.summary.nextAction).toBe("start");
    expect(requests).toBe(0);
    expect(store.read<any>("task-queued").runs[0].prompt).toContain(
      "完整 prompt\n第二行",
    );
    const again = await run([
      "create",
      "--id",
      "queued",
      "--prompt",
      "完整 prompt\n第二行",
    ]);
    expect(again.value.currentRun).toBe(created.value.currentRun);
    const conflict = await run([
      "create",
      "--id",
      "queued",
      "--prompt",
      "changed",
    ]);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("REQUEST_CONFLICT");
    const ambiguous = await run(
      ["create", "--id", "other", "--prompt", "x", "--prompt-stdin", "true"],
      "y",
    );
    expect(ambiguous.code).toBe(1);
    const sent = await run([
      "start",
      "--id",
      "queued",
      "--run",
      created.value.currentRun,
    ]);
    expect(sent.code).toBe(2);
    expect(requests).toBeGreaterThan(0);
    expect(sent.value.summary.state).toBe("prepared");
    expect(sent.value.summary.delivery).toBe("not_attempted");
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
