import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { commandTokens } from "./command.ts";
import { WorkspaceAccess } from "../workspace/access.ts";
import { sha } from "../hash.ts";
import { stateDirectory } from "../paths.ts";

export const executionOutput = z.strictObject({
  command: z.string(),
  path: z.string(),
  rootId: z.string(),
  workspaceId: z.string(),
  workspacePath: z.string(),
  inputSha256: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  outputLimited: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  network: z.literal(false),
  dependencies: z.array(z.string()),
  note: z.string(),
});

export class ExecutionAccess {
  private active = false;
  constructor(
    private readonly access: WorkspaceAccess,
    readonly dependencyRoots: string[],
  ) {}
  available() {
    return (
      process.platform === "linux" &&
      ["bwrap", "prlimit", "bun"].every((name) => !!Bun.which(name))
    );
  }
  async run(
    command: string,
    cwd: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ) {
    const argv = commandTokens(command);
    if (
      !(argv.length === 2 && argv[0] === "bun" && argv[1] === "test") &&
      !(
        argv.length === 3 &&
        argv[0] === "bun" &&
        argv[1] === "run" &&
        /^(build|test|check|typecheck|dist)(:[a-zA-Z0-9_-]+)?$/.test(argv[2])
      )
    )
      throw new Error("EXEC_COMMAND_DENIED");
    if (!this.available()) throw new Error("EXEC_SANDBOX_UNAVAILABLE");
    if (this.active) throw new Error("EXEC_BUSY");
    if (signal?.aborted) throw new Error("EXEC_CANCELLED");
    const workspace = this.access.directory(cwd);
    const identity = this.access.identity(cwd);
    const files = workspace.executionFiles();
    const packageFile = files.find((file) => file.path === "package.json");
    if (!packageFile) throw new Error("EXEC_PACKAGE_REQUIRED");
    const pkg = JSON.parse(packageFile.bytes.toString("utf8"));
    if (pkg.packageManager && !String(pkg.packageManager).startsWith("bun@"))
      throw new Error("EXEC_PACKAGE_MANAGER_UNSUPPORTED");
    if (
      !pkg.packageManager &&
      !files.some((file) => ["bun.lock", "bun.lockb"].includes(file.path)) &&
      files.some((file) =>
        ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].includes(
          file.path,
        ),
      )
    )
      throw new Error("EXEC_PACKAGE_MANAGER_UNSUPPORTED");
    if (argv[1] === "run" && typeof pkg.scripts?.[argv[2]] !== "string")
      throw new Error("EXEC_SCRIPT_UNAVAILABLE");
    const inputSha256 = sha(
      JSON.stringify(
        files.map((file) => [file.path, file.mode, sha(file.bytes)]),
      ),
    );
    const dependencies = this.dependencyRoots.filter(
      (path) => path === join(workspace.root, "node_modules"),
    );
    for (const path of dependencies)
      if (realpathSync(path) !== path)
        throw new Error("EXEC_DEPENDENCY_SYMLINK_DENIED");
    const dir = mkdtempSync(join(tmpdir(), "convorel-exec-"));
    const source = join(dir, "input");
    mkdirSync(source);
    this.active = true;
    const startedAt = new Date().toISOString();
    try {
      for (const file of files) {
        const dest = join(source, file.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, file.bytes, { mode: file.mode });
      }
      const bwrap = [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--size",
        "268435456",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/home/sandbox",
        "--ro-bind",
        source,
        "/inputs",
        "--size",
        "536870912",
        "--tmpfs",
        "/workspace",
        "--ro-bind",
        realpathSync(Bun.which("bun")!),
        "/tools/bun",
        "--clearenv",
        "--setenv",
        "PATH",
        "/tools:/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/home/sandbox",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "CI",
        "1",
        "--setenv",
        "BUN_INSTALL_CACHE_DIR",
        "/tmp/bun-cache",
        "--chdir",
        "/workspace",
      ];
      for (const path of dependencies)
        bwrap.push("--ro-bind", path, "/dependencies");
      bwrap.push(
        "--remount-ro",
        "/",
        "--",
        "/usr/bin/prlimit",
        "--nproc=256",
        "--",
        "/bin/sh",
        "-c",
        'cp -a /inputs/. /workspace/ || exit 125; if [ -d /dependencies ]; then ln -s /dependencies /workspace/node_modules || exit 125; fi; exec /tools/bun "$@"',
        "convorel-exec",
        ...argv.slice(1),
      );
      const result = await new Promise<{
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        outputLimited: boolean;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          Bun.which("prlimit")!,
          [
            "--cpu=60",
            "--nofile=256",
            "--fsize=67108864",
            "--",
            Bun.which("bwrap")!,
            ...bwrap,
          ],
          {
            env: {},
            cwd: "/",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let timedOut = false,
          outputLimited = false,
          size = 0;
        const out: Buffer[] = [],
          err: Buffer[] = [];
        const kill = () => child.kill("SIGKILL");
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutSeconds * 1000);
        signal?.addEventListener("abort", kill, { once: true });
        const collect = (target: Buffer[]) => (chunk: Buffer) => {
          const remaining = Math.max(0, 8192 - size);
          if (remaining) target.push(chunk.subarray(0, remaining));
          size += chunk.length;
          if (size > 8192) outputLimited = true;
          if (size > 1024 * 1024) kill();
        };
        child.stdout.on("data", collect(out));
        child.stderr.on("data", collect(err));
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", kill);
        };
        child.on("error", () => {
          cleanup();
          reject(new Error("EXEC_SANDBOX_FAILED"));
        });
        child.on("close", (exitCode, sig) => {
          cleanup();
          resolve({
            exitCode,
            signal: sig,
            timedOut,
            outputLimited,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
          });
        });
      });
      const data = {
        command,
        path: workspace.root,
        ...identity,
        inputSha256,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...result,
        network: false as const,
        dependencies,
        note: "Isolated Linux execution over a filtered input snapshot. No host HOME, credentials, Git metadata or network. Shared dependencies are explicit read-only grants and are not included in inputSha256. Generated files are ephemeral; host worktree is unchanged. Exit code and output must be checked; isolation can make otherwise valid tests fail.",
      };
      const reports = join(stateDirectory(), "executions");
      mkdirSync(reports, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(reports, `${crypto.randomUUID()}.json`),
        JSON.stringify(data),
        { mode: 0o600 },
      );
      return data;
    } finally {
      this.active = false;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
