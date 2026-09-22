// Background service manager for the tunnel client: start, stop, status, logs.
// It re-enters `tunnel run` as a detached supervisor whose output lands in a
// private log file, and relies on the registry record that supervisor writes.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { processIdentity } from "../storage/state.ts";
import { Workspace } from "../workspace/workspace.ts";
import { WorkspaceAccess, parseRoots } from "../workspace/access.ts";
import { preference } from "../config/preferences.ts";
import { childEnv } from "../process.ts";
import { selfExec } from "../runtime.ts";
import { recoverTunnelLock, tunnelKey, tunnelRegistry } from "./tunnel.ts";

const START_TIMEOUT_MS = 10_000;
const START_STABLE_MS = 2_000;
const STOP_TIMEOUT_MS = 20_000;

function alive(entry?: { pid?: number; identity?: string } | null) {
  const pid = entry?.pid,
    identity = entry?.identity;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof identity !== "string"
  )
    return false;
  try {
    if (processIdentity(pid) !== identity) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return false;
  }
}

type ProcessOwner = { pid: number; identity: string };

/** Capture ownership before TERM can remove the session/group leader. */
function orphanGroup(leader: ProcessOwner) {
  const unverified = () =>
    new Error(
      "SERVICE_STOP_UNVERIFIED: cannot prove ownership of the remaining client processes",
    );
  const inspect = (pid: number) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const identity = processIdentity(pid);
      if (identity.split(":")[1] !== fields[19]) throw unverified();
      return {
        pid,
        identity,
        live: !["Z", "X"].includes(fields[0]),
        group: Number(fields[2]),
        session: Number(fields[3]),
      };
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  const inGroup = (p: NonNullable<ReturnType<typeof inspect>>) =>
    p.group === leader.pid && p.session === leader.pid;
  const scan = () =>
    readdirSync("/proc")
      .filter((name) => /^[0-9]+$/.test(name))
      .map((name) => inspect(Number(name)))
      .filter((p): p is NonNullable<typeof p> => !!p?.live && inGroup(p));
  const before = inspect(leader.pid);
  if (!before?.live || before.identity !== leader.identity || !inGroup(before))
    throw unverified();
  const members = scan();
  if (
    !alive(leader) ||
    !members.some((p) => p.pid === leader.pid && p.identity === leader.identity)
  )
    throw unverified();
  const owned = new Map(members.map((p) => [p.pid, p.identity]));
  const remaining = () => {
    // Never infer ownership from an old PGID after its leader has exited. A
    // new member (or recycled PID/PGID) makes the result uncertain, not stopped.
    const current = scan();
    if (current.some((p) => owned.get(p.pid) !== p.identity))
      throw unverified();
    for (const member of members) {
      const p = inspect(member.pid);
      if (p?.live && p.identity === member.identity && !inGroup(p))
        throw unverified();
    }
    return current;
  };
  return {
    alive: () => remaining().length > 0,
    signal(signal: NodeJS.Signals) {
      for (const member of remaining()) {
        const current = inspect(member.pid);
        if (!current?.live || current.identity !== member.identity) continue;
        if (!inGroup(current)) throw unverified();
        try {
          process.kill(member.pid, signal);
        } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    },
  };
}

/** Serialize short lifecycle operations separately from the running client's lock. */
export async function manageService(
  action: "start" | "stop" | "restart",
  id: string,
  workspace?: string,
) {
  const registry = tunnelRegistry(),
    key = "manage-" + tunnelKey(id);
  if (registry.has("lock-" + key) && !registry.isLockedActive(key))
    registry.recoverLock(key);
  return registry.locked(
    async () => {
      if (action === "stop") return stopService(id);
      if (!workspace) throw new Error("WORKSPACE_REQUIRED");
      const root = new Workspace(workspace).root;
      const before = serviceStatus(id);
      if (before.workspace && before.workspace !== root)
        throw new Error("TUNNEL_WORKSPACE_CONFLICT");
      const configured = preference("mcp.roots");
      new WorkspaceAccess(
        configured ? parseRoots(configured) : [root],
      ).assertPrivate(registry.root);
      if (!Bun.which("tunnel-client"))
        throw new Error(
          "TUNNEL_CLIENT_MISSING: install official tunnel-client",
        );
      if (!preference("tunnel.apiKey"))
        throw new Error("TUNNEL_CREDENTIAL_MISSING: configure tunnel.apiKey");
      if (action === "restart") await stopService(id);
      return startService(id, root);
    },
    key,
    35_000,
  );
}

export function serviceLog(id: string) {
  return join(tunnelRegistry().root, tunnelKey(id) + ".log");
}

export function serviceStatus(id: string) {
  const registry = tunnelRegistry(),
    key = tunnelKey(id),
    log = serviceLog(id);
  const record = registry.has(key) ? registry.read<any>(key) : null;
  const supervisor = alive(record?.supervisor),
    client = alive(record);
  return {
    tunnelId: id,
    running: supervisor && client,
    supervisor: record?.supervisor
      ? { pid: record.supervisor.pid, alive: supervisor }
      : null,
    client: record?.pid ? { pid: record.pid, alive: client } : null,
    workspace: record?.workspace ?? null,
    readRoots: record?.readRoots ?? null,
    startedAt: record?.startedAt ?? null,
    exitCode: record?.exitCode ?? null,
    exitedAt: record?.exitedAt ?? null,
    locked: registry.isLockedActive(key),
    log: existsSync(log) ? log : null,
  };
}

function tail(text: string, lines: number) {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n") + (all.length ? "\n" : "");
}

export async function startService(id: string, workspace: string) {
  const registry = tunnelRegistry(),
    key = tunnelKey(id),
    log = serviceLog(id);
  const before = serviceStatus(id);
  if (before.running)
    return { started: false, alreadyRunning: true, ...before };
  if (before.supervisor?.alive || before.client?.alive)
    throw new Error(
      "SERVICE_STOPPING: a previous process is still exiting; run stop, then start again",
    );
  if (before.locked)
    throw new Error(
      "LOCK_BUSY: tunnel is starting or managed by another process",
    );
  // A lock whose recorded owner is provably dead is the only kind ever reclaimed.
  let recoveredStaleLock = false;
  if (registry.has("lock-" + key) && !registry.isLockedActive(key)) {
    recoverTunnelLock(id, workspace);
    recoveredStaleLock = true;
  }
  if (existsSync(log)) renameSync(log, log + ".previous");
  const fd = openSync(log, "a", 0o600);
  const [command, ...args] = selfExec(["tunnel", "run", "--tunnel-id", id]);
  const child = spawn(command, args, {
    cwd: registry.root,
    env: childEnv(),
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  child.unref();
  let exitCode: number | null | undefined;
  child.once("exit", (code) => (exitCode = code));
  child.once("error", () => (exitCode = null));
  const registered = () => {
    const record = registry.has(key) ? registry.read<any>(key) : null;
    return record?.supervisor?.pid === child.pid && alive(record);
  };
  const deadline = Date.now() + START_TIMEOUT_MS;
  let stableSince: number | undefined;
  while (Date.now() < deadline + START_STABLE_MS) {
    if (exitCode !== undefined) break;
    if (registered()) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= START_STABLE_MS)
        return { started: true, recoveredStaleLock, ...serviceStatus(id) };
    } else if (stableSince !== undefined || Date.now() >= deadline) break;
    await Bun.sleep(200);
  }
  const reason =
    exitCode !== undefined
      ? `supervisor exited with ${exitCode}`
      : stableSince !== undefined
        ? "client exited right after starting"
        : `not registered within ${START_TIMEOUT_MS / 1000}s`;
  const excerpt = existsSync(log) ? tail(readFileSync(log, "utf8"), 20) : "";
  // A failed start must not leave this invocation's supervisor running.
  if (exitCode === undefined) {
    const record = registry.has(key) ? registry.read<any>(key) : null;
    if (record?.supervisor?.pid === child.pid) await stopService(id);
    else {
      child.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }
  throw new Error(`SERVICE_START_FAILED: ${reason}; log ${log}\n${excerpt}`);
}

export async function stopService(id: string) {
  const registry = tunnelRegistry(),
    key = tunnelKey(id);
  const status = serviceStatus(id);
  if (!status.supervisor?.alive && !status.client?.alive)
    return { stopped: false, ...status };
  const record = registry.read<any>(key);
  const signalled: string[] = [];
  let orphan: ReturnType<typeof orphanGroup> | undefined;
  if (alive(record.supervisor)) {
    try {
      process.kill(record.supervisor.pid, "SIGTERM");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
    signalled.push("supervisor:SIGTERM");
  } else {
    orphan = orphanGroup(record);
    orphan.signal("SIGTERM");
    signalled.push("client:SIGTERM");
  }
  const settled = () => {
    const s = serviceStatus(id);
    return !s.supervisor?.alive && !s.client?.alive && !orphan?.alive()
      ? s
      : undefined;
  };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    if (orphan && !alive(record) && orphan.alive()) {
      orphan.signal("SIGKILL");
      if (!signalled.includes("client:SIGKILL"))
        signalled.push("client:SIGKILL");
    }
    const s = settled();
    if (s) return { stopped: true, signalled, ...s };
  }
  const late = serviceStatus(id);
  if (!late.supervisor?.alive && late.client?.alive) {
    orphan ??= orphanGroup(record);
    orphan.signal("SIGKILL");
    signalled.push("client:SIGKILL");
    await Bun.sleep(500);
    const s = settled();
    if (s) return { stopped: true, signalled, ...s };
  }
  throw new Error(
    `SERVICE_STOP_TIMEOUT: still alive after ${STOP_TIMEOUT_MS / 1000}s; inspect status`,
  );
}

export async function serviceLogs(
  id: string,
  lines: number,
  follow: boolean,
  signal: AbortSignal,
  write: (text: string) => void = (text) => process.stdout.write(text),
) {
  if (!Number.isInteger(lines) || lines < 1 || lines > 100_000)
    throw new Error("INVALID_LINES");
  const log = serviceLog(id);
  if (!existsSync(log))
    throw new Error(`LOG_NOT_FOUND: ${log}; start the service first`);
  const content = readFileSync(log, "utf8");
  write(tail(content, lines));
  if (!follow) return 0;
  let offset = Buffer.byteLength(content);
  let inode = statSync(log).ino;
  while (!signal.aborted) {
    await Bun.sleep(500);
    if (!existsSync(log)) continue;
    const info = statSync(log),
      size = info.size;
    if (info.ino !== inode || size < offset) offset = 0;
    inode = info.ino;
    if (size > offset) {
      write(await Bun.file(log).slice(offset, size).text());
      offset = size;
    }
  }
  return 0;
}
