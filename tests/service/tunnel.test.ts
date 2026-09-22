import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State } from "../../src/storage/state.ts";
import { childEnv } from "../../src/process.ts";
import { tunnelKey } from "../../src/service/tunnel.ts";

test("tunnel CLI resolves private preferences, explicit ID overrides, and scoped lock recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-tunnel-cli-"));
  const workspace = join(root, "workspace"),
    bin = join(root, "bin"),
    cwd = join(root, "caller");
  for (const path of [workspace, bin, cwd]) mkdirSync(path);
  const state = new State(join(root, "state")),
    prefs = new State(join(root, "prefs"));
  state.write("config", {
    version: 1,
    workspace,
    cdp: "http://127.0.0.1:9222",
  });
  const id = "tunnel_" + "1".repeat(32),
    flagId = "tunnel_" + "2".repeat(32);
  const values = { "tunnel.id": id, "tunnel.apiKey": "fixture-key" };
  prefs.write("preferences", { version: 1, values });
  writeFileSync(
    join(bin, "tunnel-client"),
    `#!${process.execPath} --no-env-file\nconsole.log(JSON.stringify({id:process.argv[process.argv.indexOf("--control-plane.tunnel-id")+1],key:process.env.CONTROL_PLANE_API_KEY}));\n`,
    { mode: 0o700 },
  );
  const registry = new State(join(root, ".local/share/convorel-tunnels"));
  async function run(action: string, flags: string[] = [], failure?: string) {
    const p = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../src/cli.ts"),
        "--config-dir",
        prefs.root,
        "--state-dir",
        state.root,
        "tunnel",
        action,
        ...flags,
      ],
      {
        cwd,
        env: { ...childEnv(), HOME: root, PATH: bin + ":" + process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(code, err).toBe(failure ? 1 : 0);
    if (failure) expect(err).toContain(failure);
    else return JSON.parse(out);
  }
  try {
    expect(await run("doctor")).toEqual({ id, key: "fixture-key" });
    expect(await run("run", ["--tunnel-id", flagId])).toEqual({
      id: flagId,
      key: "fixture-key",
    });
    for (const selected of [id, flagId])
      expect(
        await Bun.file(registry.path(tunnelKey(selected))).text(),
      ).not.toContain("fixture-key");
    expect((await run("instructions")).tunnelId).toBe(id);
    await run("instructions", ["--tunnel-id", "invalid"], "INVALID_TUNNEL_ID");
    registry.write("lock-" + tunnelKey(id), {
      version: 1,
      pid: process.pid,
      identity: "stale-test-identity",
      token: "fixture",
    });
    expect((await run("recover-lock")).recovered).toBe(true);
    prefs.write("preferences", { version: 1, values: { "tunnel.id": id } });
    await run("run", [], "TUNNEL_CREDENTIAL_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
