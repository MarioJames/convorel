import { test, expect } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configCommand } from "../src/config-command.ts";
import { conversationConfig } from "../src/config.ts";
import { setting } from "../src/env.ts";
import {
  preference,
  preferenceFile,
  resolveSetting,
  writePreference,
} from "../src/user-config.ts";

const project = "https://chatgpt.com/g/g-p-abc123-demo/project";
const none = {};

// homedir() ignores a mid-process HOME change, so preferences are isolated by
// directory, and every read names its own installation file explicitly.
function isolated() {
  const root = mkdtempSync(join(tmpdir(), "convorel-config-")),
    previous = process.env.CONVOREL_CONFIG_HOME,
    installation = join(root, ".env");
  process.env.CONVOREL_CONFIG_HOME = join(root, "config");
  return {
    root,
    installation,
    restore: () => {
      if (previous === undefined) delete process.env.CONVOREL_CONFIG_HOME;
      else process.env.CONVOREL_CONFIG_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the environment and the installation file both outrank stored preferences", () => {
  const { root, installation, restore } = isolated();
  try {
    writeFileSync(installation, "CONVOREL_MODEL=from-installation\n");
    configCommand("set", ["model", "from-preferences"], none, installation);
    expect(setting("CONVOREL_MODEL", installation, none)).toEqual({
      value: "from-installation",
      source: "installation",
    });
    // A standalone executable has no installation file, so preferences apply.
    expect(setting("CONVOREL_MODEL", undefined, none)).toEqual({
      value: "from-preferences",
      source: "preferences",
    });
    expect(
      setting("CONVOREL_MODEL", installation, { CONVOREL_MODEL: "x" }),
    ).toEqual({ value: "x", source: "env" });
    // An explicit empty value still suppresses both stored sources.
    expect(
      setting("CONVOREL_MODEL", installation, { CONVOREL_MODEL: "" }),
    ).toEqual({ value: "", source: "env" });
    expect(
      (configCommand("get", ["model"], none, installation) as any).source,
    ).toBe("installation");
  } finally {
    restore();
  }
});

test("reading the tunnel key reports only that it is configured", () => {
  const { installation, restore } = isolated();
  try {
    const secret = "sk-sentinel-never-printed";
    for (const output of [
      configCommand("set", ["tunnel.apiKey", secret], none, installation),
      configCommand("get", ["tunnel.apiKey"], none, installation),
      configCommand("list", [], none, installation),
    ])
      expect(JSON.stringify(output)).not.toContain(secret);
    expect(configCommand("get", ["tunnel.apiKey"], none, installation)).toEqual(
      {
        key: "CONVOREL_TUNNEL_API_KEY",
        source: "preferences",
        configured: true,
        value: "set",
      },
    );
    expect(lstatSync(preferenceFile()).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(preferenceFile(), "..")).mode & 0o777).toBe(0o700);
  } finally {
    restore();
  }
});

test("a stored value is validated and a binding still refuses an incomplete pair", () => {
  const { root, installation, restore } = isolated();
  try {
    const rootPath = join(root, "code");
    mkdirSync(rootPath);
    expect(
      configCommand(
        "set",
        ["mcp.roots", JSON.stringify([rootPath])],
        none,
        installation,
      ),
    ).toMatchObject({ action: "set", configured: true });
    for (const [key, value, reason] of [
      ["tunnel.id", "tunnel_short", "INVALID_TUNNEL_ID"],
      ["mcp.roots", "not json", "INVALID_MCP_ROOTS"],
      ["mcp.roots", "[]", "INVALID_MCP_ROOTS"],
      ["mcp.roots", '["' + join(root, "missing") + '"]', "MCP_ROOT_MISSING"],
      ["model", "one\ntwo", "INVALID_VALUE"],
      ["project.url", "https://chatgpt.com/plugins", "observed ChatGPT"],
    ] as const)
      expect(() =>
        configCommand("set", [key, value], none, installation),
      ).toThrow(reason);
    expect(() => resolveSetting("tunnel.unknown")).toThrow("UNKNOWN_SETTING");
    expect(() => configCommand("get", [], none, installation)).toThrow(
      "CONFIG_KEY_REQUIRED",
    );
    expect(() => configCommand("set", ["model"], none, installation)).toThrow(
      "CONFIG_VALUE_REQUIRED",
    );
    expect(() => configCommand("wipe", [], none, installation)).toThrow(
      "UNKNOWN_CONFIG_COMMAND",
    );
    // Both halves may be stored one command at a time; binding checks the pair.
    configCommand("set", ["project.url", project], none, installation);
    const base = {
      version: 1 as const,
      workspace: rootPath,
      cdp: "http://127.0.0.1:9222",
    };
    expect(() => conversationConfig(base, preference)).toThrow(
      "PROJECT_CONFIG_INCOMPLETE",
    );
    configCommand("set", ["project.name", "demo"], none, installation);
    expect(conversationConfig(base, preference).projectName).toBe("demo");
    expect(
      (configCommand("unset", ["project.name"], none, installation) as any)
        .configured,
    ).toBe(false);
    expect(
      (configCommand("get", ["model"], none, installation) as any).value,
    ).toBeUndefined();
  } finally {
    restore();
  }
});

test("import-env publishes every preference only when the whole set is valid", () => {
  const { root, installation, restore } = isolated();
  try {
    const rootPath = join(root, "code");
    mkdirSync(rootPath);
    configCommand("set", ["model", "6 Pro"], none, installation);
    writeFileSync(
      installation,
      `CONVOREL_MCP_ROOTS='${JSON.stringify([rootPath])}'\nCONVOREL_PROJECT_URL=${project}\nCONVOREL_PROJECT_NAME=demo\nUNRELATED=ignored\n`,
    );
    const imported = configCommand("import-env", [], none, installation) as any;
    expect(imported.settings.map((s: any) => s.key)).toEqual([
      "CONVOREL_MCP_ROOTS",
      "CONVOREL_PROJECT_URL",
      "CONVOREL_PROJECT_NAME",
    ]);
    expect(JSON.stringify(imported)).not.toContain("UNRELATED");
    expect(preference("CONVOREL_MCP_ROOTS")).toBe(JSON.stringify([rootPath]));
    // A single unusable value leaves the previous preferences untouched.
    writeFileSync(
      installation,
      "CONVOREL_MODEL=other\nCONVOREL_TUNNEL_ID=bad\n",
    );
    expect(() => configCommand("import-env", [], none, installation)).toThrow(
      "INVALID_TUNNEL_ID",
    );
    expect(preference("CONVOREL_MODEL")).toBe("6 Pro");
    expect(() =>
      configCommand("import-env", [], none, join(root, "absent")),
    ).toThrow("IMPORT_ENV_NOT_FOUND");
    expect(writePreference("CONVOREL_MODEL", "").configured).toBe(false);
    expect(preference("CONVOREL_MODEL")).toBeUndefined();
  } finally {
    restore();
  }
});
