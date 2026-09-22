import { existsSync, readFileSync } from "node:fs";
import { configDirectory } from "../paths.ts";
import { join } from "node:path";
import { State } from "../storage/state.ts";
import { fullPath } from "../paths.ts";
import { projectId } from "../browser/chatgpt/organize.ts";

/** Config keys are independent of process environment. */
export const settingKeys = [
  "tunnel.apiKey",
  "tunnel.id",
  "mcp.roots",
  "model",
  "project.url",
  "project.name",
  "browser.executable",
  "browser.serial",
  "browser.actionIntervalMs",
  "browser.navigationWaitMs",
  "locks.taskWaitMs",
  "release.baseUrl",
  "diagnostics.enabled",
] as const;
export type SettingKey = (typeof settingKeys)[number];
const secrets: SettingKey[] = ["tunnel.apiKey"];
const document = "preferences";
export const MAX_BROWSER_PACING_MS = 10_000;

function pacingMilliseconds(key: SettingKey, value: string) {
  if (
    !/^[0-9]+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > MAX_BROWSER_PACING_MS
  )
    throw new Error(
      `INVALID_VALUE: ${key} must be an integer from 1 to ${MAX_BROWSER_PACING_MS}`,
    );
  return Number(value);
}

export function browserPacingSettings() {
  const values = current();
  return {
    actionIntervalMs: pacingMilliseconds(
      "browser.actionIntervalMs",
      values["browser.actionIntervalMs"] ?? "750",
    ),
    navigationWaitMs: pacingMilliseconds(
      "browser.navigationWaitMs",
      values["browser.navigationWaitMs"] ?? "1500",
    ),
  };
}

export function resolveSetting(input: string): SettingKey {
  if (!(settingKeys as readonly string[]).includes(input))
    throw new Error(
      `UNKNOWN_SETTING: ${input}; known settings are ${settingKeys.join(", ")}`,
    );
  return input as SettingKey;
}
export const preferenceDirectory = configDirectory;
export function preferenceFile() {
  return join(preferenceDirectory(), document + ".json");
}

export function mask(key: SettingKey, value?: string) {
  return secrets.includes(key)
    ? { configured: !!value, value: value ? "set" : undefined }
    : { configured: value !== undefined, value };
}

function current(): Partial<Record<SettingKey, string>> {
  // Reading preferences never creates a directory: every command resolves them,
  // including while a caller has no writable configuration location.
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(preferenceFile(), "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw new Error(
      "PREFERENCES_READ_FAILED: cannot read convorel preferences",
    );
  }
  if (!stored || typeof stored !== "object")
    throw new Error("PREFERENCES_INVALID: inspect " + preferenceFile());
  const { version, values } = stored as {
    version?: number;
    values?: unknown;
  };
  if (version !== 1) throw new Error("PREFERENCES_VERSION_UNSUPPORTED");
  if (values !== undefined && (!values || typeof values !== "object"))
    throw new Error("PREFERENCES_INVALID: inspect " + preferenceFile());
  return (values ?? {}) as Partial<Record<SettingKey, string>>;
}

// A half-configured project pair is allowed here so both halves can be set in
// sequence; conversationConfig refuses to bind a task until they are complete.
function validate(key: SettingKey, value: string) {
  if (/[\r\n\0]/.test(value))
    throw new Error(`INVALID_VALUE: ${key} must not contain a newline or NUL`);
  if (key === "browser.serial" && !["true", "false"].includes(value))
    throw new Error("INVALID_VALUE: browser.serial must be true or false");
  if (key === "diagnostics.enabled" && !["true", "false"].includes(value))
    throw new Error("INVALID_VALUE: diagnostics.enabled must be true or false");
  if (key === "browser.actionIntervalMs" || key === "browser.navigationWaitMs")
    pacingMilliseconds(key, value);
  if (
    key === "locks.taskWaitMs" &&
    (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)
  )
    throw new Error(
      "INVALID_VALUE: locks.taskWaitMs must be a positive integer",
    );
  if (key === "browser.executable") fullPath(value);
  if (key === "release.baseUrl") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("INVALID_VALUE: release.baseUrl must be an HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "INVALID_VALUE: release.baseUrl must be an HTTP(S) URL without credentials, query or fragment",
      );
  }
  if (key === "tunnel.id" && !/^tunnel_[a-f0-9]{32}$/.test(value))
    throw new Error("INVALID_TUNNEL_ID: expected tunnel_ plus 32 hex digits");
  if (key === "project.url") projectId(value);
  if (key === "mcp.roots") {
    let roots: unknown;
    try {
      roots = JSON.parse(value);
    } catch {
      throw new Error("INVALID_MCP_ROOTS: expected a JSON array of paths");
    }
    if (
      !Array.isArray(roots) ||
      !roots.length ||
      roots.length > 16 ||
      roots.some((root) => typeof root !== "string")
    )
      throw new Error(
        "INVALID_MCP_ROOTS: expected 1 to 16 absolute or ~/ paths",
      );
    for (const root of roots as string[]) {
      const absolute = fullPath(root);
      if (!existsSync(absolute))
        throw new Error(`MCP_ROOT_MISSING: ${absolute}`);
    }
  }
}

export function preference(key: SettingKey): string | undefined {
  const value = current()[key];
  return value === "" ? undefined : value;
}

/** An empty value removes the preference, since the file has no blank state. */
export function writePreference(key: SettingKey, value: string) {
  if (key === "browser.executable" && value) value = fullPath(value);
  const all = { ...current(), [key]: value };
  if (value === "") delete all[key];
  else validate(key, value);
  publish(all);
  return { key, ...mask(key, all[key]) };
}

function publish(values: Partial<Record<SettingKey, string>>) {
  new State(preferenceDirectory()).write(document, { version: 1, values });
}
