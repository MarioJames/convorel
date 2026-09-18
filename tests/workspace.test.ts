import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";
let dir: string;
const put = (p: string, s: string) => writeFileSync(join(dir, p), s);
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (r.exitCode) throw new Error(r.stderr.toString());
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "convorel-ws-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test("shared policy blocks secrets, traversal, absolute paths, symlinks and ignored contents", async () => {
  put("code.ts", "hello\nworld\n");
  put(".env", "SECRET_SENTINEL");
  put(".gitignore", "private/\n");
  mkdirSync(join(dir, "private"));
  put("private/code.ts", "SECRET_SENTINEL");
  symlinkSync(join(dir, ".env"), join(dir, "alias.txt"));
  symlinkSync("/etc", join(dir, "outside"));
  const ws = new Workspace(dir);
  for (const p of [
    "../etc/passwd",
    "/etc/passwd",
    ".env",
    "alias.txt",
    "outside/passwd",
    "private/code.ts",
  ])
    await expect(ws.read(p)).rejects.toThrow();
  const listing = await ws.list(".");
  expect(JSON.stringify(listing)).not.toContain(".env");
  expect(JSON.stringify(listing)).not.toContain("alias");
  expect((await ws.search("SECRET_SENTINEL")).matches).toEqual([]);
  const r = await ws.read("code.ts", 2, 1);
  expect(r.content).toBe("world");
  expect(r.startLine).toBe(2);
  expect(r.sha256).toHaveLength(64);
});
test("nested ignore, hard byte/line budgets, literal search and changed root", async () => {
  mkdirSync(join(dir, "src"));
  put("src/.gitignore", "hidden.ts\n");
  put("src/hidden.ts", "secret");
  put("src/visible.ts", "a.*b\n");
  put("big.txt", "x".repeat(2 * 1024 * 1024));
  const ws = new Workspace(dir);
  await expect(ws.read("src/hidden.ts")).rejects.toThrow();
  await expect(ws.read("big.txt")).rejects.toThrow();
  await expect(ws.read("src/visible.ts", 0, 10)).rejects.toThrow();
  expect((await ws.search(".*")).matches.length).toBe(1);
  const moved = dir + "-old";
  renameSync(dir, moved);
  mkdirSync(dir);
  put("src.txt", "replacement");
  try {
    await expect(ws.read("src.txt")).rejects.toThrow();
  } finally {
    rmSync(moved, { recursive: true, force: true });
  }
});
test("git status/diff filter sensitive paths and both sides of renames; git errors are not clean", async () => {
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  put("code.ts", "old\n");
  put(".env", "SECRET_SENTINEL\n");
  git("add", "-f", ".env", "code.ts");
  git("commit", "-qm", "fixture");
  put("code.ts", "new\n");
  put(".env", "NEW_SECRET_SENTINEL\n");
  const ws = new Workspace(dir);
  const d = await ws.diff("unstaged");
  expect(d.diff).toContain("+new");
  expect(d.diff).not.toContain("SECRET");
  expect(d.hidden).toBeGreaterThan(0);
  expect(JSON.stringify(await ws.status())).not.toContain(".env");
  git("mv", ".env", "public.txt");
  const renamed = await ws.diff("staged");
  expect(renamed.diff).not.toContain("SECRET");
  expect(renamed.diff).not.toContain("public.txt");
  const elsewhere = mkdtempSync(join(tmpdir(), "convorel-no-git-"));
  try {
    await expect(new Workspace(elsewhere).status()).rejects.toThrow();
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
test("git does not run external diff or textconv commands", async () => {
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  put("code.ts", "before");
  git("add", ".");
  git("commit", "-qm", "fixture");
  put("code.ts", "after");
  git("config", "diff.external", "false");
  expect((await new Workspace(dir).diff("unstaged")).diff).toContain("+after");
});
test("git disables fsmonitor and refuses clean/process filters before worktree inspection", async () => {
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  put("code.ts", "before");
  git("add", ".");
  git("commit", "-qm", "fixture");
  put("code.ts", "after");
  git("config", "core.fsmonitor", "touch marker");
  const ws = new Workspace(dir);
  expect((await ws.diff()).diff).toContain("+after");
  expect(await Bun.file(join(dir, "marker")).exists()).toBe(false);
  git("config", "filter.custom.clean", "touch marker");
  put(".gitattributes", "*.ts filter=custom");
  await expect(ws.status()).rejects.toThrow("GIT_FILTER_UNSUPPORTED");
  await expect(ws.diff()).rejects.toThrow("GIT_FILTER_UNSUPPORTED");
  expect(await Bun.file(join(dir, "marker")).exists()).toBe(false);
});
test("search limits UTF-8 output and reports depth truncation", async () => {
  put("many.txt", Array(80).fill("中".repeat(1000)).join("\n"));
  const ws = new Workspace(dir),
    r = await ws.search("中");
  expect(Buffer.byteLength(JSON.stringify(r.matches))).toBeLessThanOrEqual(
    65536,
  );
  expect(r.truncated).toBe(true);
  mkdirSync(join(dir, ...Array(14).fill("deep")), { recursive: true });
  expect((await ws.search("absent")).truncated).toBe(true);
});
