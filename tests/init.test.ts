import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State } from "../src/state.ts";
import { childEnv } from "../src/command.ts";
import { conversationConfig } from "../src/config.ts";

test("initialization needs no model and retains only the workspace/browser binding", () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-init-"));
  const state = new State(join(root, "state")),
    workspace = join(root, "workspace");
  mkdirSync(workspace);
  const preferences = new State(join(root, "prefs"));
  const run = (args: string[], values: Record<string, string> = {}) => {
    preferences.write("preferences", { version: 1, values });
    return Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "--state-dir",
        state.root,
        "--config-dir",
        preferences.root,
        "init",
        ...args,
      ],
      {
        env: {
          ...childEnv(),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  };
  try {
    const args = ["--workspace", workspace, "--cdp", "9222"];
    const first = run(args);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(JSON.parse(first.stdout.toString()).modelPolicy).toBe("latest-pro");
    const custom = run(args, {
      model: "Custom model",
      "project.url": "https://chatgpt.com/g/g-p-example/project",
      "project.name": "Example",
    });
    expect(custom.exitCode, custom.stderr.toString()).toBe(0);
    expect(JSON.parse(custom.stdout.toString()).model).toBe("Custom model");
    expect(state.read<any>("config")).toEqual({
      version: 1,
      workspace,
      cdp: "http://127.0.0.1:9222",
    });
    expect(run(["--workspace", root, "--cdp", "9222"]).exitCode).toBe(1);
    expect(run(args, { "project.name": "Missing URL" }).exitCode).toBe(1);
    expect(state.read<any>("config").workspace).toBe(workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unconfigured preferences do not inherit old persisted model or project defaults", () => {
  const config = conversationConfig(
    {
      version: 1,
      workspace: "/repo",
      cdp: "9222",
      model: "6 Pro",
      projectName: "Old",
      projectUrl: "https://chatgpt.com/g/g-p-old/project",
    },
    () => undefined,
  );
  expect(config.model).toBeUndefined();
  expect(config.projectUrl).toBeUndefined();
  expect(config.projectName).toBeUndefined();
});
