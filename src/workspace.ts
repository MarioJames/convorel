import {
  constants,
  realpathSync,
  statSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  opendirSync,
  existsSync,
} from "node:fs";
import { resolve, join, relative, isAbsolute, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import ignore from "ignore";
import { childEnv } from "./command.ts";
import {
  CONTENT_BUDGET,
  textPage,
  pathMatcher,
  textChunk,
} from "./evidence.ts";
import { GitHistory, selectGitPatch } from "./git-history.ts";
const MAX_FILE = 1024 * 1024;
export const MAX_OUT = 64 * 1024;
export const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
// Adapted from codex-with-chatgpt (MIT); exclusions apply to every tool, including Git.
const HARD = ignore().add([
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "*.keychain*",
  ".cloudflared/",
  "credentials.json",
  "service-account*.json",
  "secrets.json",
  "cookies.sqlite",
  "Cookies",
  ".git",
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".cache/",
  ".venv/",
  "venv/",
  "coverage/",
  "target/",
  ".convorel/",
]);
function integer(n: number, min: number, max: number) {
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("INVALID_RANGE");
  return n;
}
export class Workspace {
  readonly root: string;
  readonly id: string;
  private rootIdentity: string;
  private parent?: { workspace: Workspace; path: string };
  gitStorageCheck?: (path: string) => boolean;
  subdirectory(path: string) {
    this.checkRoot();
    const rel = this.normalize(path);
    if (!rel) return this;
    if (!this.allowed(rel, true)) throw new Error("ACCESS_DENIED");
    const child = new Workspace(join(this.root, rel));
    if (child.root !== join(this.root, rel)) throw new Error("ACCESS_DENIED");
    child.parent = { workspace: this, path: rel };
    child.gitStorageCheck = this.gitStorageCheck;
    return child;
  }
  constructor(root: string) {
    this.root = realpathSync(resolve(root));
    const st = statSync(this.root);
    if (!st.isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
    this.rootIdentity = `${st.dev}:${st.ino}`;
    this.id = sha(this.root).slice(0, 20);
  }
  checkRoot() {
    if (this.parent) {
      this.parent.workspace.checkRoot();
      if (!this.parent.workspace.allowed(this.parent.path, true))
        throw new Error("ACCESS_DENIED");
    }
    const s = statSync(this.root);
    if (
      realpathSync(this.root) !== this.root ||
      `${s.dev}:${s.ino}` !== this.rootIdentity
    )
      throw new Error("WORKSPACE_REPLACED");
  }
  normalize(p: string) {
    if (
      typeof p !== "string" ||
      !p ||
      isAbsolute(p) ||
      p.includes("\\") ||
      p.includes("\0") ||
      p.split("/").includes("..")
    )
      throw new Error("ACCESS_DENIED");
    const r = relative(this.root, resolve(this.root, p));
    if (r.startsWith("../") || isAbsolute(r)) throw new Error("ACCESS_DENIED");
    return r;
  }
  private raw(p: string, policy = false): Buffer {
    this.checkRoot();
    const rel = this.normalize(p);
    if (!rel) throw new Error("NOT_A_FILE");
    let abs = this.root;
    for (const part of rel.split("/")) {
      abs = join(abs, part);
      const s = lstatSync(abs);
      if (s.isSymbolicLink()) throw new Error("ACCESS_DENIED");
    }
    const fd = openSync(
      abs,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const s = fstatSync(fd);
      if (!s.isFile()) throw new Error("NOT_REGULAR_FILE");
      if (s.nlink > 1) throw new Error("HARDLINK_NOT_SUPPORTED");
      if (s.size > (policy ? MAX_OUT : MAX_FILE))
        throw new Error("FILE_TOO_LARGE");
      if (realpathSync(`/proc/self/fd/${fd}`) !== abs)
        throw new Error("FILE_CHANGED");
      this.checkRoot();
      const buf = Buffer.alloc((policy ? MAX_OUT : MAX_FILE) + 1);
      let n = 0;
      while (n < buf.length) {
        const count = readSync(fd, buf, n, buf.length - n, n);
        if (!count) break;
        n += count;
      }
      if (n > (policy ? MAX_OUT : MAX_FILE)) throw new Error("FILE_TOO_LARGE");
      const end = fstatSync(fd);
      if (s.ino !== end.ino || s.size !== end.size || s.mtimeMs !== end.mtimeMs)
        throw new Error("FILE_CHANGED");
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }
  private policy(file: string) {
    try {
      return this.raw(file, true).toString("utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") return "";
      throw new Error("POLICY_UNREADABLE");
    }
  }
  allowed(p: string, isDir = false) {
    try {
      const rel = this.normalize(p);
      if (
        this.parent &&
        !this.parent.workspace.allowed(join(this.parent.path, rel), isDir)
      )
        return false;
      if (!rel) return true;
      if (HARD.ignores(rel) || HARD.ignores(rel + "/")) return false;
      // Each ancestor policy is an independent deny boundary; child negations cannot undo it.
      const parts = rel.split("/");
      for (let i = 0; i < parts.length; i++) {
        const base = parts.slice(0, i).join("/"),
          sub = parts.slice(i).join("/") + (isDir ? "/" : "");
        for (const name of [".gitignore", ".convorelignore"]) {
          if (
            ignore()
              .add(this.policy(base ? base + "/" + name : name))
              .ignores(sub)
          )
            return false;
        }
      }
      let abs = this.root;
      for (const part of parts) {
        abs = join(abs, part);
        try {
          const s = lstatSync(abs);
          if (
            s.isSymbolicLink() ||
            (s.isFile() && s.nlink > 1) ||
            (!s.isDirectory() && !s.isFile())
          )
            return false;
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
          break;
        }
      }
      return true;
    } catch (e: any) {
      if (e.message === "POLICY_UNREADABLE") throw e;
      return false;
    }
  }
  async read(p: string, startLine = 1, maxLines = 400) {
    integer(startLine, 1, 10_000_000);
    integer(maxLines, 1, 1000);
    if (!this.allowed(p)) throw new Error("ACCESS_DENIED");
    const buf = this.raw(p);
    return {
      path: this.normalize(p),
      ...textPage(buf, startLine, maxLines),
      sha256: sha(buf),
      hashScope: "whole-file",
      sizeBytes: buf.length,
      observedAt: new Date().toISOString(),
      workspaceId: this.id,
    };
  }
  private inventory(p = ".", depth = 4) {
    this.checkRoot();
    const rel = this.normalize(p);
    if (!this.allowed(p, true)) throw new Error("ACCESS_DENIED");
    const entries: { path: string; type: "file" | "directory" }[] = [];
    let scanned = 0,
      truncated = false,
      depthLimited = false;
    const start = Date.now();
    const walk = (base: string, level: number) => {
      const dir = opendirSync(join(this.root, base));
      try {
        let e;
        while ((e = dir.readSync())) {
          if (++scanned > 10000 || Date.now() - start > 3000) {
            truncated = true;
            return;
          }
          const path = base ? base + "/" + e.name : e.name;
          if (
            e.isSymbolicLink() ||
            (!e.isFile() && !e.isDirectory()) ||
            !this.allowed(path, e.isDirectory())
          )
            continue;
          entries.push({ path, type: e.isDirectory() ? "directory" : "file" });
          if (e.isDirectory()) {
            if (level < depth) walk(path, level + 1);
            else depthLimited = true;
          }
          if (truncated) return;
        }
      } finally {
        dir.closeSync();
      }
    };
    walk(rel, 1);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { entries, scanned, truncated, depthLimited };
  }
  async list(p = ".", depth = 1, offset = 0, limit = 200) {
    integer(depth, 1, 4);
    integer(offset, 0, 10000);
    integer(limit, 1, 500);
    const all = this.inventory(p, depth);
    const entries = all.entries.slice(offset, offset + limit);
    while (Buffer.byteLength(JSON.stringify(entries)) > MAX_OUT) entries.pop();
    return {
      path: this.normalize(p) || ".",
      entries,
      nextOffset:
        offset + entries.length < all.entries.length
          ? offset + entries.length
          : null,
      truncated: all.truncated || offset + entries.length < all.entries.length,
      depthLimited: all.depthLimited,
      scanTruncated: all.truncated,
    };
  }
  async find(pattern = "*", depth = 12, offset = 0, limit = 200) {
    integer(depth, 1, 32);
    integer(offset, 0, 10000);
    integer(limit, 1, 500);
    const match = pathMatcher(pattern),
      inv = this.inventory(".", depth);
    const files = inv.entries.filter((f) => f.type === "file" && match(f.path));
    const entries = files.slice(offset, offset + limit);
    while (Buffer.byteLength(JSON.stringify(entries)) > CONTENT_BUDGET)
      entries.pop();
    return {
      pattern,
      entries,
      offset,
      limit,
      depth,
      nextOffset:
        offset + entries.length < files.length ? offset + entries.length : null,
      truncated:
        inv.truncated ||
        inv.depthLimited ||
        offset + entries.length < files.length,
      scanTruncated: inv.truncated,
      depthLimited: inv.depthLimited,
      scannedEntries: inv.scanned,
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
      note: "Live, sorted relative paths. Pagination covers only the scanned inventory; narrow path or increase depth if scan/depth limited. Patterns without '/' match basenames.",
    };
  }
  async image(p: string) {
    if (!this.allowed(p)) throw new Error("ACCESS_DENIED");
    const buf = this.raw(p);
    const mimeType = buf
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : buf[0] === 255 && buf[1] === 216 && buf[2] === 255
        ? "image/jpeg"
        : buf.toString("ascii", 0, 4) === "RIFF" &&
            buf.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
    if (!mimeType) throw new Error("UNSUPPORTED_IMAGE");
    return {
      path: this.normalize(p),
      mimeType,
      sizeBytes: buf.length,
      sha256: sha(buf),
      hashScope: "whole-file" as const,
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
      imageData: buf.toString("base64"),
      note: "Image bytes observed at this path, not proof of when or against which revision the screenshot was produced. Maximum image size: 1 MiB.",
    };
  }
  async search(
    query: string,
    options: {
      pattern?: string;
      depth?: number;
      offset?: number;
      limit?: number;
      contextLines?: number;
    } = {},
  ) {
    if (
      !query ||
      query.length > 200 ||
      query.includes("\n") ||
      query.includes("\0")
    )
      throw new Error("INVALID_QUERY");
    const {
      pattern = "*",
      depth = 12,
      offset = 0,
      limit = 50,
      contextLines = 2,
    } = options;
    integer(depth, 1, 32);
    integer(offset, 0, 1_000_000);
    integer(limit, 1, 50);
    integer(contextLines, 0, 5);
    const match = pathMatcher(pattern),
      start = Date.now(),
      inv = this.inventory(".", depth);
    const matches: {
      path: string;
      line: number;
      text: string;
      sha256: string;
      contextBefore: string[];
      contextAfter: string[];
      textTruncated: boolean;
    }[] = [];
    let scannedBytes = 0,
      skippedFiles = 0,
      skippedMatches = 0,
      pageMore = false,
      scanTruncated = inv.truncated,
      outputBytes = 0;
    scan: for (const f of inv.entries) {
      if (f.type !== "file" || !match(f.path)) continue;
      if (scannedBytes >= 16 * MAX_FILE || Date.now() - start > 5000) {
        scanTruncated = true;
        break;
      }
      let buf: Buffer, text: string;
      try {
        buf = this.raw(f.path);
        scannedBytes += buf.length;
        if (buf.includes(0)) throw new Error("BINARY_FILE");
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buf);
      } catch {
        skippedFiles++;
        continue;
      }
      const hash = sha(buf),
        lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!,
          at = line.indexOf(query);
        if (at < 0) continue;
        if (skippedMatches++ < offset) continue;
        if (matches.length === limit) {
          pageMore = true;
          break scan;
        }
        const begin = Math.max(0, at - 500),
          snippet = line.slice(begin, begin + 2000);
        const before = lines.slice(Math.max(0, i - contextLines), i),
          after = lines.slice(i + 1, i + 1 + contextLines);
        const entry = {
          path: f.path,
          line: i + 1,
          text: snippet,
          sha256: hash,
          contextBefore: before.map((x) => x.slice(0, 1000)),
          contextAfter: after.map((x) => x.slice(0, 1000)),
          textTruncated:
            begin > 0 ||
            begin + snippet.length < line.length ||
            [...before, ...after].some((x) => x.length > 1000),
        };
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (outputBytes + bytes > CONTENT_BUDGET) {
          if (!matches.length) throw new Error("SEARCH_ENTRY_TOO_LARGE");
          pageMore = true;
          break scan;
        }
        matches.push(entry);
        outputBytes += bytes;
      }
    }
    return {
      query,
      pattern,
      depth,
      offset,
      limit,
      contextLines,
      matches,
      nextOffset: pageMore ? offset + matches.length : null,
      truncated: pageMore || scanTruncated || inv.depthLimited,
      scanTruncated,
      depthLimited: inv.depthLimited,
      skippedFiles,
      scannedBytes,
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
      note: "Literal, case-sensitive search of live UTF-8 files, one result per matching line. nextOffset continues matches within the scanned range; scan/depth limits require a narrower path or greater depth. skippedFiles are not searched. textTruncated excerpts can be read with read_file; hashes detect changes between calls.",
    };
  }
  history() {
    return new GitHistory({
      root: this.root,
      id: this.id,
      normalize: (path) => this.normalize(path),
      allowed: (path, isDir) => this.allowed(path, isDir),
      ready: () => this.gitReady(),
      git: (args) => this.gitBytes(args),
    });
  }
  private git(args: string[], acceptMissing = false) {
    return this.gitBytes(args, acceptMissing).toString("utf8");
  }
  private gitBytes(args: string[], acceptMissing = false) {
    this.checkRoot();
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
        this.root,
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
      this.gitStorageCheck ||
      ((path: string) => {
        const rel = relative(this.root, path);
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
    if (this.git(["rev-parse", "--show-toplevel"]).trim() !== this.root)
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
      workspaceId: this.id,
      name: basename(this.root),
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
      if (!this.allowed(path)) {
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
      workspaceId: this.id,
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
        paths.some((p) => !p || !this.allowed(p)) ||
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
      patchFile === undefined ? files[0]?.path : this.normalize(patchFile);
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
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
      note: "Live Git observation; files are paginated and diff is a fragment for patchFile (defaults to the first file on this page). Follow nextOffset for files and nextPatchOffset for that patch; offsets are UTF-16 code units. Recheck patchSha256 on continuation. Untracked contents are excluded. A clean worktree says nothing about recent commits; use git_log/git_show. Not an immutable snapshot.",
    };
  }
}
