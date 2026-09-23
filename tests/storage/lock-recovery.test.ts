import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State } from "../../src/storage/state.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lock-recovery-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function waitFor(path: string) {
  const deadline = Date.now() + 4000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("BARRIER_TIMEOUT: " + path);
    await Bun.sleep(5);
  }
}

test("killing an acquirer during metadata write never publishes a partial lock", async () => {
  const ready = join(root, "partial-write"),
    lock = join(root, "lock-race.json");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { mock } from 'bun:test';
    import * as fs from 'node:fs';
    const realWrite = fs.writeFileSync;
    mock.module('node:fs', () => ({ ...fs, writeFileSync: (fd, data, ...args) => {
      if (typeof fd === 'number' && fs.readlinkSync('/proc/self/fd/' + fd).startsWith(${JSON.stringify(lock)})) {
        realWrite(fd, '{');
        realWrite(${JSON.stringify(ready)}, 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
      }
      return realWrite(fd, data, ...args);
    }}));
    const { State } = await import(${JSON.stringify(join(import.meta.dir, "../../src/storage/state.ts"))});
    await new State(${JSON.stringify(root)}).locked(async () => {}, 'race');
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    await waitFor(ready);
    // Only the private staging file may be partial. The public lock must be
    // absent or a complete recoverable owner record, at every write boundary.
    if (existsSync(lock))
      expect(() => JSON.parse(readFileSync(lock, "utf8"))).not.toThrow();
    child.kill("SIGKILL");
    await child.exited;
    const state = new State(root);
    if (existsSync(lock))
      expect(state.recoverLock("race").recovered).toBe(true);
    await state.locked(async () => {}, "race");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});

test("two real recovery processes cannot unlink a newly acquired live lock", async () => {
  const state = new State(root);
  state.write("lock-race", {
    version: 1,
    pid: process.pid,
    identity: "stale",
    token: "old",
  });
  const prelude = `
    import { State } from ${JSON.stringify(join(import.meta.dir, "../../src/storage/state.ts"))};
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = ${JSON.stringify(root)};
    const mark = name => writeFileSync(join(root, name), 'ready');
    const wait = name => {
      const deadline = Date.now() + 7000, buffer = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(join(root, name))) {
        if (Date.now() > deadline) throw new Error('BARRIER_TIMEOUT');
        Atomics.wait(buffer, 0, 0, 5);
      }
    };`;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (code: string) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", prelude + code],
      { stdout: "pipe", stderr: "pipe" },
    );
    children.push(child);
    return child;
  };
  try {
    const recoverer = spawn(`
      let reads = 0;
      class Paused extends State {
        read(key) {
          const result = super.read(key);
          if (key === 'lock-race' && ++reads === 2) { mark('paused'); wait('resume'); }
          return result;
        }
      }
      new Paused(root).recoverLock('race');`);
    await waitFor(join(root, "paused"));
    const owner = spawn(`
      const state = new State(root);
      mark('contending');
      try { state.recoverLock('race'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await state.locked(async () => { mark('owned'); wait('release'); }, 'race', 3000);`);
    await waitFor(join(root, "contending"));
    await Bun.sleep(150);
    // Recovery A is between its final read and deletion. B must be excluded.
    expect(existsSync(join(root, "owned"))).toBe(false);
    writeFileSync(join(root, "resume"), "go");
    expect(await recoverer.exited).toBe(0);
    await waitFor(join(root, "owned"));
    await expect(state.locked(async () => {}, "race")).rejects.toThrow(
      "LOCK_BUSY",
    );
    expect(() => state.recoverLock("race")).toThrow("LOCK_OWNER_ALIVE");
    writeFileSync(join(root, "release"), "go");
    expect(await owner.exited).toBe(0);
    for (const child of children)
      expect(await new Response(child.stderr as ReadableStream).text()).toBe(
        "",
      );
    await state.locked(async () => {}, "race");
  } finally {
    writeFileSync(join(root, "resume"), "go");
    writeFileSync(join(root, "release"), "go");
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
}, 15000);
