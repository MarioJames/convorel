import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type RuntimePaths = { configDir?: string; stateDir?: string };
let selected: RuntimePaths = {};

/** Explicit process-local options, also used to isolate in-process consumers. */
export function setRuntimePaths(paths: RuntimePaths) {
  const previous = selected;
  selected = Object.fromEntries(
    Object.entries(paths)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, resolve(value!)]),
  );
  return previous;
}
export const configDirectory = () =>
  selected.configDir ?? join(homedir(), ".config/convorel");
export const stateDirectory = () =>
  selected.stateDir ?? join(homedir(), ".local/share/convorel");
export function runtimePathArgs() {
  return [
    ...(selected.configDir ? ["--config-dir", selected.configDir] : []),
    ...(selected.stateDir ? ["--state-dir", selected.stateDir] : []),
  ];
}

/** Global options precede the command so option-like config values stay literal. */
export function consumeRuntimeArgs(input: string[]) {
  const args = [...input],
    paths = { ...selected };
  while (args[0] === "--config-dir" || args[0] === "--state-dir") {
    const key = args.shift()!,
      value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error(`Missing ${key} PATH`);
    paths[key === "--config-dir" ? "configDir" : "stateDir"] = value;
  }
  setRuntimePaths(paths);
  return args;
}
