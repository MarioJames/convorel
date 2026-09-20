import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State, processIdentity, taskLockName } from "../src/state.ts";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "convorel-state-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("state serializes writers, survives new instances, and stays private", async () => {
  const a = new State(root),
    b = new State(root);
  await a.locked(async () => {
    a.write("config", { version: 1, value: 2 });
    await expect(b.locked(async () => {})).rejects.toThrow(/lock/i);
  });
  expect(b.read<any>("config").value).toBe(2);
  expect(statSync(join(root, "config.json")).mode & 0o777).toBe(0o600);
  await b.locked(async () => b.write("config", { version: 1, value: 3 }));
  expect(a.read<any>("config").value).toBe(3);
});
test("corrupt state is not overwritten and path-like IDs are rejected", async () => {
  const s = new State(root);
  writeFileSync(join(root, "config.json"), "{ broken");
  expect(() => s.read("config")).toThrow();
  expect(() => s.read("../other")).toThrow();
  expect(() => s.write("../other", {})).toThrow();
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe("{ broken");
});
test("lock recovery rejects live owners and requires the exact stale identity", async () => {
  const s = new State(root);
  await s.locked(async () => {
    expect(() => s.recoverLock("operation")).toThrow("LOCK_OWNER_ALIVE");
  });
  s.write("lock-operation", {
    version: 1,
    pid: process.pid,
    identity: "different-boot-or-start",
    token: "stale",
  });
  expect(s.recoverLock("operation").recovered).toBe(true);
  await s.locked(async () => {});
});
test("a contended lock is retried until the holder releases, within its bounded window", async () => {
  const a = new State(root),
    b = new State(root);
  let holdRelease!: () => void;
  const hold = new Promise<void>((r) => (holdRelease = r));
  const held = a.locked(() => hold, "operation");
  const order: string[] = [];
  const waited = b
    .locked(
      async () => {
        order.push("acquired");
      },
      "operation",
      2000,
    )
    .then(() => order.push("done"));
  await Bun.sleep(50);
  expect(order).toEqual([]); // still contended by the live holder
  holdRelease();
  await held;
  await waited;
  expect(order).toEqual(["acquired", "done"]);
});
test("a contended lock fails closed after its bounded window without stealing the live owner", async () => {
  const a = new State(root),
    b = new State(root);
  const held = a.locked(() => Bun.sleep(500).then(() => "x"), "operation");
  await expect(b.locked(async () => "y", "operation", 80)).rejects.toThrow(
    "LOCK_BUSY",
  );
  expect(a.isLockedActive("operation")).toBe(true); // live owner retained
  await held;
  expect(a.isLockedActive("operation")).toBe(false);
});
test("isLockedActive reports absent, live, and stale lock ownership", () => {
  const s = new State(root);
  const key = taskLockName("alpha");
  expect(s.isLockedActive(key)).toBe(false);
  s.write("lock-" + key, {
    version: 1,
    pid: process.pid,
    identity: processIdentity(process.pid),
    token: "live",
  });
  expect(s.isLockedActive(key)).toBe(true);
  s.write("lock-" + key, {
    version: 1,
    pid: process.pid,
    identity: "dead-boot-or-start",
    token: "stale",
  });
  expect(s.isLockedActive(key)).toBe(false);
});
