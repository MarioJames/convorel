import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Workspace } from "../src/workspace.ts";
import { GitHistory, type HistoryAccess } from "../src/git-history.ts";
import {
  gitHistoryInputs,
  gitHistoryOutputs,
} from "../src/git-history-schemas.ts";

let dir: string;
let history: GitHistory;
let access: HistoryAccess;
let readyCalls: number;
const git = (...args: string[]) => {
  const r = Bun.spawnSync(
    [
      "git",
      "--no-replace-objects",
      "--no-lazy-fetch",
      "--literal-pathspecs",
      "-C",
      dir,
      ...args,
    ],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (r.exitCode) throw new Error("GIT_FAILED");
  return Buffer.from(r.stdout);
};
const put = (path: string, content: string | Buffer) =>
  writeFileSync(join(dir, path), content);
const commit = (subject: string) => {
  git("add", "-f", ".");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD").toString().trim();
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "convorel-history-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const ws = new Workspace(dir);
  readyCalls = 0;
  access = {
    root: dir,
    id: ws.id,
    normalize: (p) => ws.normalize(p),
    allowed: (p, d) => ws.allowed(p, d),
    ready: () => {
      readyCalls++;
    },
    git: (args) => git(...args),
  };
  history = new GitHistory(access);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("clean worktree still exposes latest commit and root diff against empty tree", async () => {
  put("code.ts", "first\n");
  const sha = commit("initial");
  expect(git("status", "--porcelain").length).toBe(0);
  const log = await history.log({});
  expect(log.commits[0].sha).toBe(sha);
  expect(log.commits[0].parents).toEqual([]);
  expect(log.commits[0].subject).toBe("initial");
  expect(log.shallow).toBe(false);
  const show = await history.show({});
  expect(show.effectiveBase).toBe(null);
  expect(show.files[0].additions).toBe(1);
  expect(show.patch?.text).toContain("+first");
  expect(show.patch?.nextOffset).toBe(null);
  expect(gitHistoryOutputs.git_log.safeParse(log).success).toBe(true);
  expect(gitHistoryOutputs.git_show.safeParse(show).success).toBe(true);
  expect(readyCalls).toBe(2);
});

test("commit message bodies are available and resume without silently losing rationale", async () => {
  put("code.ts", "first\n");
  const message = "subject\n\n" + "Reason: 中😀\n".repeat(2500);
  const sha = commit(message);
  let offset = 0,
    received = "";
  while (true) {
    const show = await history.show({ ref: sha, messageOffset: offset });
    expect(gitHistoryOutputs.git_show.safeParse(show).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(show))).toBeLessThanOrEqual(
      56 * 1024,
    );
    received += show.message.text;
    if (show.message.nextOffset === null) break;
    expect(show.message.nextOffset).toBeGreaterThan(offset);
    offset = show.message.nextOffset;
  }
  expect(received).toBe(message);
});

test("commit enumeration never starts a repository-configured signature verifier", async () => {
  put("code.ts", "first\n");
  const parent = commit("base"),
    tree = git("rev-parse", "HEAD^{tree}").toString().trim();
  put(
    "signed-commit.txt",
    `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1600000000 +0000\ncommitter Fixture <fixture@example.invalid> 1600000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n ZmFrZQ==\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`,
  );
  const signed = git(
    "hash-object",
    "-t",
    "commit",
    "-w",
    join(dir, "signed-commit.txt"),
  )
    .toString()
    .trim();
  const verifier = join(dir, "verifier");
  put("verifier", '#!/bin/sh\nprintf called > "$0.called"\nexit 1\n');
  chmodSync(verifier, 0o700);
  git("config", "log.showSignature", "true");
  git("config", "gpg.program", verifier);
  try {
    await new Workspace(dir).history().log({ ref: signed });
  } finally {
    expect(existsSync(verifier + ".called")).toBe(false);
  }
});

test("history can continue past ten thousand commits using its returned cursor", async () => {
  const chunks: string[] = [];
  for (let i = 1; i <= 10003; i++)
    chunks.push(
      `commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1600000000 + i} +0000\ndata 1\nx\n${i === 1 ? "" : `from :${i - 1}\n`}\n`,
    );
  const imported = Bun.spawnSync(["git", "-C", dir, "fast-import", "--quiet"], {
    stdin: Buffer.from(chunks.join("")),
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  expect(imported.exitCode).toBe(0);
  const page = await history.log({ offset: 10000, limit: 1 });
  expect(page.nextOffset).toBe(10001);
  const next = await history.log({
    ref: page.resolvedRef,
    offset: page.nextOffset!,
    limit: 1,
  });
  expect(next.commits).toHaveLength(1);
  expect(next.commits[0].sha).not.toBe(page.commits[0].sha);
});

test("merge show selects explicit parents; direct and merge-base retain divergent ancestry", async () => {
  put("root.txt", "root\n");
  const root = commit("root");
  git("checkout", "-qb", "side");
  put("side.txt", "side\n");
  const side = commit("side");
  git("checkout", "main");
  put("main.txt", "main\n");
  const main = commit("main");
  const direct = await history.compare({
    base: "main",
    head: "side",
    mode: "direct",
  });
  const mergeBase = await history.compare({
    base: "main",
    head: "side",
    mode: "merge-base",
  });
  expect(direct.base).toBe(main);
  expect(direct.head).toBe(side);
  expect(direct.effectiveBase).toBe(main);
  expect(direct.files.map((f) => f.path)).toEqual(["main.txt", "side.txt"]);
  expect(mergeBase.effectiveBase).toBe(root);
  expect(mergeBase.mergeBases).toEqual([root]);
  expect(mergeBase.files.map((f) => f.path)).toEqual(["side.txt"]);
  git("merge", "--no-ff", "-qm", "merge", "side");
  expect((await history.show({ parent: 1 })).files.map((f) => f.path)).toEqual([
    "side.txt",
  ]);
  expect((await history.show({ parent: 2 })).files.map((f) => f.path)).toEqual([
    "main.txt",
  ]);
  await expect(history.show({ parent: 3 })).rejects.toThrow();
  expect(gitHistoryOutputs.git_compare.safeParse(mergeBase).success).toBe(true);
});

test("historical deleted files are readable by immutable SHA with raw blob hash", async () => {
  const bytes = Buffer.from("你好\r\nnext\n");
  put("deleted.txt", bytes);
  const sha = commit("add");
  git("rm", "deleted.txt");
  commit("delete");
  const read = await history.read({
    ref: sha,
    filePath: "deleted.txt",
    startLine: 2,
    maxLines: 1,
  });
  expect(read.content).toBe("next");
  expect(read.commit).toBe(sha);
  expect(read.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(read.blob).toBe(
    git("rev-parse", `${sha}:deleted.txt`).toString().trim(),
  );
  expect(gitHistoryOutputs.git_read_file.safeParse(read).success).toBe(true);
  await expect(history.read({ filePath: "deleted.txt" })).rejects.toThrow();
  expect((await history.show({})).patch?.text).toContain("-next");
});

test("rename filtering protects both names and both historical policy snapshots", async () => {
  put(".env", "SECRET_SENTINEL\n");
  put(".convorelignore", "private.txt\n");
  put("private.txt", "HISTORICAL_SECRET\n");
  const base = commit("private");
  git("mv", ".env", "public.txt");
  git("mv", "private.txt", "renamed.txt");
  git("rm", ".convorelignore");
  const head = commit("rename and remove policy");
  const result = await history.compare({ base, head });
  expect(result.summary.hiddenFiles).toBe(2);
  const json = JSON.stringify(result);
  for (const s of [
    "SECRET_SENTINEL",
    "HISTORICAL_SECRET",
    "public.txt",
    "renamed.txt",
  ])
    expect(json).not.toContain(s);
  await expect(
    history.read({ ref: base, filePath: "private.txt" }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    history.compare({ base, head, patchFile: "renamed.txt" }),
  ).rejects.toThrow("ACCESS_DENIED");
});

test("historical ancestor policies fail closed for malformed mode, size and binary", async () => {
  mkdirSync(join(dir, "nested"));
  put("nested/code.ts", "SECRET\n");
  put("nested/.gitignore", "code.ts\n");
  const ignored = commit("historically ignored");
  git("rm", "nested/.gitignore");
  commit("remove policy");
  await expect(
    history.read({ ref: ignored, filePath: "nested/code.ts" }),
  ).rejects.toThrow("ACCESS_DENIED");
  for (const kind of ["symlink", "large", "binary"]) {
    if (kind === "symlink")
      symlinkSync("code.ts", join(dir, "nested/.gitignore"));
    if (kind === "large") put("nested/.gitignore", "x".repeat(65537));
    if (kind === "binary") put("nested/.gitignore", Buffer.from([0, 1, 2]));
    const bad = commit(kind);
    git("rm", "nested/.gitignore");
    commit("remove bad policy");
    await expect(
      history.read({ ref: bad, filePath: "nested/code.ts" }),
    ).rejects.toThrow("POLICY_UNREADABLE");
  }
});

test("invalid refs, revision options and path injection are refused; schemas are strict", async () => {
  put("a.txt", "a\n");
  commit("root");
  for (const ref of ["missing", "--all", "HEAD:a.txt", "HEAD\0", "HEAD --all"])
    await expect(history.show({ ref })).rejects.toThrow();
  for (const filePath of ["../a", "/etc/passwd", "a\\b", ".env"])
    await expect(history.read({ filePath })).rejects.toThrow();
  expect(gitHistoryInputs.git_log.safeParse({ unrelated: true }).success).toBe(
    false,
  );
  expect(
    gitHistoryInputs.git_compare.safeParse({ base: "HEAD", mode: "linear" })
      .success,
  ).toBe(false);
  expect(
    gitHistoryOutputs.git_log.safeParse({
      ...(await history.log({})),
      extra: true,
    }).success,
  ).toBe(false);
});

test("log and changed file pages progress; a large single patch can be fully resumed", async () => {
  put("large.txt", "before\n");
  const base = commit("base");
  const content =
    Array.from({ length: 2500 }, (_, i) => `${i}:` + '中\\"'.repeat(8)).join(
      "\n",
    ) + "\n";
  put("large.txt", content);
  put("second.txt", "second\n");
  const head = commit("change");
  const first = await history.log({ limit: 1 });
  expect(first.nextOffset).toBe(1);
  expect(
    (
      await history.log({
        ref: first.resolvedRef,
        offset: first.nextOffset!,
        limit: 1,
      })
    ).commits[0].sha,
  ).toBe(base);
  let page = await history.compare({ base, head, limit: 1 });
  expect(page.files).toHaveLength(1);
  expect(page.nextOffset).toBe(1);
  expect(
    (await history.compare({ base, head, offset: 1, limit: 1 })).files[0].path,
  ).toBe("second.txt");
  let patch = "";
  let rounds = 0;
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      56 * 1024,
    );
    expect(page.patch?.text.length).toBeGreaterThan(0);
    patch += page.patch!.text;
    if (page.patch!.nextOffset === null) break;
    page = await history.compare({
      base,
      head,
      limit: 1,
      patchFile: "large.txt",
      patchOffset: page.patch!.nextOffset!,
    });
    if (++rounds > 100) throw new Error("non-progressing cursor");
  }
  expect(rounds).toBeGreaterThan(0);
  expect(patch).toContain("+2499:");
  expect(createHash("sha256").update(patch).digest("hex")).toBe(
    page.patch!.sha256,
  );
});

test("binary, invalid UTF-8, symlink, gitlink and oversized historical blobs are refused", async () => {
  put("binary.dat", Buffer.from([1, 0, 3]));
  put("invalid.txt", Buffer.from([0xff, 0xfe]));
  put("large.txt", "x".repeat(1024 * 1024 + 1));
  put("long-line.txt", "x".repeat(60 * 1024));
  symlinkSync("binary.dat", join(dir, "link"));
  const root = commit("bad objects");
  git("update-index", "--add", "--cacheinfo", `160000,${root},submodule`);
  git("commit", "-qm", "gitlink");
  for (const filePath of [
    "binary.dat",
    "invalid.txt",
    "large.txt",
    "link",
    "submodule",
    "long-line.txt",
  ])
    await expect(history.read({ filePath })).rejects.toThrow();
  await expect(history.show({ ref: root })).rejects.toThrow("GIT_INVALID_UTF8");
  const diff = await history.show({ ref: root, patchFile: "long-line.txt" });
  expect(diff.files.map((f) => f.path)).not.toContain("link");
  expect(diff.files.map((f) => f.path)).not.toContain("large.txt");
});

test("ready denial wins before any Git call", async () => {
  let calls = 0;
  const blocked = new GitHistory({
    ...access,
    ready: () => {
      throw new Error("DENIED");
    },
    git: () => {
      calls++;
      return Buffer.alloc(0);
    },
  });
  for (const action of [
    () => blocked.log({}),
    () => blocked.show({}),
    () => blocked.compare({ base: "HEAD" }),
    () => blocked.read({ filePath: "a" }),
  ])
    await expect(action()).rejects.toThrow("DENIED");
  expect(calls).toBe(0);
});

test("a file-to-directory change never expands its patch into hidden descendant files", async () => {
  put("source", "old source\n");
  const base = commit("file");
  git("rm", "source");
  mkdirSync(join(dir, "source"));
  put("source/.env", "DESCENDANT_SECRET\n");
  put("source/public.txt", "public\n");
  const head = commit("directory");
  const result = await history.compare({ base, head, patchFile: "source" });
  expect(result.patch?.text).toContain("-old source");
  expect(result.patch?.text).not.toContain("DESCENDANT_SECRET");
  expect(result.patch?.text).not.toContain("+public");
  expect(result.files.map((f) => f.path)).toContain("source/public.txt");
});

test("shallow log preserves raw parents and show cannot invent an empty-tree comparison", async () => {
  put("a.txt", "before\n");
  const base = commit("before");
  put("a.txt", "after\n");
  const head = commit("after");
  // This task-owned fixture boundary reproduces Git's shallow traversal semantics.
  put(".git/shallow", `${head}\n`);
  const log = await history.log({});
  expect(log.shallow).toBe(true);
  expect(log.commits).toHaveLength(1);
  expect(log.commits[0].parents).toEqual([base]);
  // The object is locally available, so an explicit two-tree diff remains exact.
  const show = await history.show({});
  expect(show.base).toBe(base);
  expect(show.patch?.text).toContain("-before");
  expect(show.patch?.text).toContain("+after");
  rmSync(join(dir, ".git/objects", base.slice(0, 2), base.slice(2)));
  await expect(history.show({})).rejects.toThrow();
});

test("literal filenames with pathspec syntax, tabs, newlines and Unicode are safe", async () => {
  for (const path of [
    "[a]*.txt",
    "tab\tname.txt",
    "line\nname.txt",
    "中文.txt",
  ])
    put(path, `${path}\n`);
  commit("odd paths");
  for (const path of [
    "[a]*.txt",
    "tab\tname.txt",
    "line\nname.txt",
    "中文.txt",
  ]) {
    const r = await history.read({ filePath: path });
    expect(r.filePath).toBe(path);
    const d = await history.show({ patchFile: path });
    expect(d.patch?.filePath).toBe(path);
    expect(gitHistoryOutputs.git_show.safeParse(d).success).toBe(true);
  }
});

test("history commands never execute external diff or textconv drivers", async () => {
  put(".gitattributes", "*.txt diff=custom\n");
  put("code.txt", "before\n");
  const base = commit("base");
  put("code.txt", "after\n");
  commit("after");
  git("config", "diff.external", "touch external-marker");
  git("config", "diff.custom.textconv", "touch textconv-marker");
  const result = await history.compare({ base });
  expect(result.patch?.text).toContain("+after");
  expect(await Bun.file(join(dir, "external-marker")).exists()).toBe(false);
  expect(await Bun.file(join(dir, "textconv-marker")).exists()).toBe(false);
});
