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
import { skillInstallPlan } from "../src/skills.ts";

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
