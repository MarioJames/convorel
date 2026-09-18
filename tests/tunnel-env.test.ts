import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installationEnv } from "../src/env.ts";
import { conversationConfig } from "../src/config.ts";

test("model and project preferences respect explicit empty overrides of installation defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-preferences-"));
  try {
    const file = join(root, "preferences.fixture");
    writeFileSync(
      file,
      'CONVOREL_MODEL="7 Pro"\nCONVOREL_PROJECT_URL=https://chatgpt.com/g/g-p-example/project\nCONVOREL_PROJECT_NAME="Agent reviews"\n',
    );
    const base = { version: 1 as const, workspace: "/repo", cdp: "9222" };
    const fromFile = conversationConfig(base, (key) =>
      installationEnv(key, file, {}),
    );
    expect(fromFile).toMatchObject({
      model: "7 Pro",
      projectName: "Agent reviews",
    });
    const empty = {
      CONVOREL_MODEL: "",
      CONVOREL_PROJECT_URL: "",
      CONVOREL_PROJECT_NAME: "",
    };
    expect(
      conversationConfig(base, (key) => installationEnv(key, file, empty)),
    ).toMatchObject({
      model: undefined,
      projectUrl: undefined,
      projectName: undefined,
    });
    expect(() =>
      conversationConfig(base, (key) =>
        installationEnv(key, file, { CONVOREL_PROJECT_URL: "" }),
      ),
    ).toThrow("PROJECT_CONFIG_INCOMPLETE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel key uses explicit environment before dotenv, without importing unrelated variables", () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-env-"));
  try {
    const file = join(root, ".env");
    writeFileSync(
      file,
      'CONVOREL_TUNNEL_API_KEY="file-key#literal" # comment\nPATH=/untrusted\n',
    );
    expect(installationEnv("CONVOREL_TUNNEL_API_KEY", file, {})).toBe(
      "file-key#literal",
    );
    expect(
      installationEnv("CONVOREL_TUNNEL_API_KEY", file, {
        CONVOREL_TUNNEL_API_KEY: "shell-key",
      }),
    ).toBe("shell-key");
    expect(
      installationEnv("CONVOREL_TUNNEL_API_KEY", file, {
        CONVOREL_TUNNEL_API_KEY: "",
      }),
    ).toBe("");
    expect(process.env.PATH).not.toBe("/untrusted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing dotenv is optional; other file errors remain visible", () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-env-"));
  try {
    const file = join(root, ".env");
    expect(
      installationEnv("CONVOREL_TUNNEL_API_KEY", file, {}),
    ).toBeUndefined();
    mkdirSync(file);
    expect(() =>
      installationEnv("CONVOREL_TUNNEL_API_KEY", file, {}),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI loads installation dotenv from another cwd and maps only the tunnel key to the client", async () => {
  const { cpSync, symlinkSync, chmodSync } = await import("node:fs");
  const { State } = await import("../src/state.ts");
  const { childEnv } = await import("../src/command.ts");
  const root = mkdtempSync(join(tmpdir(), "convorel-tunnel-cli-"));
  try {
    const installation = join(root, "installation");
    const cwd = join(root, "caller");
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    for (const dir of [cwd, bin, workspace]) mkdirSync(dir);
    cpSync(join(import.meta.dir, "../src"), join(installation, "src"), {
      recursive: true,
    });
    cpSync(
      join(import.meta.dir, "../package.json"),
      join(installation, "package.json"),
    );
    symlinkSync(
      join(import.meta.dir, "../node_modules"),
      join(installation, "node_modules"),
    );
    writeFileSync(
      join(installation, ".env"),
      'CONVOREL_TUNNEL_API_KEY="file-key"\nCONVOREL_TUNNEL_ID=tunnel_11111111111111111111111111111111\nUNRELATED_SECRET=do-not-forward\n',
    );
    writeFileSync(join(cwd, ".env"), "CONVOREL_TUNNEL_API_KEY=wrong-cwd-key\n");
    const fakeClient = join(bin, "tunnel-client");
    writeFileSync(
      fakeClient,
      `#!${process.execPath} --no-env-file\nconsole.log(JSON.stringify({id:process.argv[process.argv.indexOf("--control-plane.tunnel-id")+1],key:process.env.CONTROL_PLANE_API_KEY,unrelated:process.env.UNRELATED_SECRET,publicKey:process.env.CONVOREL_TUNNEL_API_KEY}));\n`,
    );
    chmodSync(fakeClient, 0o700);
    const state = new State(join(root, "state"));
    state.write("config", {
      version: 1,
      workspace,
      cdp: "http://127.0.0.1:9222",
      model: "6 Pro",
    });
    const fileId = "tunnel_11111111111111111111111111111111";
    const shellId = "tunnel_22222222222222222222222222222222";
    const flagId = "tunnel_33333333333333333333333333333333";
    for (const scenario of [
      { action: "doctor", shell: {}, flags: [], id: fileId, key: "file-key" },
      {
        action: "run",
        shell: {
          CONVOREL_TUNNEL_API_KEY: "shell-key",
          CONVOREL_TUNNEL_ID: shellId,
        },
        flags: [],
        id: shellId,
        key: "shell-key",
      },
      {
        action: "doctor",
        shell: { CONVOREL_TUNNEL_ID: shellId },
        flags: ["--tunnel-id", flagId],
        id: flagId,
        key: "file-key",
      },
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(installation, "src/cli.ts"),
          "tunnel",
          scenario.action,
          ...scenario.flags,
        ],
        {
          cwd,
          env: {
            ...childEnv(),
            HOME: root,
            CONVOREL_HOME: state.root,
            PATH: bin + ":" + process.env.PATH,
            ...scenario.shell,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      expect(error).toBe("");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({
        key: scenario.key,
        id: scenario.id,
      });
      const records = await Array.fromAsync(
        new Bun.Glob("*.json").scan(
          join(root, ".local/share/convorel-tunnels"),
        ),
      );
      for (const record of records) {
        const contents = await Bun.file(
          join(root, ".local/share/convorel-tunnels", record),
        ).text();
        expect(contents).not.toContain("file-key");
        expect(contents).not.toContain("shell-key");
      }
    }
    const { createHash } = await import("node:crypto");
    const registry = new State(join(root, ".local/share/convorel-tunnels"));
    registry.write(
      "lock-tunnel-" +
        createHash("sha256").update(fileId).digest("hex").slice(0, 24),
      {
        version: 1,
        pid: process.pid,
        identity: "stale-test-identity",
        token: "test-lock",
      },
    );
    for (const scenario of [
      { command: "instructions", id: undefined, error: undefined },
      { command: "recover-lock", id: undefined, error: undefined },
      { command: "instructions", id: "", error: "TUNNEL_ID_MISSING" },
      { command: "doctor", id: "invalid-id", error: "INVALID_TUNNEL_ID" },
    ]) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          join(installation, "src/cli.ts"),
          "tunnel",
          scenario.command,
        ],
        {
          cwd,
          env: {
            ...childEnv(),
            HOME: root,
            CONVOREL_HOME: state.root,
            PATH: bin + ":" + process.env.PATH,
            ...(scenario.id === undefined
              ? {}
              : { CONVOREL_TUNNEL_ID: scenario.id }),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(
        scenario.error ? 1 : 0,
      );
      if (scenario.error)
        expect(child.stderr.toString()).toContain(scenario.error);
      else if (scenario.command === "instructions") {
        expect(JSON.parse(child.stdout.toString()).tunnelId).toBe(fileId);
        expect(child.stdout.toString()).not.toContain("file-key");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
