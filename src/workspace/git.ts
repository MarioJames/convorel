import { realpathSync, existsSync } from "node:fs";
import { relative, isAbsolute, join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { childEnv } from "../process.ts";
import { sha } from "../hash.ts";
import { CONTENT_BUDGET, textChunk } from "./evidence.ts";
import { GitHistory } from "./git-history.ts";
import { selectGitPatch } from "./git-patch.ts";
import { MAX_FILE, MAX_OUT, integer } from "./limits.ts";

export interface GitWorkspaceAccess {
  root: string;
  id: string;
  checkRoot(): void;
  normalize(path: string): string;
  allowed(path: string, isDir?: boolean): boolean;
  gitStorageCheck?: (path: string) => boolean;
}

/** Git reads share the workspace's live identity and path policy. */
export class WorkspaceGit {
  constructor(private readonly access: GitWorkspaceAccess) {}
  history() {
    return new GitHistory({
      root: this.access.root,
      id: this.access.id,
      normalize: (path) => this.access.normalize(path),
      allowed: (path, isDir) => this.access.allowed(path, isDir),
      ready: () => this.gitReady(),
      git: (args) => this.gitBytes(args),
    });
  }
  private git(args: string[], acceptMissing = false) {
    return this.gitBytes(args, acceptMissing).toString("utf8");
  }
  private gitBytes(args: string[], acceptMissing = false) {
    this.access.checkRoot();
    const r = spawnSync(
      "git",
      [
        "--no-pager",
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-lazy-fetch",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-C",
        this.access.root,
        ...args,
      ],
      {
        timeout: 8000,
        maxBuffer: 4 * MAX_FILE,
        env: {
          ...childEnv(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    if (r.error) throw new Error("GIT_LIMIT_OR_PROCESS_ERROR");
    if (r.status !== 0) {
      if (acceptMissing && r.status === 1) return Buffer.alloc(0);
      throw new Error("GIT_FAILED");
    }
    return r.stdout;
  }
  private gitReady() {
    // Resolve Git's real data sources before any status/diff can return content.
    const gitDir = this.git(["rev-parse", "--absolute-git-dir"]).trim();
    const common = this.git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim();
    const storageAllowed =
      this.access.gitStorageCheck ||
      ((path: string) => {
        const rel = relative(this.access.root, path);
        return (
          (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel))) &&
          realpathSync(path) === path
        );
      });
    for (const path of [gitDir, common, join(common, "objects")]) {
      if (!storageAllowed(path)) throw new Error("GIT_STORAGE_OUTSIDE_ROOTS");
    }
    // Object alternates are recursively extensible; unsupported rather than followed implicitly.
    for (const name of ["alternates", "http-alternates"]) {
      if (existsSync(join(common, "objects/info", name)))
        throw new Error("GIT_ALTERNATES_UNSUPPORTED");
    }
    if (this.git(["rev-parse", "--show-toplevel"]).trim() !== this.access.root)
      throw new Error("GIT_ROOT_REQUIRED");
    if (
      this.git(
        ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
        true,
      )
    )
      throw new Error("GIT_FILTER_UNSUPPORTED");
  }
  private head() {
    try {
      return this.git(["rev-parse", "--verify", "HEAD"]).trim();
    } catch {
      return null;
    }
  }
  async info() {
    let gitHead: string | null = null,
      gitBranch: string | null = null,
      gitError: string | null = null;
    try {
      this.gitReady();
      gitHead = this.head();
      gitBranch =
        this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], true).trim() ||
        null;
    } catch (e: any) {
      gitError = /^[A-Z_]+$/.test(e.message) ? e.message : "GIT_UNAVAILABLE";
    }
    return {
      workspaceId: this.access.id,
      name: basename(this.access.root),
      gitHead,
      gitBranch,
      gitError,
      mode: "live-read-only",
      observedAt: new Date().toISOString(),
      limits: { maxFileBytes: MAX_FILE, maxResponseContentBytes: MAX_OUT },
      policy:
        "No symlinks, hardlinks, special files, credentials or ignored files. All authorized connector clients share this root.",
    };
  }
  async status(offset = 0, limit = 200) {
    integer(offset, 0, 1000000);
    integer(limit, 1, 500);
    this.gitReady();
    const raw = this.git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=all",
      "--",
      ".",
    ]);
    const entries: { path: string; change: string }[] = [];
    let hidden = 0;
    for (const row of raw.split("\0").filter(Boolean)) {
      const path = row.slice(3);
      if (!this.access.allowed(path)) {
        hidden++;
        continue;
      }
      entries.push({ path, change: row.slice(0, 2) });
    }
    const selected = entries.slice(offset, offset + limit);
    while (Buffer.byteLength(JSON.stringify(selected)) > CONTENT_BUDGET)
      selected.pop();
    return {
      head: this.head(),
      entries: selected,
      hidden,
      truncated: offset + selected.length < entries.length,
      offset,
      limit,
      nextOffset:
        offset + selected.length < entries.length
          ? offset + selected.length
          : null,
      dirty: !!raw,
      workspaceId: this.access.id,
      observedAt: new Date().toISOString(),
    };
  }
  async diff(
    mode: "unstaged" | "staged" | "head" = "unstaged",
    options: {
      offset?: number;
      limit?: number;
      patchFile?: string;
      patchOffset?: number;
    } = {},
  ) {
    const { offset = 0, limit = 100, patchFile, patchOffset = 0 } = options;
    integer(offset, 0, 1000000);
    integer(limit, 1, 500);
    integer(patchOffset, 0, 10_000_000);
    if (!["unstaged", "staged", "head"].includes(mode))
      throw new Error("INVALID_DIFF_MODE");
    this.gitReady();
    const extra =
      mode === "staged" ? ["--cached"] : mode === "head" ? ["HEAD"] : [];
    const flags = [
      "--no-relative",
      "--output-indicator-new=+",
      "--output-indicator-old=-",
      "--output-indicator-context= ",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--find-renames=1%",
    ];
    const tokens = this.git([
      "diff",
      "--raw",
      "-z",
      "--no-abbrev",
      ...flags,
      ...extra,
      "--",
      ".",
    ]).split("\0");
    const groups: {
      paths: string[];
      change: string;
      oldOid: string;
      newOid: string;
    }[] = [];
    let hidden = 0;
    for (let i = 0; i < tokens.length && tokens[i]; ) {
      const meta = tokens[i++].split(" "),
        path = tokens[i++];
      const paths = /^[RC]/.test(meta[4]) ? [path, tokens[i++]] : [path];
      if (
        paths.some((p) => !p || !this.access.allowed(p)) ||
        meta.slice(0, 2).some((m) => !/^:?(100\d{3}|000000)$/.test(m))
      ) {
        hidden++;
        continue;
      }
      groups.push({
        paths,
        change: meta[4]!,
        oldOid: meta[2]!,
        newOid: meta[3]!,
      });
    }
    const files = groups.slice(offset, offset + limit).map((g) => ({
      path: g.paths.at(-1)!,
      previousPath: g.paths.length === 2 ? g.paths[0]! : null,
      change: g.change,
    }));
    while (Buffer.byteLength(JSON.stringify(files)) > 16 * 1024) files.pop();
    const requested =
      patchFile === undefined
        ? files[0]?.path
        : this.access.normalize(patchFile);
    const group = groups.find((g) => g.paths.at(-1) === requested);
    if (patchFile !== undefined && !group)
      throw new Error("DIFF_FILE_UNAVAILABLE");
    const patch = group
      ? selectGitPatch(
          this.gitBytes([
            "diff",
            "--raw",
            "-z",
            "-p",
            "--no-abbrev",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            ...flags,
            ...extra,
            "--",
            ...group.paths,
          ]),
          {
            path: group.paths.at(-1)!,
            oldPath: group.paths.length === 2 ? group.paths[0]! : null,
            oldOid: group.oldOid,
            newOid: group.newOid,
            status: group.change[0]!,
          },
        ).toString("utf8")
      : "";
    const chunk = textChunk(patch, patchOffset, 32 * 1024),
      diff = chunk.text;
    const nextOffset =
      offset + files.length < groups.length ? offset + files.length : null;
    const truncated = nextOffset !== null || chunk.nextOffset !== null;
    return {
      mode,
      files,
      offset,
      limit,
      nextOffset,
      patchFile: group?.paths.at(-1) || null,
      patchOffset,
      nextPatchOffset: chunk.nextOffset,
      totalPatchLength: patch.length,
      patchSha256: sha(patch),
      diff,
      hidden,
      truncated,
      sha256: sha(diff),
      hashScope: "returned-diff",
      head: this.head(),
      workspaceId: this.access.id,
      observedAt: new Date().toISOString(),
      note: "Live Git observation; files are paginated and diff is a fragment for patchFile (defaults to the first file on this page). Follow nextOffset for files and nextPatchOffset for that patch; offsets are UTF-16 code units. Recheck patchSha256 on continuation. Untracked contents are excluded. A clean worktree says nothing about recent commits; use git_log/git_show. Not an immutable snapshot.",
    };
  }
}
