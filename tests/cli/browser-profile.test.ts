import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/process.ts";
import { State } from "../../src/storage/state.ts";

test("init/setup save the profile preference while preserving the binding fallback and local doctor source", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-profile-cli-"));
  const workspace = join(root, "workspace"),
    preferred = join(root, "shared profile");
  mkdirSync(workspace);
  const agent = join(root, "agent-browser");
  writeFileSync(
    agent,
    `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('agent-browser fixture'); process.exit(0); }
const data = process.argv.includes('tab') && process.argv.includes('list')
  ? { tabs: [{ targetId: 'fixture', url: 'https://chatgpt.com/' }] }
  : { result: { url: 'https://chatgpt.com/', messages: [], hasComposer: true, blocked: null } };
console.log(JSON.stringify({ success: true, data }));
`,
    { mode: 0o700 },
  );
  const sleeper = join(root, "chrome-fixture.ts");
  writeFileSync(sleeper, "await Bun.sleep(60000);\n");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }),
  });
  const chrome = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      sleeper,
      `--user-data-dir=${preferred}`,
      `--remote-debugging-port=${server.port}`,
    ],
    { stdout: "ignore", stderr: "pipe", env: childEnv() },
  );
  const run = async (state: string, ...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../src/cli.ts"),
        "--config-dir",
        join(root, "config"),
        "--state-dir",
        state,
        ...args,
      ],
      {
        env: { ...childEnv(), HOME: root, PATH: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  try {
    const preferences = new State(join(root, "config"));
    preferences.write("preferences", {
      version: 1,
      values: {
        "browser.executable": agent,
        "browser.actionIntervalMs": "1",
        "browser.navigationWaitMs": "1",
      },
    });
    for (const command of ["init", "setup"]) {
      const store = new State(join(root, command));
      const args = [
        command,
        "--workspace",
        workspace,
        "--browser",
        "managed",
        "--cdp",
        String(server.port),
        "--chrome",
        sleeper,
        "--user-data-dir",
        preferred,
        "--login-timeout",
        "1",
      ];
      const result = await run(store.root, ...args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(
        preferences.read<any>("preferences").values["browser.userDataDir"],
      ).toBe(preferred);
      expect(store.read<any>("config").browser.userDataDir).toBe(
        join(store.root, "chrome"),
      );
      const start = await run(
        store.root,
        "browser",
        "start",
        "--login-timeout",
        "1",
      );
      expect(start.exitCode, start.stderr.toString()).toBe(0);
      expect(JSON.parse(start.stdout.toString())).toMatchObject({
        profile: preferred,
        launched: false,
      });
      const doctor = await run(store.root, "doctor", "--local", "true");
      expect(doctor.exitCode, doctor.stderr.toString()).toBe(0);
      expect(JSON.parse(doctor.stdout.toString()).browser).toEqual({
        profile: preferred,
        profileSource: "preference",
      });
      const unset = await run(
        store.root,
        "config",
        "unset",
        "browser.userDataDir",
      );
      expect(unset.exitCode).toBe(0);
      const fallback = await run(store.root, "doctor", "--local", "true");
      expect(JSON.parse(fallback.stdout.toString()).browser).toEqual({
        profile: join(store.root, "chrome"),
        profileSource: "state",
      });
      const conflict = await run(
        store.root,
        "browser",
        "start",
        "--login-timeout",
        "1",
      );
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr.toString()).toContain(
        "MANAGED_BROWSER_PORT_IN_USE",
      );
      expect(chrome.exitCode).toBeNull();
      expect(existsSync(join(store.root, "chrome"))).toBe(false);
      store.write("config", {
        version: 1,
        workspace,
        cdp: `http://127.0.0.1:${server.port}`,
        browser: { executable: sleeper },
      });
      const defaults = await run(store.root, "doctor", "--local", "true");
      expect(JSON.parse(defaults.stdout.toString()).browser).toEqual({
        profile: join(store.root, "chrome"),
        profileSource: "default",
      });
    }
    for (const command of ["init", "setup"]) {
      const invalidState = join(root, command + "-invalid");
      const invalid = await run(
        invalidState,
        command,
        "--workspace",
        workspace,
        "--browser",
        "managed",
        "--user-data-dir",
        "relative",
      );
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.toString()).toContain(
        "browser.userDataDir must be an absolute path",
      );
      expect(existsSync(join(invalidState, "config.json"))).toBe(false);
      const external = await run(
        invalidState,
        command,
        "--workspace",
        workspace,
        "--cdp",
        String(server.port),
        "--user-data-dir",
        preferred,
      );
      expect(external.exitCode).toBe(1);
      expect(external.stderr.toString()).toContain("MANAGED_BROWSER_OPTION");
    }
    const damaged = join(root, "damaged");
    mkdirSync(damaged);
    writeFileSync(join(damaged, "config.json"), "invalid JSON");
    const offline = await run(damaged, "doctor", "--local", "true");
    expect(offline.exitCode).toBe(1);
    expect(JSON.parse(offline.stdout.toString())).toMatchObject({
      browser: { status: "failed", profileSource: "default" },
      sources: { readable: 0 },
      archive: { integrity_check: "ok" },
    });
  } finally {
    chrome.kill();
    await chrome.exited;
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
