import { test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runProcess, childEnv } from "../src/process.ts";
import { inspectProcess } from "../src/process-info.ts";
import { MemoryAccess } from "../src/mcp/memory.ts";
import { processIdentity, State } from "../src/storage/state.ts";

const task =
  process.env.CONVOREL_RUNTIME_TEST_DIR ?? "/tmp/convorel-runtime-tests";
mkdirSync(task, { recursive: true });
function live(pid: number) {
  return !!inspectProcess(pid)?.live;
}
async function fixture(exit: boolean, pipes = true) {
  const dir = mkdtempSync(join(task, "process-"));
  const file = join(dir, "pids.json"),
    backend = join(dir, "backend");
  writeFileSync(
    backend,
    `#!${process.execPath} --no-env-file\nimport {writeFileSync} from 'node:fs';const p=Bun.spawn(['/bin/sleep','60'],{stdio:['ignore',${pipes ? "'inherit','inherit'" : "'ignore','ignore'"}]});p.unref();writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,p.pid]));${exit ? "process.exit(23)" : "setInterval(()=>{},1000)"};`,
    { mode: 0o700 },
  );
  const owners: { pid: number; identity: string }[] = [];
  return {
    dir,
    backend,
    async ready() {
      for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10);
      const pids: number[] = JSON.parse(readFileSync(file, "utf8"));
      for (const pid of pids) {
        try {
          owners.push({ pid, identity: processIdentity(pid) });
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      return pids;
    },
    async cleanup() {
      for (const p of owners)
        if (live(p.pid) && processIdentity(p.pid) === p.identity)
          process.kill(p.pid, "SIGKILL");
      await Bun.sleep(30);
    },
  };
}

test.each([false, true])(
  "command bounds inherited pipes and reclaims descendants (early exit=%s)",
  async (early) => {
    const f = await fixture(early);
    const started = Date.now();
    const pending = runProcess([f.backend], 0.2).then(
      (x) => x,
      (e) => String(e),
    );
    const pids = await f.ready();
    try {
      const result = await Promise.race([
        pending,
        Bun.sleep(1400).then(() => "STILL_PENDING"),
      ]);
      expect(result).not.toBe("STILL_PENDING");
      expect(result).toContain(early ? "COMMAND_FAILED" : "COMMAND_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(1400);
      expect(live(pids[1])).toBe(false);
    } finally {
      await f.cleanup();
      await pending;
    }
  },
);

test.each(["cancel", "timeout", "exit"])(
  "memory %s reclaims backend descendants before releasing active",
  async (mode) => {
    const f = await fixture(mode === "exit", false);
    const memory = new MemoryAccess(["viking://user/test/memories"], f.backend);
    const input = {
      action: "read" as const,
      uri: "viking://user/test/memories/file.md",
      limit: 5,
    };
    const abort = new AbortController();
    const pending = memory.call(input, abort.signal).then(
      () => "success",
      (e) => String(e),
    );
    const pids = await f.ready();
    try {
      if (mode === "cancel") abort.abort();
      expect(await pending).toContain("MEMORY_BACKEND_FAILED");
      expect(live(pids[1])).toBe(false);
      writeFileSync(
        f.backend,
        `#!/bin/sh\nprintf '%s\\n' '{"ok":true,"result":"recovered"}'\n`,
        { mode: 0o700 },
      );
      expect((await memory.call(input)).content).toBe("recovered");
    } finally {
      await f.cleanup();
    }
  },
  25000,
);

test("tunnel abnormal client exit reclaims descendants before recording exit", async () => {
  const f = await fixture(true, false);
  for (const d of ["workspace", "bin"]) mkdirSync(join(f.dir, d));
  writeFileSync(join(f.dir, "bin/tunnel-client"), readFileSync(f.backend), {
    mode: 0o700,
  });
  new State(join(f.dir, "state")).write("config", {
    version: 1,
    workspace: join(f.dir, "workspace"),
    cdp: "http://127.0.0.1:1",
  });
  new State(join(f.dir, "prefs")).write("preferences", {
    version: 1,
    values: {
      "tunnel.id": "tunnel_" + "a".repeat(32),
      "tunnel.apiKey": "fixture-only",
    },
  });
  const p = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "--config-dir",
      join(f.dir, "prefs"),
      "--state-dir",
      join(f.dir, "state"),
      "tunnel",
      "run",
    ],
    {
      env: {
        ...childEnv(),
        HOME: f.dir,
        PATH: join(f.dir, "bin") + ":" + process.env.PATH,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pids = await f.ready();
  try {
    expect(await p.exited).toBe(23);
    expect(live(pids[1])).toBe(false);
  } finally {
    await f.cleanup();
    p.kill("SIGKILL");
    await p.exited;
  }
});

test("parent SIGKILL closes the lifetime pipe while the command is still running", async () => {
  const f = await fixture(false, false);
  const worker = join(f.dir, "worker.ts");
  writeFileSync(
    worker,
    `import {runProcess} from ${JSON.stringify(join(import.meta.dir, "../src/process.ts"))};await runProcess([${JSON.stringify(f.backend)}],60);`,
  );
  const parent = Bun.spawn([process.execPath, "--no-env-file", worker], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pids = await f.ready();
  const anchor = (() => {
    if (process.platform === "darwin")
      return Number(
        execFileSync("/bin/ps", ["-p", String(pids[0]), "-o", "ppid="], {
          encoding: "utf8",
        }).trim(),
      );
    const stat = readFileSync(`/proc/${pids[0]}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  })();
  const identity = processIdentity(anchor);
  try {
    parent.kill("SIGKILL");
    await parent.exited;
    for (let i = 0; i < 50 && [anchor, ...pids].some(live); i++)
      await Bun.sleep(10);
    expect([anchor, ...pids].filter(live)).toEqual([]);
  } finally {
    await f.cleanup();
    if (live(anchor) && processIdentity(anchor) === identity)
      process.kill(anchor, "SIGKILL");
    parent.kill("SIGKILL");
    await parent.exited;
  }
});

test("ordinary command completion preserves an explicitly detached daemon", async () => {
  const f = await fixture(false, false);
  writeFileSync(
    f.backend,
    `#!${process.execPath} --no-env-file\nimport {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn('/bin/sleep',['60'],{detached:true,stdio:'ignore'});p.unref();writeFileSync(${JSON.stringify(join(f.dir, "pids.json"))},JSON.stringify([process.pid,p.pid]));console.log('daemon ready');`,
    { mode: 0o700 },
  );
  const pending = runProcess([f.backend], 2);
  const pids = await f.ready();
  try {
    expect(await pending).toBe("daemon ready\n");
    expect(live(pids[1])).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("memory rejects a pre-aborted call without starting the executable", async () => {
  const f = await fixture(false);
  const controller = new AbortController();
  controller.abort();
  const memory = new MemoryAccess(["viking://user/test/memories"], f.backend);
  await expect(
    memory.call(
      { action: "read", uri: "viking://user/test/memories/file.md", limit: 5 },
      controller.signal,
    ),
  ).rejects.toThrow("MEMORY_BACKEND_FAILED");
  expect(existsSync(join(f.dir, "pids.json"))).toBe(false);
});

test("memory output overflow reclaims the backend and allows a later call", async () => {
  const f = await fixture(false, false);
  const original = readFileSync(f.backend, "utf8");
  writeFileSync(
    f.backend,
    original + "\nprocess.stdout.write('x'.repeat(2_000_000));",
    { mode: 0o700 },
  );
  const memory = new MemoryAccess(["viking://user/test/memories"], f.backend);
  const input = {
    action: "read" as const,
    uri: "viking://user/test/memories/file.md",
    limit: 5,
  };
  const pending = memory.call(input).then(
    () => "success",
    (e) => String(e),
  );
  const pids = await f.ready();
  try {
    expect(await pending).toContain("MEMORY_BACKEND_FAILED");
    expect(live(pids[1])).toBe(false);
    writeFileSync(
      f.backend,
      `#!/bin/sh\nprintf '%s\\n' '{"ok":true,"result":"recovered"}'\n`,
      { mode: 0o700 },
    );
    expect((await memory.call(input)).content).toBe("recovered");
  } finally {
    await f.cleanup();
  }
});

test("an escaped daemon holding output cannot prevent command completion", async () => {
  const f = await fixture(false, false);
  writeFileSync(
    f.backend,
    `#!${process.execPath} --no-env-file\nimport {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn('/bin/sleep',['60'],{detached:true,stdio:['ignore','inherit','inherit']});p.unref();writeFileSync(${JSON.stringify(join(f.dir, "pids.json"))},JSON.stringify([process.pid,p.pid]));`,
    { mode: 0o700 },
  );
  const pending = runProcess([f.backend], 2).then(
    () => "success",
    (e) => String(e),
  );
  const pids = await f.ready();
  try {
    expect(
      await Promise.race([
        pending,
        Bun.sleep(1000).then(() => "STILL_PENDING"),
      ]),
    ).toContain("COMMAND_OUTPUT_TIMEOUT");
    expect(live(pids[1])).toBe(true);
  } finally {
    await f.cleanup();
    await pending;
  }
});
