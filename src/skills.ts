import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { assetPath, cliScript, COMPILED } from "./runtime.ts";

const name = "chatgpt-review";

/** Embedded assets keep their relative path, so the bundled tree is walked. */
function bundleFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? bundleFiles(join(root, entry.name)).map(
          (file) => `${entry.name}/${file}`,
        )
      : [entry.name],
  );
}

export function skillInstallPlan(opts: Record<string, string>) {
  for (const key of Object.keys(opts))
    if (!["agent", "scope", "cwd"].includes(key))
      throw new Error(`Unknown skills option --${key}`);
  const agents = [...new Set((opts.agent || "").split(","))];
  if (
    !agents.length ||
    agents.some((a) => !["codex", "claude-code"].includes(a))
  )
    throw new Error("Choose --agent codex, claude-code, or codex,claude-code");
  const scope = opts.scope || "user";
  if (scope !== "user" && scope !== "project")
    throw new Error("Choose --scope user or project");
  const cwd = realpathSync(opts.cwd || process.cwd());
  const root = scope === "user" ? homedir() : cwd;
  const source = assetPath("skills", name);
  const canonical = join(root, ".agents/skills", name);
  const links = agents.flatMap((a) =>
    a === "claude-code"
      ? [join(root, ".claude/skills", name)]
      : scope === "user"
        ? [join(root, ".codex/skills", name)]
        : [],
  );
  const targets = [...new Set([canonical, ...links])];
  // Check dangling links as well as directories. Never pass overwrite consent for an existing skill.
  for (const target of targets) {
    try {
      lstatSync(target);
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    throw new Error(
      `SKILL_ALREADY_EXISTS: ${target}; inspect and migrate the existing skill before installing`,
    );
  }
  return { source, canonical, targets, scope, agents };
}

export async function installSkill(opts: Record<string, string>) {
  const { source, canonical, targets, scope, agents } = skillInstallPlan(opts);
  const files = bundleFiles(source);
  if (!files.includes("SKILL.md")) throw new Error("SKILL_BUNDLE_INCOMPLETE");
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    if (target === canonical) {
      for (const file of files) {
        const to = join(canonical, file);
        mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
        chmodSync(dirname(to), 0o755);
        writeFileSync(to, readFileSync(join(source, file)), { mode: 0o644 });
      }
    } else {
      // One canonical copy per root keeps a personal edit visible to every agent.
      symlinkSync(relative(dirname(target), canonical), target);
    }
  }
  const expected = readFileSync(join(source, "SKILL.md"), "utf8");
  for (const target of targets)
    if (readFileSync(join(target, "SKILL.md"), "utf8") !== expected)
      throw new Error(`SKILL_INSTALL_UNVERIFIED: ${target}`);
  return {
    installed: true,
    agents,
    scope,
    files,
    paths: targets,
    runtime: COMPILED ? process.execPath : cliScript,
    note: "Use convorel on PATH, or set CONVOREL_BIN to this executable. Skill installation does not configure browser login or code access.",
  };
}
