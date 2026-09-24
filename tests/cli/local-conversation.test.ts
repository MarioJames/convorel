import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../../src/storage/state.ts";
import { sha } from "../../src/hash.ts";
import { childEnv } from "../../src/process.ts";
import type { Task } from "../../src/conversation/types.ts";

test("saved conversation queries survive a deleted workspace and missing live configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-local-query-"));
  const store = new State(join(root, "state"));
  const task: Task = {
    version: 1,
    id: "saved",
    config: { version: 1, workspace: join(root, "deleted-code"), cdp: "9222" },
    workspaceId: "deleted-code",
    currentRun: "r1",
    attemptId: "a1",
    url: "https://chatgpt.com/c/saved",
    runs: [
      {
        id: "r1",
        requestId: "initial",
        inputHash: sha("question"),
        prompt: "question",
        promptHash: sha("question"),
        marker: "marker",
        state: "complete",
        userMessageId: "u1",
        createdAt: "2026-09-22T00:00:00Z",
        reply: {
          id: "a1",
          role: "assistant",
          text: "answer",
          markdown: "answer",
          final: true,
        },
        replyHash: sha("answer"),
        branch: ["u1", "a1"],
      },
    ],
  };
  store.write("task-saved", task);
  const run = async (args: string[]) => {
    const p = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../src/cli.ts"),
        "--state-dir",
        store.root,
        "--config-dir",
        join(root, "preferences"),
        "conversation",
        ...args,
      ],
      { env: childEnv(), stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  };
  try {
    for (const configured of [false, true]) {
      if (configured) store.write("config", task.config);
      const listed = await run(["list"]);
      expect({ code: listed.code, err: listed.err }).toEqual({
        code: 0,
        err: "",
      });
      expect(JSON.parse(listed.out)).toMatchObject([
        { id: "saved", state: "complete" },
      ]);
      const status = await run(["status", "--id", "saved", "--run", "r1"]);
      expect({ code: status.code, err: status.err }).toEqual({
        code: 0,
        err: "",
      });
      expect(JSON.parse(status.out).summary).toMatchObject({
        state: "complete",
        delivery: "confirmed",
      });
      const result = await run(["result", "--id", "saved", "--run", "r1"]);
      expect({ code: result.code, err: result.err }).toEqual({
        code: 0,
        err: "",
      });
      expect(JSON.parse(result.out)).toMatchObject({
        reply: { markdown: "answer" },
        archive: { status: "stored" },
      });
      const stale = await run(["result", "--id", "saved", "--run", "old"]);
      expect(stale.code).toBe(1);
      expect(stale.err).toContain("STALE_RUN");
      expect(store.read<Task>("task-saved")).toEqual(task);
    }
    for (const args of [
      ["resume", "--id", "saved", "--run", "r1"],
      ["capture", "--id", "saved"],
      ["finish", "--id", "saved", "--run", "r1"],
    ]) {
      const continued = await run(args);
      expect({ args, code: continued.code, err: continued.err }).toEqual({
        args,
        code: 0,
        err: "",
      });
    }
    mkdirSync(join(root, "preferences"));
    writeFileSync(
      join(root, "preferences/preferences.json"),
      JSON.stringify({
        version: 1,
        values: { "mcp.roots": JSON.stringify([root]) },
      }),
    );
    for (const args of [
      ["list"],
      ["status", "--id", "saved"],
      ["result", "--id", "saved"],
      ["resume", "--id", "saved", "--run", "r1"],
      ["capture", "--id", "saved"],
      ["finish", "--id", "saved", "--run", "r1"],
    ]) {
      const denied = await run(args);
      expect(denied.code).toBe(1);
      expect(denied.err).toContain("STATE_INSIDE_WORKSPACE");
      expect(denied.out).toBe("");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
