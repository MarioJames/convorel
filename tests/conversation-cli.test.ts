import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
  const run = async (operation: string, runId = "r1") => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "conversation",
        operation,
        "--id",
        "task",
        "--run",
        runId,
      ],
      {
        env: {
          ...childEnv(),
          CONVOREL_HOME: store.root,
          CONVOREL_MCP_ROOTS: JSON.stringify([workspace]),
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
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
