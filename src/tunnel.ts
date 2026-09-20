import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { State, processIdentity } from "./state.ts";
import { Workspace, sha } from "./workspace.ts";
import { childEnv } from "./command.ts";
import { WorkspaceAccess } from "./workspace-access.ts";
import { settingValue } from "./env.ts";
import { selfExec } from "./runtime.ts";
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function tunnelArgs(
  id: string,
  root: string,
  healthFile: string,
  roots = [root],
) {
  if (!/^tunnel_[a-f0-9]{32}$/.test(id)) throw new Error("INVALID_TUNNEL_ID");
  const mcp = selfExec([
    "mcp",
    "serve",
    "--roots",
    JSON.stringify(new WorkspaceAccess(roots).roots.map((ws) => ws.root)),
  ])
    .map(shellQuote)
    .join(" ");
  return [
    "--control-plane.tunnel-id",
    id,
    "--mcp.command",
    mcp,
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    healthFile,
  ];
}
export function tunnelInstructions(id: string, root: string, roots = [root]) {
  const args = tunnelArgs(id, root, "/path/to/private/health-url", roots);
  return {
    tunnelId: id,
    roots: new WorkspaceAccess(roots).roots.map((ws) => ({
      path: ws.root,
      rootId: ws.id,
    })),
    requires: [
      "official tunnel-client on PATH",
      "CONVOREL_TUNNEL_API_KEY in the environment or convorel configuration",
      "Platform tunnel associated with target ChatGPT workspace",
      "ChatGPT developer app connected and enabled",
    ],
    commands: {
      doctor: selfExec(["tunnel", "doctor", "--tunnel-id", id])
        .map(shellQuote)
        .join(" "),
      run: selfExec(["tunnel", "run", "--tunnel-id", id])
        .map(shellQuote)
        .join(" "),
      start: selfExec(["start", "--tunnel-id", id]).map(shellQuote).join(" "),
    },
    nativeArguments: args,
    settingsUrl: "https://platform.openai.com/settings/organization/tunnels",
    chatgptUrl: "https://chatgpt.com/plugins",
    cloudVerification: "not_run",
    note: "One active stdio client per tunnel ID. This wrapper fixes the workspace and binds health/admin to loopback. Do not also start the same tunnel outside this wrapper.",
  };
}
/** Private single-instance registry shared by the foreground run and the service manager. */
export const tunnelRegistry = () =>
  new State(join(homedir(), ".local/share/convorel-tunnels"));
export const tunnelKey = (id: string) => {
  if (!/^tunnel_[a-f0-9]{32}$/.test(id)) throw new Error("INVALID_TUNNEL_ID");
  return "tunnel-" + sha(id).slice(0, 24);
};
export async function runTunnel(
  action: "run" | "doctor",
  id: string,
  root: string,
  roots = [root],
) {
  const registry = tunnelRegistry(),
    key = tunnelKey(id),
    workspace = new Workspace(root);
  const access = new WorkspaceAccess(roots);
  access.assertPrivate(registry.root);
  const flags = tunnelArgs(
    id,
    root,
    join(registry.root, key + ".health-url"),
    roots,
  );
  if (!Bun.which("tunnel-client"))
    throw new Error(
      "TUNNEL_CLIENT_MISSING: install official tunnel-client; see tunnel instructions",
    );
  const apiKey = settingValue("CONVOREL_TUNNEL_API_KEY");
  if (!apiKey)
    throw new Error(
      "TUNNEL_CREDENTIAL_MISSING: set CONVOREL_TUNNEL_API_KEY with convorel config set tunnel.apiKey, or in the process environment",
    );
  return registry.locked(async () => {
    const previous = registry.has(key) ? registry.read<any>(key) : null;
    if (previous && previous.workspace !== workspace.root)
      throw new Error("TUNNEL_WORKSPACE_CONFLICT");
    if (previous?.pid) {
      let live = false;
      try {
        live = processIdentity(previous.pid) === previous.identity;
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (live) throw new Error("TUNNEL_CHILD_STILL_RUNNING");
    }
    // The supervisor identity lets `stop` signal this wrapper, whose handler
    // terminates the client's process group and records the exit.
    const base = {
      version: 1 as const,
      tunnelId: id,
      workspace: workspace.root,
      readRoots: roots,
      supervisor: { pid: process.pid, identity: processIdentity(process.pid) },
      startedAt: new Date().toISOString(),
    };
    registry.write(key, base);
    const env = {
      ...childEnv(),
      CONTROL_PLANE_API_KEY: apiKey,
    };
    const child = spawn(
      "tunnel-client",
      [action, ...flags, ...(action === "doctor" ? ["--explain"] : [])],
      { cwd: registry.root, env, stdio: "inherit", detached: true },
    );
    const exited = new Promise<number>((yes, no) => {
      child.once("error", no);
      child.once("exit", (code) => yes(code ?? 1));
    });
    void exited.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer) return;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 8000);
      }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      if (child.pid)
        registry.write(key, {
          ...base,
          pid: child.pid,
          identity: processIdentity(child.pid),
        });
      const code = await exited;
      registry.write(key, {
        ...base,
        exitCode: code,
        exitedAt: new Date().toISOString(),
      });
      return code;
    } catch (e) {
      stop();
      await exited.catch(() => {});
      throw e;
    } finally {
      if (timer) {
        clearTimeout(timer);
        // The leader may exit on TERM while a child ignores it. Finish the
        // same process group before releasing ownership of this tunnel.
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }, key);
}

export function recoverTunnelLock(id: string, root: string) {
  tunnelArgs(id, root, "/unused-health-url");
  const registry = tunnelRegistry();
  const key = tunnelKey(id);
  if (registry.has(key)) {
    const child = registry.read<any>(key);
    if (child.pid) {
      try {
        if (processIdentity(child.pid) === child.identity)
          throw new Error("TUNNEL_CHILD_STILL_RUNNING");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  return registry.recoverLock(key);
}
