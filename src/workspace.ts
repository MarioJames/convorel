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
const MAX_FILE = 1024 * 1024,
  MAX_OUT = 64 * 1024;
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
          if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
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
    if (buf.includes(0)) throw new Error("BINARY_FILE");
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const out: string[] = [];
    let bytes = 0;
    for (const line of lines.slice(startLine - 1, startLine - 1 + maxLines)) {
      if (bytes + Buffer.byteLength(line) + 1 > MAX_OUT) {
        if (!out.length) throw new Error("LINE_TOO_LONG");
        break;
      }
      out.push(line);
      bytes += Buffer.byteLength(line) + 1;
    }
    const endLine = startLine + out.length - 1,
      truncated = endLine < lines.length;
    return {
      path: this.normalize(p),
      content: out.join("\n"),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated,
      nextStartLine: truncated ? endLine + 1 : null,
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
    };
  }
  async search(query: string) {
    if (!query || query.length > 200) throw new Error("INVALID_QUERY");
    const start = Date.now(),
      inv = this.inventory(".", 12);
    const matches: {
      path: string;
      line: number;
      text: string;
      sha256: string;
    }[] = [];
    let scannedBytes = 0,
      skippedFiles = 0,
      truncated = inv.truncated || inv.depthLimited;
    for (const f of inv.entries) {
      if (f.type !== "file") continue;
      if (
        scannedBytes >= 16 * MAX_FILE ||
        Date.now() - start > 5000 ||
        matches.length >= 50
      ) {
        truncated = true;
        break;
      }
      let buf: Buffer;
      try {
        buf = this.raw(f.path);
      } catch {
        skippedFiles++;
        continue;
      }
      scannedBytes += buf.length;
      if (buf.includes(0)) {
        skippedFiles++;
        continue;
      }
      const hash = sha(buf);
      let line = 0;
      for (const text of buf.toString("utf8").split("\n")) {
        line++;
        if (text.includes(query)) {
          matches.push({
            path: f.path,
            line,
            text: text.slice(0, 1000),
            sha256: hash,
          });
          if (matches.length >= 50) {
            truncated = true;
            break;
          }
        }
      }
    }
    while (Buffer.byteLength(JSON.stringify(matches)) > MAX_OUT) {
      matches.pop();
      truncated = true;
    }
    return {
      matches,
      truncated,
      skippedFiles,
      scannedBytes,
      workspaceId: this.id,
    };
  }
  private git(args: string[], acceptMissing = false) {
    this.checkRoot();
    const r = spawnSync(
      "git",
      [
        "--no-pager",
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
        encoding: "utf8",
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
      if (acceptMissing && r.status === 1) return "";
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
    let gitHead: string | null = null;
    try {
      this.gitReady();
      gitHead = this.head();
    } catch {}
    return {
      workspaceId: this.id,
      name: basename(this.root),
      gitHead,
      mode: "live-read-only",
      observedAt: new Date().toISOString(),
      limits: { maxFileBytes: MAX_FILE, maxResponseContentBytes: MAX_OUT },
      policy:
        "No symlinks, hardlinks, special files, credentials or ignored files. All authorized connector clients share this root.",
    };
  }
  async status() {
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
    const selected = entries.slice(0, 500);
    while (Buffer.byteLength(JSON.stringify(selected)) > MAX_OUT)
      selected.pop();
    return {
      head: this.head(),
      entries: selected,
      hidden,
      truncated: entries.length > selected.length,
      dirty: !!raw,
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
    };
  }
  async diff(mode: "unstaged" | "staged" | "head" = "unstaged") {
    if (!["unstaged", "staged", "head"].includes(mode))
      throw new Error("INVALID_DIFF_MODE");
    this.gitReady();
    const extra =
      mode === "staged" ? ["--cached"] : mode === "head" ? ["HEAD"] : [];
    const flags = [
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
    const groups: string[][] = [];
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
      groups.push(paths);
    }
    let diff = "",
      truncated = false;
    const start = Date.now();
    for (const paths of groups) {
      if (Date.now() - start > 8000) {
        truncated = true;
        break;
      }
      const patch = this.git([
        "diff",
        "--no-color",
        ...flags,
        ...extra,
        "--",
        ...paths,
      ]);
      if (Buffer.byteLength(diff) + Buffer.byteLength(patch) > MAX_OUT) {
        truncated = true;
        break;
      }
      diff += patch;
    }
    return {
      mode,
      diff,
      hidden,
      truncated,
      sha256: sha(diff),
      hashScope: "returned-diff",
      head: this.head(),
      workspaceId: this.id,
      observedAt: new Date().toISOString(),
      note: "Live Git observation; untracked file contents are not included. Not an immutable worktree snapshot.",
    };
  }
}
