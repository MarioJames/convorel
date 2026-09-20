import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { State } from "./state.ts";
import { fullPath } from "./workspace-access.ts";
import { projectId } from "./chatgpt/organize.ts";

/** The canonical name of every preference is the environment variable it shadows. */
export const settingKeys = [
  "CONVOREL_TUNNEL_API_KEY",
  "CONVOREL_TUNNEL_ID",
  "CONVOREL_MCP_ROOTS",
  "CONVOREL_MODEL",
  "CONVOREL_PROJECT_URL",
  "CONVOREL_PROJECT_NAME",
] as const;
export type SettingKey = (typeof settingKeys)[number];

/** Never echoed by `config get`, `config list` or any log. */
const secrets: SettingKey[] = ["CONVOREL_TUNNEL_API_KEY"];
const aliases: Record<string, SettingKey> = {
  "tunnel.apiKey": "CONVOREL_TUNNEL_API_KEY",
  "tunnel.id": "CONVOREL_TUNNEL_ID",
  "mcp.roots": "CONVOREL_MCP_ROOTS",
  model: "CONVOREL_MODEL",
  "project.url": "CONVOREL_PROJECT_URL",
  "project.name": "CONVOREL_PROJECT_NAME",
};
const document = "preferences";

export function resolveSetting(input: string): SettingKey {
  const key =
    aliases[input] ??
    ((settingKeys as readonly string[]).includes(input)
      ? (input as SettingKey)
      : undefined);
  if (!key)
    throw new Error(
      `UNKNOWN_SETTING: ${input}; known settings are ${[...settingKeys].join(", ")} (or ${Object.keys(aliases).join(", ")})`,
    );
  return key;
}

// CONVOREL_CONFIG_HOME is forwarded to every child, because a re-entered CLI
// resolves the preferences a running operation depends on.
export function preferenceDirectory() {
  return (
    process.env.CONVOREL_CONFIG_HOME || join(homedir(), ".config/convorel")
  );
}
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
  if (key === "CONVOREL_TUNNEL_ID" && !/^tunnel_[a-f0-9]{32}$/.test(value))
    throw new Error("INVALID_TUNNEL_ID: expected tunnel_ plus 32 hex digits");
  if (key === "CONVOREL_PROJECT_URL") projectId(value);
  if (key === "CONVOREL_MCP_ROOTS") {
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
  const all = { ...current(), [key]: value };
  if (value === "") delete all[key];
  else validate(key, value);
  publish(all);
  return { key, ...mask(key, all[key]) };
}

/** Validate every pair, then publish in one write so a bad value stores nothing. */
export function mergePreferences(entries: [SettingKey, string][]) {
  const all = { ...current() };
  for (const [key, value] of entries) {
    validate(key, value);
    all[key] = value;
  }
  publish(all);
  return entries.map(([key]) => ({ key, ...mask(key, all[key]) }));
}

function publish(values: Partial<Record<SettingKey, string>>) {
  new State(preferenceDirectory()).write(document, { version: 1, values });
}
