import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { childEnv } from "./command.ts";

const name = "chatgpt-review";
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
  const source = resolve(import.meta.dir, "../skills");
  const canonical = join(root, ".agents/skills", name);
  const targets = [
    ...new Set([
      canonical,
      ...agents.flatMap((a) =>
        a === "claude-code"
          ? [join(root, ".claude/skills", name)]
          : scope === "user"
            ? [join(root, ".codex/skills", name)]
            : [],
      ),
    ]),
  ];
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
  const argv = [
    process.execPath,
    "--no-env-file",
    "x",
    "skills@1.6.0",
    "add",
    source,
    "--skill",
    name,
    "--agent",
    ...agents,
    "--yes",
    ...(scope === "user" ? ["--global"] : []),
  ];
  return {
    argv,
    cwd,
    source,
    scope,
    agents,
    canonical,
    installed: [
      canonical,
      ...(agents.includes("claude-code")
        ? [join(root, ".claude/skills", name)]
        : []),
    ],
  };
}

export async function installSkill(opts: Record<string, string>) {
  const plan = skillInstallPlan(opts);
  const child = Bun.spawn(plan.argv, {
    cwd: plan.cwd,
    env: { ...childEnv(), DO_NOT_TRACK: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(
      `SKILL_INSTALL_FAILED: skills exited ${code}; inspect partial installation before retrying`,
    );
  const expected = readFileSync(join(plan.source, name, "SKILL.md"), "utf8");
  for (const target of plan.installed)
    if (readFileSync(join(target, "SKILL.md"), "utf8") !== expected)
      throw new Error(`SKILL_INSTALL_UNVERIFIED: ${target}`);
  return {
    installed: true,
    agents: plan.agents,
    scope: plan.scope,
    paths: plan.installed,
    runtime: resolve(import.meta.dir, "cli.ts"),
    note: "Use convorel on PATH, or set CONVOREL_BIN to this CLI script. Skill installation does not configure browser login or code access.",
  };
}
