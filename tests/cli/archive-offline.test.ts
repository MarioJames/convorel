import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive/store.ts";
import { sha } from "../../src/hash.ts";

test("snapshot reads neither need nor mutate live state and never borrow its coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-offline-read-"));
  try {
    const archive = new Archive(join(root, "source"));
    archive.publish(
      {
        version: 1,
        id: "sample",
        config: { version: 1, workspace: "/deleted", cdp: "9222" },
        workspaceId: "sample",
        currentRun: "r1",
        attemptId: "a1",
        runs: [
          {
            id: "r1",
            requestId: "initial",
            inputHash: sha("sample"),
            promptHash: sha("sample"),
            prompt: "sample",
            marker: "sample",
            state: "prepared",
            createdAt: "2026-09-21T00:00:00Z",
          },
        ],
      },
      "sample",
    );
    const version = archive.history("sample").versions[0].version_id;
    const snapshot = archive.exportSnapshot(join(root, "snapshot"));
    archive.close();
    const blocked = join(root, "state-file");
    writeFileSync(blocked, "unrelated file");
    const untouched = join(root, "existing-state");
    mkdirSync(untouched, { mode: 0o755 });
    writeFileSync(join(untouched, "task-invalid.json"), "invalid");
    const absent = join(root, "absent-state");
    for (const state of [blocked, untouched, absent]) {
      for (const args of [
        ["history", "--id", "sample"],
        ["search", "--query", "sample", "--task", "sample"],
        ["content", "--version", version],
      ]) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "../../src/cli.ts"),
            "--state-dir",
            state,
            "--config-dir",
            blocked,
            "conversation",
            ...args,
            "--from",
            snapshot.path,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [code, out, err] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        const result = JSON.parse(out);
        if (args[0] !== "content")
          expect(result.coverage).toMatchObject({ state: "unknown" });
      }
    }
    expect(statSync(untouched).mode & 0o777).toBe(0o755);
    expect(existsSync(absent)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
