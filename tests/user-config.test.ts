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
import { setRuntimePaths } from "../src/paths.ts";
import {
  preference,
  preferenceFile,
  resolveSetting,
  writePreference,
} from "../src/user-config.ts";

const project = "https://chatgpt.com/g/g-p-abc123-demo/project";
function isolated() {
  const root = mkdtempSync(join(tmpdir(), "convorel-config-"));
  const previous = setRuntimePaths({ configDir: join(root, "config") });
  return {
    root,
    restore: () => {
      setRuntimePaths(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("reading the tunnel key reports only that it is configured", () => {
  const { restore } = isolated();
  try {
    const secret = "sk-sentinel-never-printed";
    for (const output of [
      configCommand("set", ["tunnel.apiKey", secret]),
      configCommand("get", ["tunnel.apiKey"]),
      configCommand("list", []),
    ])
      expect(JSON.stringify(output)).not.toContain(secret);
    expect(configCommand("get", ["tunnel.apiKey"])).toEqual({
      key: "tunnel.apiKey",
      source: "preferences",
      configured: true,
      value: "set",
    });
    expect(lstatSync(preferenceFile()).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(preferenceFile(), "..")).mode & 0o777).toBe(0o700);
  } finally {
    restore();
  }
});

test("a stored value is validated and a binding still refuses an incomplete pair", () => {
  const { root, restore } = isolated();
  try {
    const rootPath = join(root, "code");
    mkdirSync(rootPath);
    expect(
      configCommand("set", ["mcp.roots", JSON.stringify([rootPath])]),
    ).toMatchObject({ action: "set", configured: true });
    for (const [key, value, reason] of [
      ["tunnel.id", "tunnel_short", "INVALID_TUNNEL_ID"],
      ["mcp.roots", "not json", "INVALID_MCP_ROOTS"],
      ["mcp.roots", "[]", "INVALID_MCP_ROOTS"],
      ["mcp.roots", '["' + join(root, "missing") + '"]', "MCP_ROOT_MISSING"],
      ["model", "one\ntwo", "INVALID_VALUE"],
      ["browser.serial", "yes", "INVALID_VALUE"],
      ["locks.taskWaitMs", "0", "INVALID_VALUE"],
      ["release.baseUrl", "file:///tmp", "INVALID_VALUE"],
      ["project.url", "https://chatgpt.com/plugins", "observed ChatGPT"],
    ] as const)
      expect(() => configCommand("set", [key, value])).toThrow(reason);
    expect(() => resolveSetting("tunnel.unknown")).toThrow("UNKNOWN_SETTING");
    expect(() => configCommand("get", [])).toThrow("CONFIG_KEY_REQUIRED");
    expect(() => configCommand("set", ["model"])).toThrow(
      "CONFIG_VALUE_REQUIRED",
    );
    expect(() => configCommand("wipe", [])).toThrow("UNKNOWN_CONFIG_COMMAND");
    // Both halves may be stored one command at a time; binding checks the pair.
    configCommand("set", ["project.url", project]);
    const base = {
      version: 1 as const,
      workspace: rootPath,
      cdp: "http://127.0.0.1:9222",
    };
    expect(() => conversationConfig(base, preference)).toThrow(
      "PROJECT_CONFIG_INCOMPLETE",
    );
    configCommand("set", ["project.name", "demo"]);
    expect(conversationConfig(base, preference).projectName).toBe("demo");
    expect((configCommand("unset", ["project.name"]) as any).configured).toBe(
      false,
    );
    expect((configCommand("get", ["model"]) as any).value).toBeUndefined();
  } finally {
    restore();
  }
});

test("browser pacing preferences accept only bounded positive integer milliseconds", () => {
  const { restore } = isolated();
  try {
    for (const key of [
      "browser.actionIntervalMs",
      "browser.navigationWaitMs",
    ] as const) {
      for (const value of [
        "0",
        "-1",
        "1.5",
        "NaN",
        "Infinity",
        "10001",
        "1e3",
        " 20 ",
      ])
        expect(() => configCommand("set", [key, value])).toThrow(
          "INVALID_VALUE",
        );
      for (const value of ["1", "750", "1500", "10000"]) {
        configCommand("set", [key, value]);
        expect(preference(key)).toBe(value);
      }
      configCommand("unset", [key]);
      expect(preference(key)).toBeUndefined();
    }
  } finally {
    restore();
  }
});
