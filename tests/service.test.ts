import { test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State, processIdentity } from "../src/state.ts";
import { childEnv } from "../src/command.ts";
import { tunnelKey } from "../src/tunnel.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
test("CLI manages detached clients, concurrent starts, logs, restart and exact process identity", async () => {
  const temp = mkdtempSync(join(tmpdir(), "convorel-service-"));
  const id = "tunnel_" + "4".repeat(32),
    key = tunnelKey(id);
  const workspace = join(temp, "workspace"),
    bin = join(temp, "bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  const state = new State(join(temp, "state"));
  state.write("config", { version: 1, workspace, cdp: "http://127.0.0.1:1" });
  const registry = new State(join(temp, ".local/share/convorel-tunnels"));
  const env = {
    ...childEnv(),
    HOME: temp,
    CONVOREL_HOME: state.root,
    CONVOREL_CONFIG_HOME: join(temp, "prefs"),
    CONVOREL_TUNNEL_API_KEY: "test-only",
    CONVOREL_TUNNEL_ID: id,
    CONVOREL_MCP_ROOTS: JSON.stringify([workspace]),
    PATH: bin + ":" + process.env.PATH,
  };
  const client = join(bin, "tunnel-client");
  const descendant = join(bin, "descendant.ts");
  writeFileSync(
    descendant,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(temp, "descendant.pid"))}, String(process.pid)); process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`,
  );
  const liveClient = `#!${process.execPath} --no-env-file\nconst child=Bun.spawn([process.execPath,"--no-env-file",${JSON.stringify(descendant)}],{stdio:["ignore","ignore","ignore"]});child.unref();console.log("client ready"); const timer=setInterval(()=>{},1000); process.on("SIGTERM",()=>{console.log("client stopped");clearInterval(timer)});\n`;
  writeFileSync(client, liveClient);
  chmodSync(client, 0o700);
  async function run(args: string[], expected = 0, extra = {}) {
    const p = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      cwd: temp,
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(code, err || out).toBe(expected);
    return out || err;
  }
  let follower: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const initial = JSON.parse(await run(["status"]));
    expect(initial.running).toBe(false);
    expect(initial.log).toBeNull();
    registry.write("lock-" + key, {
      version: 1,
      pid: process.pid,
      identity: "stale",
      token: "fixture",
    });
    const starts = await Promise.all([run(["start"]), run(["start"])]);
    expect(starts.map((x) => JSON.parse(x).started).sort()).toEqual([
      false,
      true,
    ]);
    const first = JSON.parse(await run(["status"]));
    expect(first.running).toBe(true);
    const descendantPid = Number(
      readFileSync(join(temp, "descendant.pid"), "utf8"),
    );
    expect(first.workspace).toBe(workspace);
    expect(readFileSync(registry.path(key), "utf8")).not.toContain("test-only");
    expect(await run(["logs", "--lines", "1"])).toBe("client ready\n");
    expect(await run(["logs", "--lines", "0"], 1)).toContain("INVALID_LINES");
    follower = Bun.spawn(
      [process.execPath, "--no-env-file", cli, "logs", "--follow"],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const reader = (follower.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "client ready",
    );
    const restarted = JSON.parse(await run(["restart"]));
    expect(restarted.running).toBe(true);
    expect(restarted.client.pid).not.toBe(first.client.pid);
    try {
      const stat = readFileSync(`/proc/${descendantPid}/stat`, "utf8");
      expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    let followed = "";
    while (!followed.includes("client ready")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      followed += new TextDecoder().decode(chunk.value);
    }
    expect(followed).toContain("client ready");
    follower.kill("SIGTERM");
    expect(await follower.exited).toBe(0);
    reader.releaseLock();
    expect(
      JSON.parse(
        await run(["stop"], 0, { CONVOREL_HOME: join(temp, "missing-state") }),
      ).stopped,
    ).toBe(true);
    expect(JSON.parse(await run(["stop"])).stopped).toBe(false);
    expect(JSON.parse(await run(["status"])).running).toBe(false);
    registry.write(key, {
      version: 1,
      workspace,
      pid: process.pid,
      identity: "mismatched",
      supervisor: { pid: process.pid, identity: "mismatched" },
    });
    expect(JSON.parse(await run(["stop"])).stopped).toBe(false);
    expect(processIdentity(process.pid)).not.toBe("mismatched");
    writeFileSync(
      client,
      `#!${process.execPath} --no-env-file\nconsole.error("fixture startup failure"); process.exit(23);\n`,
    );
    expect(await run(["start"], 1)).toContain("SERVICE_START_FAILED");
    expect(JSON.parse(await run(["status"])).running).toBe(false);
    expect(await run(["start"], 1, { CONVOREL_TUNNEL_API_KEY: "" })).toContain(
      "TUNNEL_CREDENTIAL_MISSING",
    );
    expect(await run(["status", "--tunnel-id", "invalid"], 1)).toContain(
      "INVALID_TUNNEL_ID",
    );
  } finally {
    if (follower) {
      follower.kill("SIGTERM");
      await follower.exited;
    }
    await run(["stop"]).catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
}, 40_000);
