import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceAccess } from "../src/workspace-access.ts";

test("multiple fixed roots retain parent policies for full file paths and repository tools", async () => {
  const base = mkdtempSync(join(tmpdir(), "convorel-roots-"));
  try {
    const a = join(base, "workspaces"),
      b = join(base, "opensource"),
      repo = join(a, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(b);
    writeFileSync(join(a, ".convorelignore"), "repo/parent-hidden.txt\n");
    writeFileSync(join(repo, "parent-hidden.txt"), "SECRET_MARKER\n");
    writeFileSync(join(repo, ".env.local"), "SECRET_MARKER\n");
    writeFileSync(join(repo, "code.ts"), "export const a = 1;\n");
    writeFileSync(join(b, "code.ts"), "export const b = 2;\n");
    symlinkSync(b, join(a, "jump"));
    const access = new WorkspaceAccess([a, b]);
    const roots = access.roots;
    const located = access.file(join(b, "code.ts"));
    expect((await located.workspace.read(located.path)).content).toContain(
      "b = 2",
    );
    expect(() => access.file("relative/code.ts")).toThrow();
    expect(() => access.file(a + "-sibling/code.ts")).toThrow();
    expect(roots).toHaveLength(2);
    expect((await access.directory(repo).read("code.ts")).content).toContain(
      "a = 1",
    );
    expect((await access.directory(b).read("code.ts")).content).toContain(
      "b = 2",
    );
    await expect(
      access.directory(repo).read("parent-hidden.txt"),
    ).rejects.toThrow();
    await expect(access.directory(repo).read(".env.local")).rejects.toThrow();
    expect(() => access.directory(join(base, "unknown"))).toThrow(
      "ACCESS_DENIED",
    );
    await expect(access.directory(a).read("../outside.txt")).rejects.toThrow();
    await expect(access.directory(a).read("/etc/passwd")).rejects.toThrow();
    writeFileSync(join(repo, ".gitignore"), "!.env.local\n");
    await expect(access.directory(repo).read(".env.local")).rejects.toThrow();
    expect(() => access.directory(a + "/../opensource")).toThrow();
    expect(() => access.directory(join(a, "jump"))).toThrow();
    expect(
      JSON.stringify(await access.directory(a).search("SECRET_MARKER")),
    ).not.toContain("SECRET_MARKER");
    expect(
      JSON.stringify(await access.directory(a).list("repo")),
    ).not.toContain(".env.local");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...args]);
      if (result.exitCode) throw Error(result.stderr.toString());
    };
    git("init", "-q");
    git("add", "-f", "code.ts", "parent-hidden.txt", ".env.local");
    const selected = access.directory(repo);
    const diff = await selected.diff("staged");
    expect(diff.diff).toContain("a = 1");
    expect(diff.diff).not.toContain("SECRET_MARKER");
    expect(JSON.stringify(await selected.status())).not.toContain(
      "parent-hidden.txt",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("root configuration rejects empty, overlapping and symlink roots; selection rejects outside paths", () => {
  const base = mkdtempSync(join(tmpdir(), "convorel-roots-"));
  try {
    const a = join(base, "a"),
      b = join(base, "b");
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(a, join(base, "alias"));
    expect(() => new WorkspaceAccess([])).toThrow();
    expect(() => new WorkspaceAccess([a, a])).toThrow();
    expect(() => new WorkspaceAccess([base, a])).toThrow();
    expect(() => new WorkspaceAccess([join(base, "alias")])).toThrow();
    expect(() => new WorkspaceAccess([a]).directory(b)).toThrow();
    const access = new WorkspaceAccess([a]);
    expect(() => access.assertPrivate(join(a, "state"))).toThrow();
    expect(() => access.assertPrivate(join(b, "state"))).not.toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("nested custom policies apply from the parent entry and selected root replacement is rejected", async () => {
  const { renameSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "convorel-boundary-"));
  try {
    const a = join(base, "a"),
      b = join(base, "b"),
      repo = join(b, "repo");
    mkdirSync(a);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".convorelignore"), "hidden.txt\n");
    writeFileSync(join(repo, "hidden.txt"), "PRIVATE_NONCE\n");
    writeFileSync(join(repo, "ok.txt"), "public\n");
    const access = new WorkspaceAccess([a, b]);
    const file = access.file(join(repo, "hidden.txt"));
    await expect(file.workspace.read(file.path)).rejects.toThrow();
    expect(
      JSON.stringify(await access.directory(b).search("PRIVATE_NONCE")),
    ).not.toContain("PRIVATE_NONCE");
    expect(
      JSON.stringify(await access.directory(b).list("repo")),
    ).not.toContain("hidden.txt");
    renameSync(b, join(base, "old-b"));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "ok.txt"), "replacement\n");
    expect(() => access.directory(repo)).toThrow("WORKSPACE_REPLACED");
    expect(() => access.file(join(repo, "ok.txt"))).toThrow(
      "WORKSPACE_REPLACED",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Git worktrees require allowed metadata and refuse alternate object stores", async () => {
  const base = mkdtempSync(join(tmpdir(), "convorel-git-boundary-"));
  try {
    const sources = join(base, "sources"),
      work = join(base, "work"),
      repo = join(sources, "repo"),
      checkout = join(work, "checkout");
    mkdirSync(repo, { recursive: true });
    mkdirSync(work);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: base,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
      if (result.exitCode) throw Error(result.stderr.toString());
    };
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "code.ts"), "before\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
    git("worktree", "add", "-qb", "fixture", checkout);
    writeFileSync(join(checkout, "code.ts"), "after\n");
    const allowed = new WorkspaceAccess([sources, work]);
    expect((await allowed.directory(checkout).diff()).diff).toContain("+after");
    const restricted = new WorkspaceAccess([work]);
    await expect(restricted.directory(checkout).status()).rejects.toThrow(
      "GIT_STORAGE_OUTSIDE_ROOTS",
    );
    await expect(restricted.directory(checkout).diff()).rejects.toThrow(
      "GIT_STORAGE_OUTSIDE_ROOTS",
    );
    writeFileSync(
      join(repo, ".git/objects/info/alternates"),
      "/unapproved/objects\n",
    );
    await expect(allowed.directory(checkout).diff()).rejects.toThrow(
      "GIT_ALTERNATES_UNSUPPORTED",
    );
    await expect(allowed.directory(repo).status()).rejects.toThrow(
      "GIT_ALTERNATES_UNSUPPORTED",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
