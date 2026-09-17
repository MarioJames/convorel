import {
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
export const packageRoot = resolve(import.meta.dir, "..");
export const skillSource = join(packageRoot, "skills/convorel");
export function skillInstall(directory = join(homedir(), ".agents/skills")) {
  const destination = join(resolve(directory), "convorel");
  mkdirSync(resolve(directory), { recursive: true });
  try {
    symlinkSync(skillSource, destination, "dir");
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    if (!lstatSync(destination).isSymbolicLink())
      throw new Error(
        "SKILL_DESTINATION_CONFLICT: existing files were preserved",
      );
    let same = false;
    try {
      same = realpathSync(destination) === realpathSync(skillSource);
    } catch {}
    if (!same)
      throw new Error(
        "SKILL_DESTINATION_CONFLICT: existing link was preserved",
      );
    return {
      installed: true,
      changed: false,
      destination,
      source: skillSource,
    };
  }
  return { installed: true, changed: true, destination, source: skillSource };
}
export function skillUninstall(directory = join(homedir(), ".agents/skills")) {
  const destination = join(resolve(directory), "convorel");
  let entry;
  try {
    entry = lstatSync(destination);
  } catch (e: any) {
    if (e.code === "ENOENT") return { removed: false, destination };
    throw e;
  }
  let same = false;
  try {
    same = realpathSync(destination) === realpathSync(skillSource);
  } catch {}
  if (!entry.isSymbolicLink() || !same)
    throw new Error(
      "SKILL_DESTINATION_CONFLICT: only this installation can be removed",
    );
  unlinkSync(destination);
  return { removed: true, destination };
}
