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
import { State, processIdentity } from "../../src/storage/state.ts";
import { childEnv } from "../../src/process.ts";
import { tunnelKey } from "../../src/service/tunnel.ts";

const cli = join(import.meta.dir, "../../src/cli.ts");
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
  const prefs = new State(join(temp, "prefs"));
  const values = {
    "tunnel.apiKey": "test-only",
    "tunnel.id": id,
    "mcp.roots": JSON.stringify([workspace]),
  };
  prefs.write("preferences", { version: 1, values });
  const globals = ["--state-dir", state.root, "--config-dir", prefs.root];
  const env = {
    ...childEnv(),
    HOME: temp,
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
  async function run(
    args: string[],
    expected = 0,
    extra: { stateDir?: string } = {},
  ) {
    const p = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cli,
        ...globals,
        ...(extra.stateDir ? ["--state-dir", extra.stateDir] : []),
        ...args,
      ],
      {
        cwd: temp,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
      [process.execPath, "--no-env-file", cli, ...globals, "logs", "--follow"],
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
        await run(["stop"], 0, { stateDir: join(temp, "missing-state") }),
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
    prefs.write("preferences", {
      version: 1,
      values: { ...values, "tunnel.apiKey": "" },
    });
    expect(await run(["start"], 1)).toContain("TUNNEL_CREDENTIAL_MISSING");
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

test.each(["ignore-term", "new-member"] as const)(
  "orphan stop verifies ownership and handles %s",
  async (mode) => {
    const temp = mkdtempSync(join(tmpdir(), "convorel-orphan-service-"));
    const id = "tunnel_" + "e".repeat(32);
    for (const dir of ["bin", "workspace", "state", "prefs"])
      mkdirSync(join(temp, dir));
    new State(join(temp, "state")).write("config", {
      version: 1,
      workspace: join(temp, "workspace"),
      cdp: "http://127.0.0.1:1",
    });
    new State(join(temp, "prefs")).write("preferences", {
      version: 1,
      values: { "tunnel.id": id, "tunnel.apiKey": "fixture-only" },
    });
    const descendantFile = join(temp, "descendant.pid");
    const unexpectedFile = join(temp, "unexpected.pid");
    writeFileSync(
      join(temp, "descendant.ts"),
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));process.on("SIGTERM",()=>{${mode === "new-member" ? `const p=Bun.spawn(["sleep","30"],{stdio:["ignore","ignore","ignore"]});p.unref();writeFileSync(${JSON.stringify(unexpectedFile)},String(p.pid));` : ""}});setInterval(()=>{},1000);`,
    );
    writeFileSync(
      join(temp, "bin/tunnel-client"),
      `#!${process.execPath} --no-env-file\nconst p=Bun.spawn([process.execPath,"--no-env-file",${JSON.stringify(join(temp, "descendant.ts"))}],{stdio:["ignore","ignore","ignore"]});p.unref();process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const env = {
      ...childEnv(),
      HOME: temp,
      PATH: join(temp, "bin") + ":" + process.env.PATH,
    };
    const owned: { pid: number; identity: string }[] = [];
    const isAlive = (pid: number) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return !["Z", "X"].includes(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
        );
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        return false;
      }
    };
    async function run(action: string, expected = 0) {
      const p = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          cli,
          "--config-dir",
          join(temp, "prefs"),
          "--state-dir",
          join(temp, "state"),
          action,
        ],
        { env, cwd: temp, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(code, err || out).toBe(expected);
      return expected ? err : JSON.parse(out);
    }
    const unrelated = Bun.spawn(
      [process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"],
      { env, stdout: "ignore", stderr: "ignore" },
    );
    try {
      const started = await run("start");
      for (const pid of [
        started.supervisor.pid,
        started.client.pid,
        Number(readFileSync(descendantFile, "utf8")),
      ])
        owned.push({ pid, identity: processIdentity(pid) });
      process.kill(started.supervisor.pid, "SIGKILL");
      for (let i = 0; i < 50 && isAlive(started.supervisor.pid); i++)
        await Bun.sleep(20);
      if (mode === "new-member") {
        expect(await run("stop", 1)).toContain("SERVICE_STOP_UNVERIFIED");
        expect(isAlive(owned[2].pid)).toBe(true);
      } else {
        expect((await run("stop")).stopped).toBe(true);
        expect(isAlive(owned[2].pid)).toBe(false);
        new State(join(temp, ".local/share/convorel-tunnels")).write(
          tunnelKey(id),
          {
            version: 1,
            pid: unrelated.pid,
            identity: processIdentity(unrelated.pid),
          },
        );
        expect(await run("stop", 1)).toContain("SERVICE_STOP_UNVERIFIED");
      }
      expect(isAlive(unrelated.pid)).toBe(true);
    } finally {
      try {
        const pid = Number(readFileSync(unexpectedFile, "utf8"));
        owned.push({ pid, identity: processIdentity(pid) });
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      for (const entry of owned) {
        try {
          if (
            isAlive(entry.pid) &&
            processIdentity(entry.pid) === entry.identity
          )
            process.kill(entry.pid, "SIGKILL");
        } catch (e: any) {
          if (e.code !== "ENOENT" && e.code !== "ESRCH") throw e;
        }
      }
      unrelated.kill("SIGKILL");
      await unrelated.exited;
      for (let i = 0; i < 50 && owned.some((x) => isAlive(x.pid)); i++)
        await Bun.sleep(20);
      rmSync(temp, { recursive: true, force: true });
    }
  },
  30_000,
);
