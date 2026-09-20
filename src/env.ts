import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { assetPath, COMPILED } from "./runtime.ts";
import { preference, type SettingKey } from "./user-config.ts";
export type SettingSource = "env" | "installation" | "preferences" | "unset";
export type Setting = { value?: string; source: SettingSource };

/** A standalone executable has no installation directory to read from. */
export function installationFile() {
  return COMPILED ? undefined : assetPath(".env");
}

/** Resolve against this installation, never the caller's or shared workspace's cwd.
 * Process environment (including empty) > installation file > preferences file.
 * The installation file wins so a source checkout keeps its own explicit settings;
 * it never exists for a standalone executable, where preferences are the config. */
export function setting(
  key: SettingKey,
  file = installationFile(),
  env: NodeJS.ProcessEnv = process.env,
): Setting {
  if (env[key] !== undefined) return { value: env[key], source: "env" };
  if (file !== undefined) {
    let contents: string | undefined;
    try {
      contents = readFileSync(file, "utf8");
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new Error(
          "INSTALLATION_ENV_READ_FAILED: cannot read convorel .env",
        );
    }
    // Parse only; do not execute shell syntax or import unrelated settings.
    const parsed = contents === undefined ? undefined : parseEnv(contents);
    if (parsed?.[key] !== undefined)
      return { value: parsed[key], source: "installation" };
  }
  const stored = preference(key);
  return stored === undefined
    ? { value: undefined, source: "unset" }
    : { value: stored, source: "preferences" };
}

export function settingValue(
  key: SettingKey,
  file = installationFile(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return setting(key, file, env).value;
}
