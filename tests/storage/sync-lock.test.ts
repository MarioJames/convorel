import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
  linkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withSyncLock } from "../../src/storage/sync-lock.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-lock-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const module = join(import.meta.dir, "../../src/storage/sync-lock.ts");

test.each(["symlink", "hardlink", "directory"])(
  "sync mutex rejects an existing %s",
  (kind) => {
    const path = join(root, "mutex.sqlite"),
      other = join(root, "other.sqlite");
    writeFileSync(other, "");
    if (kind === "symlink") symlinkSync(other, path);
    if (kind === "hardlink") linkSync(other, path);
    if (kind === "directory") mkdirSync(path);
    expect(() => withSyncLock(path, () => "must not run")).toThrow(
      "SYNC_LOCK_PATH_UNSAFE",
    );
  },
);

test("sync mutex serializes real process read/modify/write without losing successful updates", async () => {
  const file = join(root, "values.json"),
    mutex = join(root, "values.mutex.sqlite");
  writeFileSync(file, "{}");
  const children = Array.from({ length: 8 }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
    import { withSyncLock } from ${JSON.stringify(module)};
    import { readFileSync, writeFileSync } from 'node:fs';
    withSyncLock(${JSON.stringify(mutex)}, () => {
      const file = ${JSON.stringify(file)}, value = JSON.parse(readFileSync(file, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      value['key${i}'] = ${i};
      writeFileSync(file, JSON.stringify(value));
    });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );
  try {
    for (const child of children) {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    }
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`key${i}`, i])),
    );
    expect(statSync(mutex).mode & 0o777).toBe(0o600);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
});

test("sync mutex is bounded under contention and recovers after SIGKILL without deleting its file", async () => {
  const mutex = join(root, "mutex.sqlite"),
    ready = join(root, "ready");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import { withSyncLock } from ${JSON.stringify(module)};
    import { writeFileSync } from 'node:fs';
    withSyncLock(${JSON.stringify(mutex)}, () => {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    });`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("BARRIER_TIMEOUT");
      await Bun.sleep(5);
    }
    const inode = statSync(mutex).ino,
      started = Date.now();
    expect(() =>
      withSyncLock(
        mutex,
        () => {
          throw new Error("MUST_NOT_ENTER");
        },
        50,
      ),
    ).toThrow("database is locked");
    expect(Date.now() - started).toBeLessThan(1000);
    child.kill("SIGKILL");
    await child.exited;
    expect(withSyncLock(mutex, () => "recovered")).toBe("recovered");
    expect(statSync(mutex).ino).toBe(inode);
    expect(() =>
      withSyncLock(mutex, () => {
        throw new Error("CALLBACK_FAILED");
      }),
    ).toThrow("CALLBACK_FAILED");
    expect(withSyncLock(mutex, () => "after failure")).toBe("after failure");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
