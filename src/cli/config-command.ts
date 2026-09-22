import {
  mask,
  preference,
  preferenceDirectory,
  preferenceFile,
  resolveSetting,
  settingKeys,
  writePreference,
  type SettingKey,
} from "../config/preferences.ts";

function display(key: SettingKey) {
  const value = preference(key);
  return {
    key,
    source: value === undefined ? "unset" : "preferences",
    ...mask(key, value),
  };
}

function requestedKey(args: string[], command: string) {
  const key = args[0] ? resolveSetting(args[0]) : undefined;
  if (!key) throw new Error(`CONFIG_KEY_REQUIRED: config ${command}`);
  return key;
}

/** Positional arguments, because `config set KEY VALUE` takes no option flags. */
export function configCommand(sub: string | undefined, args: string[]) {
  if (sub === "path")
    return {
      directory: preferenceDirectory(),
      file: preferenceFile(),
    };
  if (sub === "list")
    return {
      file: preferenceFile(),
      settings: settingKeys.map((key) => display(key)),
    };
  if (sub === "get") return display(requestedKey(args, "get KEY"));
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
  throw new Error("UNKNOWN_CONFIG_COMMAND: use list, get, set, unset, or path");
}
