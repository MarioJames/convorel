import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { installationFile, setting } from "./env.ts";
import {
  mask,
  mergePreferences,
  preferenceDirectory,
  preferenceFile,
  resolveSetting,
  settingKeys,
  writePreference,
  type SettingKey,
} from "./user-config.ts";

const precedence =
  "command line > process environment (including empty) > installation .env > preferences file";

function display(
  key: SettingKey,
  env: NodeJS.ProcessEnv,
  file = installationFile(),
) {
  const { value, source } = setting(key, file, env);
  return { key, source, ...mask(key, value) };
}

function requestedKey(args: string[], command: string) {
  const key = args[0] ? resolveSetting(args[0]) : undefined;
  if (!key) throw new Error(`CONFIG_KEY_REQUIRED: config ${command}`);
  return key;
}

/** Positional arguments, because `config set KEY VALUE` takes no option flags. */
export function configCommand(
  sub: string | undefined,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  file = installationFile(),
) {
  if (sub === "path")
    return {
      directory: preferenceDirectory(),
      file: preferenceFile(),
      installation: file ?? "standalone executable",
    };
  if (sub === "list")
    return {
      file: preferenceFile(),
      precedence,
      settings: settingKeys.map((key) => display(key, env, file)),
    };
  if (sub === "get") return display(requestedKey(args, "get KEY"), env, file);
  if (sub === "set") {
    const key = requestedKey(args, "set KEY VALUE");
    if (args[1] === undefined)
      throw new Error(
        `CONFIG_VALUE_REQUIRED: config set ${key} VALUE; use config unset ${key} to remove it`,
      );
    return { action: "set", ...writePreference(key, args[1]) };
  }
  if (sub === "unset")
    return {
      action: "unset",
      ...writePreference(requestedKey(args, "unset KEY"), ""),
    };
  if (sub === "import-env") {
    if (!file)
      throw new Error(
        "IMPORT_ENV_UNSUPPORTED: this installation has no .env to read; use convorel config set",
      );
    let stored: Record<string, string | undefined>;
    try {
      stored = parseEnv(readFileSync(file, "utf8"));
    } catch (error: any) {
      if (error.code === "ENOENT")
        throw new Error(`IMPORT_ENV_NOT_FOUND: nothing to import in ${file}`);
      throw new Error(
        "INSTALLATION_ENV_READ_FAILED: cannot read convorel .env",
      );
    }
    const present: [SettingKey, string][] = [];
    for (const key of settingKeys) {
      const value = stored[key];
      if (value) present.push([key, value]);
    }
    if (!present.length)
      throw new Error(`IMPORT_ENV_NOT_FOUND: nothing to import in ${file}`);
    return { action: "import-env", settings: mergePreferences(present) };
  }
  throw new Error(
    "UNKNOWN_CONFIG_COMMAND: use list, get, set, unset, path or import-env",
  );
}
