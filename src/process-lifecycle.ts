import { spawn } from "node:child_process";
import { inspectProcess, processes } from "./process-info.ts";

export type ProcessOwner = { pid: number; identity: string };
const inspect = inspectProcess;
function processAlive(owner?: ProcessOwner | null) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
    return false;
  const current = inspect(owner.pid);
  return !!current?.live && current.identity === owner.identity;
}
function signalOwner(owner: ProcessOwner, signal: NodeJS.Signals) {
  if (!processAlive(owner)) return;
  try {
    process.kill(owner.pid, signal);
  } catch (e: any) {
    if (e.code !== "ESRCH") throw e;
  }
}

/** A live session anchor prevents its session ID from being recycled. Never
 * discover new ownership using only a dead leader's numeric PID/PGID. */
function sessionMembers(owner: ProcessOwner) {
  const belongs = (p: { session: string; group: number }, session: string) =>
    process.platform === "darwin"
      ? p.group === owner.pid
      : p.session === session;
  const valid = () => {
    const current = inspect(owner.pid);
    return (
      current?.live &&
      current.identity === owner.identity &&
      (process.platform !== "linux" || current.session === String(owner.pid)) &&
      current.group === owner.pid
    );
  };
  if (!valid())
    throw new Error(
      "PROCESS_CLEANUP_UNVERIFIED: session anchor is no longer owned",
    );
  const session = inspect(owner.pid)!.session;
  const members = processes().filter((p) => p.live && belongs(p, session));
  if (!valid())
    throw new Error(
      "PROCESS_CLEANUP_UNVERIFIED: session anchor changed during inspection",
    );
  return members;
}

/** For recovery without a supervisor, freeze membership before signalling the
 * live leader. New members after its exit cannot be safely inferred. */
export function orphanGroup(leader: ProcessOwner) {
  const unverified = () =>
    new Error(
      "SERVICE_STOP_UNVERIFIED: cannot prove ownership of the remaining client processes",
    );
  let members: ReturnType<typeof sessionMembers>;
  try {
    members = sessionMembers(leader);
  } catch {
    throw unverified();
  }
  const session = members.find((p) => p.pid === leader.pid)?.session;
  if (!session) throw unverified();
  const owned = new Map(members.map((p) => [p.pid, p.identity]));
  const belongs = (p: { session: string; group: number }) =>
    process.platform === "darwin"
      ? p.group === leader.pid
      : p.session === session;
  const remaining = () => {
    const current = processes().filter((p) => p.live && belongs(p));
    if (current.some((p) => owned.get(p.pid) !== p.identity))
      throw unverified();
    for (const member of members) {
      const p = inspect(member.pid);
      if (p?.live && p.identity === member.identity && !belongs(p))
        throw unverified();
    }
    return current;
  };
  return {
    alive: () => remaining().length > 0,
    signal(signal: NodeJS.Signals) {
      for (const member of remaining()) signalOwner(member, signal);
    },
  };
}

// The shell stays alive after the command exits, so cleanup can still prove
// session ownership. fd 3 reports command status; stdin is a private lifetime
// pipe. EOF (including parent death) kills the anchored group, never a stale ID.
const guard = `trap 'kill -KILL 0' EXIT
exec 4<&0
(read -r release <&4; kill -KILL 0) 3>&- &
"$@" </dev/null 3>&- 4<&- &
command=$!
wait "$command"
code=$?
printf '%s\\n' "$code" >&3
read -r release
`;
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  reason: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function spawnManaged(
  argv: string[],
  options: {
    env: Record<string, string>;
    cwd?: string;
    stdio?: "pipe" | "inherit";
  },
) {
  const child = spawn("/bin/sh", ["-c", guard, "convorel-process", ...argv], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", options.stdio ?? "pipe", options.stdio ?? "pipe", "pipe"],
  });
  const owner = child.pid ? inspect(child.pid) : undefined;
  const guardExited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("PROCESS_ANCHOR_EXITED")));
    const status = child.stdio[3] as import("node:stream").Readable;
    let text = "";
    status.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes("\n")) {
        const value = text.trim();
        if (/^\d+$/.test(value)) resolve(Number(value));
        else reject(new Error("PROCESS_STATUS_INVALID"));
      }
    });
  });
  void exited.catch(() => {});
  let cleanup: Promise<void> | undefined;
  const dispose = () =>
    (cleanup ??= (async () => {
      try {
        if (owner) {
          // Keep the anchor alive until every owned member has been signalled.
          for (const p of sessionMembers(owner))
            if (p.pid !== owner.pid) signalOwner(p, "SIGTERM");
          for (let i = 0; i < 20; i++) {
            const members = sessionMembers(owner).filter(
              (p) => p.pid !== owner.pid,
            );
            if (!members.length) break;
            for (const p of members) signalOwner(p, "SIGKILL");
            await Bun.sleep(10);
            if (
              i === 19 &&
              sessionMembers(owner).some((p) => p.pid !== owner.pid)
            )
              throw new Error("PROCESS_CLEANUP_TIMEOUT");
          }
          signalOwner(owner, "SIGKILL");
        }
        await bounded(guardExited, 250, "PROCESS_CLEANUP_TIMEOUT");
      } finally {
        child.stdin?.destroy();
        (child.stdio[3] as import("node:stream").Readable)?.destroy();
      }
    })());
  return { child, owner, exited, dispose };
}

export async function executeManaged(
  argv: string[],
  options: {
    env: Record<string, string>;
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    maxBuffer?: number;
  },
) {
  if (options.signal?.aborted) throw new Error("COMMAND_CANCELLED");
  const managed = spawnManaged(argv, options);
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let failure: Error | undefined;
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(failure);
  });
  const fail = (message: string) => {
    failure ??= new Error(message);
    stop();
  };
  const capture = (
    stream: import("node:stream").Readable | null,
    chunks: Buffer[],
  ) => {
    let bytes = 0;
    stream?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? Infinity)) fail("COMMAND_OUTPUT_LIMIT");
      else chunks.push(chunk);
    });
    stream?.on("error", () => fail("COMMAND_OUTPUT_FAILED"));
    return new Promise<void>((resolve) => {
      stream?.once("close", resolve);
      if (!stream) resolve();
    });
  };
  const closed = Promise.all([
    capture(managed.child.stdout, stdout),
    capture(managed.child.stderr, stderr),
  ]);
  const abort = () => fail("COMMAND_CANCELLED");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => fail("COMMAND_TIMEOUT"), options.timeoutMs);
  try {
    const code = await Promise.race([managed.exited, interrupted]);
    await managed.dispose();
    // A descendant that escaped the session must not hold the caller's pipes.
    await bounded(closed, 250, "COMMAND_OUTPUT_TIMEOUT");
    if (failure) throw failure;
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    try {
      await managed.dispose();
    } finally {
      managed.child.stdout?.destroy();
      managed.child.stderr?.destroy();
    }
  }
}
