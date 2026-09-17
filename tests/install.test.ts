import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillInstall, skillUninstall, skillSource } from "../src/install.ts";
test("skill install is repeatable, works outside cwd and preserves conflicting user files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "convorel skill "));
  try {
    const first = skillInstall(dir);
    expect(first.changed).toBe(true);
    expect(skillInstall(dir).changed).toBe(false);
    expect(realpathSync(first.destination)).toBe(realpathSync(skillSource));
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(first.destination, "scripts/convorel.ts"),
        "--help",
      ],
      { cwd: "/", stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(child.stdout).text()).toContain("review start");
    expect(await child.exited).toBe(0);
    expect(skillUninstall(dir).removed).toBe(true);
    writeFileSync(first.destination, "user data");
    expect(() => skillInstall(dir)).toThrow("CONFLICT");
    expect(() => skillUninstall(dir)).toThrow("CONFLICT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("repeat initialization keeps optional preferences and rejects a changed workspace", async () => {
  const { State } = await import("../src/state.ts");
  const root = mkdtempSync(join(tmpdir(), "convorel-init-"));
  const state = new State(join(root, "state")),
    workspace = join(root, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspace);
  const cli = join(import.meta.dir, "../src/cli.ts");
  const run = (args: string[]) =>
    Bun.spawnSync([process.execPath, "--no-env-file", cli, "init", ...args], {
      env: { ...process.env, CONVOREL_HOME: state.root },
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    const args = ["--workspace", workspace, "--cdp", "9222"];
    expect(
      run([
        ...args,
        "--model",
        "Custom visible model",
        "--project-url",
        "https://chatgpt.com/g/g-p-example/project",
        "--project-name",
        "Example",
        "--timezone",
        "Asia/Shanghai",
      ]).exitCode,
    ).toBe(0);
    expect(run(args).exitCode).toBe(0);
    expect(state.read<any>("config").model).toBe("Custom visible model");
    expect(state.read<any>("config").projectName).toBe("Example");
    expect(run(["--workspace", root, "--cdp", "9222"]).exitCode).toBe(1);
    expect(state.read<any>("config").workspace).toBe(workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
