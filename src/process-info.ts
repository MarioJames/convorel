import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export type ProcessInfo = {
  pid: number;
  identity: string;
  live: boolean;
  group: number;
  session: string;
};

const linuxBoot =
  process.platform === "linux"
    ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    : "";

function linuxProcess(pid: number): ProcessInfo | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      identity: `${linuxBoot}:${fields[19]}`,
      live: !["Z", "X"].includes(fields[0]),
      group: Number(fields[2]),
      session: fields[3],
    };
  } catch (error: any) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
  }
}

function darwinProcesses(pid?: number): ProcessInfo[] {
  let output: string;
  try {
    output = execFileSync(
      "/bin/ps",
      [
        ...(pid ? ["-p", String(pid)] : ["-A"]),
        "-o",
        "pid=,pgid=,sess=,state=,lstart=",
      ],
      { encoding: "utf8" },
    );
  } catch (error: any) {
    if (pid && error.status === 1 && !error.stderr?.toString().trim())
      return [];
    throw error;
  }
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({
      pid: Number(match[1]),
      identity: `darwin:${match[5]}`,
      live: !["Z", "X"].includes(match[4][0]),
      group: Number(match[2]),
      session: match[3],
    }));
}

export function processes(): ProcessInfo[] {
  if (process.platform === "darwin") return darwinProcesses();
  if (process.platform === "linux")
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((name) => linuxProcess(Number(name)))
      .filter((item): item is ProcessInfo => !!item);
  throw new Error("PLATFORM_UNSUPPORTED");
}

export function inspectProcess(pid: number): ProcessInfo | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "darwin") return darwinProcesses(pid)[0];
  if (process.platform === "linux") return linuxProcess(pid);
  throw new Error("PLATFORM_UNSUPPORTED");
}
