import { test, expect, spyOn } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSkill,
  updateSkill,
  installSkill,
  skillInstallPlan,
} from "../src/skills.ts";

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

test("managed updates preserve local-only edits, apply bundle changes and record the new baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-update-"));
  try {
    const source = join(root, "bundle");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"), "original entry");
    writeFileSync(join(source, "guide.md"), "original guide");
    writeFileSync(join(source, "removed.md"), "obsolete");
    const bundle = { source, version: "1.0.0" };
    const opts = { dir: join(root, "installed") };
    const installed = await installSkill(opts, bundle);
    const target = installed.paths[0];
    expect(checkSkill(opts, bundle).status).toBe("current");
    writeFileSync(join(target, "SKILL.md"), "personal entry");
    writeFileSync(join(target, "notes.md"), "personal notes");
    writeFileSync(join(source, "guide.md"), "new guide");
    rmSync(join(source, "removed.md"));
    bundle.version = "2.0.0";
    const check = checkSkill(opts, bundle);
    expect(check.status).toBe("update-available");
    expect(check.localChanges).toEqual(["SKILL.md", "notes.md"]);
    expect((await updateSkill(opts, bundle)).updated).toBe(true);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(
      "personal entry",
    );
    expect(readFileSync(join(target, "notes.md"), "utf8")).toBe(
      "personal notes",
    );
    expect(readFileSync(join(target, "guide.md"), "utf8")).toBe("new guide");
    expect(existsSync(join(target, "removed.md"))).toBe(false);
    expect(checkSkill(opts, bundle).baselineVersion).toBe("2.0.0");
    expect(checkSkill(opts, bundle).status).toBe("current");
    expect((await updateSkill(opts, bundle)).updated).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting changes reject the whole update and retain content and baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-conflict-"));
  try {
    const source = join(root, "bundle");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"), "base");
    writeFileSync(join(source, "guide.md"), "base guide");
    const bundle = { source, version: "1" };
    const opts = { dir: join(root, "installed") };
    const target = (await installSkill(opts, bundle)).paths[0];
    const before = readFileSync(join(target, ".convorel-skill.json"), "utf8");
    writeFileSync(join(target, "SKILL.md"), "personal edit");
    writeFileSync(join(source, "SKILL.md"), "upstream edit");
    writeFileSync(join(source, "guide.md"), "new guide");
    bundle.version = "2";
    expect(checkSkill(opts, bundle).conflicts).toEqual(["SKILL.md"]);
    const result = await updateSkill(opts, bundle);
    expect(result.updated).toBe(false);
    expect(result.status).toBe("conflict");
    expect(readFileSync(join(target, "guide.md"), "utf8")).toBe("base guide");
    expect(readFileSync(join(target, ".convorel-skill.json"), "utf8")).toBe(
      before,
    );
    // Explicit manual reconciliation to the incoming content permits a safe update.
    writeFileSync(join(target, "SKILL.md"), "upstream edit");
    expect((await updateSkill(opts, bundle)).updated).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy skills need a known old bundle unless they already match the bundled tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-legacy-"));
  try {
    const source = join(root, "bundle");
    const old = join(root, "old");
    const opts = { dir: join(root, "installed") };
    const target = join(opts.dir, "chatgpt-review");
    for (const path of [source, old, target])
      mkdirSync(path, { recursive: true });
    for (const path of [old, target])
      writeFileSync(join(path, "SKILL.md"), "old");
    writeFileSync(join(source, "SKILL.md"), "new");
    const bundle = { source, version: "2" };
    expect(checkSkill(opts, bundle).status).toBe("unmanaged");
    expect((await updateSkill(opts, bundle)).updated).toBe(false);
    expect(existsSync(join(target, ".convorel-skill.json"))).toBe(false);
    expect(
      (await updateSkill({ ...opts, "baseline-dir": old }, bundle)).updated,
    ).toBe(true);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("new");
    rmSync(join(target, ".convorel-skill.json"));
    expect(checkSkill(opts, bundle).canUpdate).toBe(true);
    expect((await updateSkill(opts, bundle)).updated).toBe(true);
    expect(checkSkill(opts, bundle).status).toBe("current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checking missing installations is read-only and refuses unsafe metadata and links", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-safety-"));
  const opts = { dir: join(root, "missing") };
  try {
    expect(checkSkill(opts).status).toBe("missing");
    expect(existsSync(opts.dir)).toBe(false);
    const target = (await installSkill(opts)).paths[0];
    const metadata = join(target, ".convorel-skill.json");
    writeFileSync(metadata, '{"version":99}');
    expect(() => checkSkill(opts)).toThrow("SKILL_BASELINE_INVALID");
    rmSync(metadata);
    await expect(
      updateSkill({ ...opts, "baseline-dir": target }),
    ).rejects.toThrow("SKILL_BASELINE_UNTRUSTED");
    symlinkSync(join(root, "outside"), join(target, "personal-link"));
    await expect(updateSkill(opts)).rejects.toThrow("SKILL_UNSAFE_ENTRY");
    expect(fs.lstatSync(join(target, "personal-link")).isSymbolicLink()).toBe(
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update rolls back a failed directory switch and keeps agent links intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-rollback-"));
  const source = join(root, "bundle");
  const opts = { agent: "claude-code", scope: "project", cwd: root };
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "old");
  const bundle = { source, version: "1" };
  const target = (await installSkill(opts, bundle)).paths[0];
  const alias = join(root, ".claude/skills/chatgpt-review");
  const metadata = readFileSync(join(target, ".convorel-skill.json"), "utf8");
  writeFileSync(join(source, "SKILL.md"), "new");
  bundle.version = "2";
  const original = fs.renameSync;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from).endsWith("/staged"))
      throw new Error("simulated switch failure");
    return original(from, to);
  });
  try {
    await expect(updateSkill(opts, bundle)).rejects.toThrow(
      "simulated switch failure",
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old");
    expect(readFileSync(join(alias, "SKILL.md"), "utf8")).toBe("old");
    expect(readFileSync(join(target, ".convorel-skill.json"), "utf8")).toBe(
      metadata,
    );
    expect(
      existsSync(join(root, ".agents/skills/.chatgpt-review.convorel-lock")),
    ).toBe(false);
    rename.mockRestore();
    expect((await updateSkill(opts, bundle)).updated).toBe(true);
    expect(readFileSync(join(alias, "SKILL.md"), "utf8")).toBe("new");
  } finally {
    rename.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed rollback retains the previous tree and blocks later mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-recovery-"));
  const source = join(root, "bundle");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "old");
  const opts = { dir: join(root, "installed") },
    bundle = { source, version: "1" };
  await installSkill(opts, bundle);
  writeFileSync(join(source, "SKILL.md"), "new");
  const original = fs.renameSync;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from).endsWith("/staged") || String(from).endsWith("/previous"))
      throw new Error("simulated disk failure");
    return original(from, to);
  });
  try {
    await expect(updateSkill(opts, bundle)).rejects.toThrow(
      "SKILL_ROLLBACK_FAILED",
    );
    const lock = join(opts.dir, ".chatgpt-review.convorel-lock");
    expect(readFileSync(join(lock, "previous/SKILL.md"), "utf8")).toBe("old");
    expect(readFileSync(join(lock, "staged/SKILL.md"), "utf8")).toBe("new");
    expect(
      JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).operation,
    ).toBe("update");
    expect(() => checkSkill(opts, bundle)).toThrow("SKILL_UPDATE_LOCKED");
  } finally {
    rename.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("upstream deletion and file-directory transitions never discard local customizations", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-paths-"));
  try {
    const source = join(root, "bundle");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"), "entry");
    writeFileSync(join(source, "guide"), "base");
    const opts = { dir: join(root, "installed") },
      bundle = { source, version: "1" };
    const target = (await installSkill(opts, bundle)).paths[0];
    writeFileSync(join(target, "guide"), "custom");
    rmSync(join(source, "guide"));
    mkdirSync(join(source, "guide"));
    writeFileSync(join(source, "guide/new.md"), "new");
    expect((await updateSkill(opts, bundle)).status).toBe("conflict");
    expect(readFileSync(join(target, "guide"), "utf8")).toBe("custom");
    writeFileSync(join(target, "guide"), "base");
    expect((await updateSkill(opts, bundle)).updated).toBe(true);
    expect(readFileSync(join(target, "guide/new.md"), "utf8")).toBe("new");
    // A locally removed entry must not be silently restored by a different upstream edit.
    rmSync(join(target, "guide/new.md"));
    writeFileSync(join(source, "guide/new.md"), "changed");
    expect(checkSkill(opts, bundle).conflicts).toContain("guide/new.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late personal edit during activation is retained by rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-late-edit-"));
  const source = join(root, "bundle");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "old");
  const opts = { dir: join(root, "installed") },
    bundle = { source, version: "1" };
  const target = (await installSkill(opts, bundle)).paths[0];
  writeFileSync(join(source, "SKILL.md"), "new");
  const original = fs.renameSync;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    original(from, to);
    if (String(to).endsWith("/previous"))
      writeFileSync(join(String(to), "SKILL.md"), "late personal edit");
  });
  try {
    await expect(updateSkill(opts, bundle)).rejects.toThrow(
      "SKILL_CHANGED_DURING_UPDATE",
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(
      "late personal edit",
    );
  } finally {
    rename.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed agent-link creation removes only the installation made by this attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-skill-install-rollback-"));
  const opts = { agent: "claude-code", scope: "project", cwd: root };
  const link = spyOn(fs, "symlinkSync").mockImplementation(() => {
    throw new Error("simulated link failure");
  });
  try {
    await expect(installSkill(opts)).rejects.toThrow("simulated link failure");
    expect(existsSync(join(root, ".agents/skills/chatgpt-review"))).toBe(false);
    expect(
      existsSync(join(root, ".agents/skills/.chatgpt-review.convorel-lock")),
    ).toBe(false);
    link.mockRestore();
    expect((await installSkill(opts)).installed).toBe(true);
  } finally {
    link.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
