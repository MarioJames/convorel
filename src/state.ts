import { TaskStore } from "./task-store.ts";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { stateDirectory } from "./paths.ts";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return (
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
    ":" +
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  );
}
/** Lock namespaces. Per-task serialization equals per-tab, because a tab
 * binding is one task to one target (see Conversation.claim). */
export function taskLockName(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error("INVALID_TASK_ID");
  return "task-" + id;
}
export function registryLockName() {
  return "registry";
}
export function tabsLockName() {
  return "tabs";
}
export class State {
  readonly root: string;
  constructor(root = stateDirectory()) {
    if (process.platform !== "linux")
      throw new Error(
        "PLATFORM_UNSUPPORTED: v0.1 validates process ownership on Linux",
      );
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }
  path(key: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(key))
      throw new Error("INVALID_STATE_KEY");
    return join(this.root, key + ".json");
  }
  has(key: string) {
    this.path(key);
    if (key.startsWith("task-"))
      return (
        this.taskStore().read(key.slice(5)) !== undefined ||
        existsSync(this.path(key))
      );
    return existsSync(this.path(key));
  }
  read<T = any>(key: string): T {
    const x = JSON.parse(this.bytes(key));
    if (key.startsWith("task-")) {
      if (x.id !== key.slice(5)) throw new Error("TASK_ID_MISMATCH");
      if (!Array.isArray(x.runs)) throw new Error("TASK_RUNS_MISSING");
    }
    if (x.version !== 1) throw new Error("STATE_VERSION_UNSUPPORTED");
    return x;
  }
  write(key: string, value: any) {
    if (value.version !== 1) throw new Error("STATE_VERSION_REQUIRED");
    this.path(key);
    if (key.startsWith("task-")) {
      this.taskStore().write(
        key.slice(5),
        JSON.stringify(value, null, 2) + "\n",
      );
      return;
    }
    const path = this.path(key),
      tmp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(this.root, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  private taskStore() {
    return new TaskStore(this.root);
  }
  assertTaskWritable(id: string) {
    taskLockName(id);
    if (
      this.taskStore().read(id) === undefined &&
      existsSync(this.path("task-" + id))
    )
      throw new Error(
        `TASK_MIGRATION_REQUIRED: ${id}; use conversation migrate --id ${id}`,
      );
  }
  bytes(key: string) {
    const path = this.path(key);
    return (
      (key.startsWith("task-")
        ? this.taskStore().read(key.slice(5))
        : undefined) ?? readFileSync(path, "utf8")
    );
  }
  taskIds() {
    return [
      ...new Set([
        ...this.taskStore().ids(),
        ...readdirSync(this.root)
          .filter((f) => f.startsWith("task-") && f.endsWith(".json"))
          .map((f) => f.slice(5, -5)),
      ]),
    ].sort();
  }
  tasks() {
    return this.taskIds().map((id) => this.read<any>("task-" + id));
  }
  async migrateTask(id: string) {
    taskLockName(id);
    // Watchers retain their lock between polls; never migrate underneath one.
    return this.locked(
      () =>
        this.locked(
          () =>
            this.locked(
              () =>
                this.locked(async () => {
                  const existing = this.taskStore().read(id);
                  if (existing !== undefined)
                    return { id, migrated: false, alreadyStored: true };
                  const document = readFileSync(
                    this.path("task-" + id),
                    "utf8",
                  );
                  const value = JSON.parse(document);
                  if (
                    value.version !== 1 ||
                    value.id !== id ||
                    !Array.isArray(value.runs)
                  )
                    throw new Error("LEGACY_TASK_INVALID");
                  return this.taskStore().import(id, document);
                }, registryLockName()),
              taskLockName(id),
            ),
          "operation",
        ),
      "watch-" + id,
    );
  }
  /**
   * Acquire the named lock, run fn, then release. When waitForMs is set, a
   * contended lock is retried with jitter until the deadline; it is never
   * stolen from a live owner. Only after the deadline does it fail closed.
   */
  async locked<T>(
    fn: () => Promise<T>,
    name = "operation",
    waitForMs = 0,
  ): Promise<T> {
    const path = this.path("lock-" + name),
      token = randomUUID(),
      deadline = Date.now() + Math.max(0, waitForMs);
    let fd: number;
    for (;;) {
      try {
        fd = openSync(path, "wx", 0o600);
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error(
            `LOCK_BUSY: ${name}; inspect lock, then recover-lock if its exact owner is dead`,
          );
        await Bun.sleep(25 + Math.floor(Math.random() * 25));
      }
    }
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          identity: processIdentity(process.pid),
          token,
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      return await fn();
    } finally {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current.token === token) unlinkSync(path);
    }
  }
  /** Advisory liveness for status/list projection; the caller must not use it
   * to steal. A present-but-unreadable or metadata-invalid lock counts active. */
  isLockedActive(name: string): boolean {
    const key = "lock-" + name;
    if (!this.has(key)) return false;
    let x: any;
    try {
      x = this.read<any>(key);
    } catch {
      return true;
    }
    if (!Number.isSafeInteger(x.pid) || typeof x.identity !== "string")
      return true;
    let identity: string | undefined;
    try {
      identity = processIdentity(x.pid);
    } catch (e: any) {
      if (e.code !== "ENOENT") return true;
    }
    return identity === x.identity;
  }
  recoverLock(name: string) {
    const key = "lock-" + name,
      x = this.read<any>(key);
    if (!Number.isSafeInteger(x.pid) || typeof x.identity !== "string")
      throw new Error("LOCK_METADATA_INVALID");
    let identity: string | undefined;
    try {
      identity = processIdentity(x.pid);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (identity === x.identity) throw new Error("LOCK_OWNER_ALIVE");
    // Recovery never sends or closes a page. Browser requests may outlive their caller.
    const latest = this.read<any>(key);
    if (latest.token !== x.token) throw new Error("LOCK_CHANGED");
    unlinkSync(this.path(key));
    return {
      recovered: true,
      warning:
        "Prior browser side effects may be uncertain; resume observation before any new action.",
    };
  }
}
