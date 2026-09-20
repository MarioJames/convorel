import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, skillInstallPlan } from "../src/skills.ts";

test("skill installation refuses existing personal content and dangling links before invoking an installer", () => {
  const cwd = mkdtempSync(join(tmpdir(), "convorel-skills-"));
  const path = join(cwd, ".agents/skills/chatgpt-review");
  try {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "personal instructions");
    expect(() =>
      skillInstallPlan({ agent: "codex", scope: "project", cwd }),
    ).toThrow("SKILL_ALREADY_EXISTS");
    expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe(
      "personal instructions",
    );
    rmSync(path, { recursive: true });
    symlinkSync(join(cwd, "missing-source"), path);
    expect(() =>
      skillInstallPlan({ agent: "claude-code", scope: "project", cwd }),
    ).toThrow("SKILL_ALREADY_EXISTS");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("skill installation requires explicit supported agents and a valid scope", () => {
  expect(() => skillInstallPlan({})).toThrow("--agent");
  expect(() => skillInstallPlan({ agent: "*" })).toThrow("--agent");
  expect(() => skillInstallPlan({ agent: "codex", scope: "system" })).toThrow(
    "--scope",
  );
});

test("custom directory installs the complete skill and refuses conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-custom-skills-"));
  try {
    const dir = join(root, "custom skills");
    const installed = await installSkill({ dir });
    expect(installed.paths).toEqual([join(dir, "chatgpt-review")]);
    expect(installed.scope).toBe("directory");
    expect(installed.agents).toEqual([]);
    for (const file of installed.files)
      expect(readFileSync(join(installed.paths[0], file), "utf8")).toBe(
        readFileSync(
          join(import.meta.dir, "../skills/chatgpt-review", file),
          "utf8",
        ),
      );
    writeFileSync(join(installed.paths[0], "SKILL.md"), "personal edit");
    await expect(installSkill({ dir })).rejects.toThrow("SKILL_ALREADY_EXISTS");
    expect(readFileSync(join(installed.paths[0], "SKILL.md"), "utf8")).toBe(
      "personal edit",
    );
    const conflicts: Record<string, string>[] = [
      { agent: "codex" },
      { scope: "user" },
      { cwd: root },
    ];
    for (const conflicting of conflicts)
      expect(() => skillInstallPlan({ dir, ...conflicting })).toThrow(
        "cannot be combined",
      );
    expect(() => skillInstallPlan({ dir: "" })).toThrow("directory path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
