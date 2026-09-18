import { createHash } from "node:crypto";
import ignore from "ignore";
import { textChunk } from "./evidence.ts";
import {
  gitHistoryInputs,
  type GitLogOptions,
  type GitShowOptions,
  type GitCompareOptions,
  type GitReadOptions,
  type GitCommit,
  type GitHistoryFile,
} from "./git-history-schemas.ts";

export type HistoryAccess = {
  root: string;
  id: string;
  normalize: (path: string) => string;
  allowed: (path: string, isDir?: boolean) => boolean;
  ready: () => void;
  git: (args: string[]) => Buffer;
};
const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 56 * 1024;
const TEXT_BUDGET = 20 * 1024;
const INVENTORY_LIMIT = 10000;
const TREE_LIMIT = 20000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const decode = (b: Buffer) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new Error("GIT_INVALID_UTF8");
  }
};
const textBlob = (b: Buffer) => {
  if (b.includes(0)) throw new Error("BINARY_FILE");
  const s = decode(b);
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s))
    throw new Error("BINARY_FILE");
  return s;
};
const finish = <T>(value: T): T => {
  if (bytes(value) > MAX_OUTPUT) throw new Error("GIT_HISTORY_RESPONSE_LIMIT");
  return value;
};
type Entry = { mode: string; oid: string; size: number };
type Change = GitHistoryFile & { oldOid: string; newOid: string };
type Page = {
  offset: number;
  limit: number;
  patchFile?: string;
  patchOffset: number;
};

export function selectGitPatch(
  combined: Buffer,
  selected: {
    path: string;
    oldPath: string | null;
    oldOid: string;
    newOid: string;
    status: string;
  },
): Buffer {
  // Literal pathspecs still expand a former file into a new directory. Pair
  // the NUL-delimited raw inventory with patch blocks and return only the
  // exact approved change, never its potentially forbidden descendants.
  const separator = combined.indexOf(Buffer.from([0, 0]));
  if (separator < 0) throw new Error("GIT_INVALID_PATCH");
  const rawRows = decode(combined.subarray(0, separator)).split("\0");
  let selectedIndex = -1,
    rowCount = 0;
  for (let i = 0; i < rawRows.length; ) {
    const meta = rawRows[i++].match(
      /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$/,
    );
    if (!meta) throw new Error("GIT_INVALID_PATCH");
    const first = rawRows[i++],
      renamed = meta[5] === "R" || meta[5] === "C",
      path = renamed ? rawRows[i++] : first;
    if (!path) throw new Error("GIT_INVALID_PATCH");
    if (
      path === selected.path &&
      (renamed ? first : null) === selected.oldPath &&
      meta[3] === selected.oldOid &&
      meta[4] === selected.newOid &&
      meta[5] === selected.status
    )
      selectedIndex = rowCount;
    rowCount++;
  }
  const patches = combined.subarray(separator + 2),
    starts = [0];
  if (!patches.subarray(0, 11).equals(Buffer.from("diff --git ")))
    throw new Error("GIT_INVALID_PATCH");
  for (let p = 0; (p = patches.indexOf("\ndiff --git ", p)) !== -1; p++)
    starts.push(p + 1);
  if (selectedIndex < 0 || starts.length !== rowCount)
    throw new Error("GIT_PATCH_SELECTION_CHANGED");
  return patches.subarray(
    starts[selectedIndex],
    starts[selectedIndex + 1] ?? patches.length,
  );
}

// All caches and budgets belong to one observation, never to the workspace lifetime.
class Observation {
  private started = Date.now();
  private commands = 0;
  private policyBytes = 0;
  private trees = new Map<string, Map<string, Entry>>();
  private policies = new Map<string, ReturnType<typeof ignore>>();
  private emptyPolicy = ignore();
  constructor(private access: HistoryAccess) {}
  private checkBudget() {
    if (Date.now() - this.started > 8000)
      throw new Error("GIT_HISTORY_SCAN_LIMIT");
  }
  git(args: string[]) {
    this.checkBudget();
    if (++this.commands > 512) throw new Error("GIT_HISTORY_SCAN_LIMIT");
    const result = this.access.git(args);
    if (Date.now() - this.started > 8000)
      throw new Error("GIT_HISTORY_SCAN_LIMIT");
    return result;
  }
  resolve(ref: string) {
    const value = decode(
      this.git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ]),
    ).trim();
    if (!SHA.test(value)) throw new Error("GIT_INVALID_REVISION");
    return value;
  }
  meta() {
    const shallow = decode(
      this.git(["rev-parse", "--is-shallow-repository"]),
    ).trim();
    if (shallow !== "true" && shallow !== "false")
      throw new Error("GIT_INVALID_OUTPUT");
    return {
      workspaceId: this.access.id,
      observedAt: new Date().toISOString(),
      shallow: shallow === "true",
    };
  }
  commit(sha: string): GitCommit {
    const raw = this.git(["cat-file", "commit", sha]);
    if (raw.length > MAX_FILE) throw new Error("GIT_COMMIT_TOO_LARGE");
    const s = decode(raw),
      split = s.indexOf("\n\n");
    if (split < 0) throw new Error("GIT_INVALID_COMMIT");
    const headers = s.slice(0, split).split("\n");
    const parents = headers
      .filter((l) => l.startsWith("parent "))
      .map((l) => l.slice(7));
    if (parents.length > 100 || parents.some((p) => !SHA.test(p)))
      throw new Error("GIT_INVALID_COMMIT");
    const identity = (kind: string) => {
      const line = headers.find((l) => l.startsWith(`${kind} `));
      const match = line?.match(/^[a-z]+ (.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/);
      if (!match) throw new Error("GIT_INVALID_COMMIT");
      const time = new Date(Number(match[3]) * 1000);
      if (!Number.isFinite(time.getTime()))
        throw new Error("GIT_INVALID_COMMIT");
      return { name: match[1], email: match[2], at: time.toISOString() };
    };
    const author = identity("author"),
      committer = identity("committer");
    const result = {
      sha,
      parents,
      author: { name: author.name, email: author.email },
      authoredAt: author.at,
      committedAt: committer.at,
      subject: s.slice(split + 2).split("\n", 1)[0],
    };
    if (bytes(result) > 8192) throw new Error("GIT_COMMIT_METADATA_LIMIT");
    return result;
  }
  message(sha: string) {
    const raw = this.git(["cat-file", "commit", sha]);
    if (raw.length > MAX_FILE) throw new Error("GIT_COMMIT_TOO_LARGE");
    const boundary = raw.indexOf("\n\n");
    if (boundary < 0) throw new Error("GIT_INVALID_COMMIT");
    const body = raw.subarray(boundary + 2);
    return { text: decode(body), sha256: hash(body) };
  }
  tree(sha: string) {
    const cached = this.trees.get(sha);
    if (cached) return cached;
    const tokens = decode(
      this.git(["ls-tree", "-r", "-z", "-l", "--full-tree", sha]),
    ).split("\0");
    if (tokens.length > TREE_LIMIT + 1)
      throw new Error("GIT_HISTORY_TREE_LIMIT");
    const tree = new Map<string, Entry>();
    for (const token of tokens) {
      if (!token) continue;
      const match = token.match(
        /^(\d{6}) (blob|commit) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/,
      );
      if (!match || !SHA.test(match[3])) throw new Error("GIT_INVALID_TREE");
      const path = match[5];
      if (this.access.normalize(path) !== path)
        throw new Error("GIT_INVALID_PATH");
      tree.set(path, {
        mode: match[1],
        oid: match[3],
        size: match[4] === "-" ? -1 : Number(match[4]),
      });
    }
    this.trees.set(sha, tree);
    return tree;
  }
  private policy(sha: string, path: string) {
    const key = `${sha}:${path}`;
    const cached = this.policies.get(key);
    if (cached) return cached;
    const entry = this.tree(sha).get(path);
    if (!entry) return this.emptyPolicy;
    if (this.policies.size >= 128) throw new Error("GIT_HISTORY_POLICY_LIMIT");
    let content = "";
    if (entry) {
      if (
        !/^100(644|755)$/.test(entry.mode) ||
        entry.size < 0 ||
        entry.size > 65536
      )
        throw new Error("POLICY_UNREADABLE");
      try {
        const blob = this.git(["cat-file", "blob", entry.oid]);
        if (
          blob.length !== entry.size ||
          (this.policyBytes += blob.length) > MAX_FILE
        )
          throw new Error("POLICY_UNREADABLE");
        content = textBlob(blob);
      } catch {
        throw new Error("POLICY_UNREADABLE");
      }
    }
    const policy = ignore().add(content);
    this.policies.set(key, policy);
    return policy;
  }
  allowed(path: string, snapshots: string[]) {
    this.checkBudget();
    if (
      !path ||
      this.access.normalize(path) !== path ||
      !this.access.allowed(path)
    )
      return false;
    const parts = path.split("/");
    if (parts.length > 32) throw new Error("GIT_HISTORY_PATH_DEPTH_LIMIT");
    for (const sha of snapshots) {
      const tree = this.tree(sha);
      for (let i = 0; i < parts.length; i++) {
        const base = parts.slice(0, i).join("/");
        // A historical ancestor that is a symlink/gitlink is never traversed.
        if (base && /^(120000|160000)$/.test(tree.get(base)?.mode ?? ""))
          return false;
        const sub = parts.slice(i).join("/");
        for (const policy of [".gitignore", ".convorelignore"]) {
          if (
            this.policy(sha, base ? `${base}/${policy}` : policy).ignores(sub)
          )
            return false;
        }
      }
    }
    return true;
  }
  blob(entry: Entry) {
    if (!/^100(644|755)$/.test(entry.mode))
      throw new Error("GIT_NOT_REGULAR_FILE");
    if (entry.size < 0 || entry.size > MAX_FILE)
      throw new Error("FILE_TOO_LARGE");
    const blob = this.git(["cat-file", "blob", entry.oid]);
    if (blob.length !== entry.size) throw new Error("GIT_INVALID_BLOB");
    return { raw: blob, text: textBlob(blob) };
  }
  private diffArgs(base: string | null, head: string, format: string[]) {
    return [
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-relative",
      "--no-abbrev",
      "--find-renames=1%",
      "-l10000",
      "--diff-algorithm=myers",
      "--ignore-submodules=all",
      "--output-indicator-new=+",
      "--output-indicator-old=-",
      "--output-indicator-context= ",
      ...format,
      ...(base ? [base, head] : ["--root", head]),
    ];
  }
  changes(base: string | null, head: string, snapshots: string[]) {
    const raw = decode(
      this.git([...this.diffArgs(base, head, ["--raw", "-z"]), "--"]),
    ).split("\0");
    const all: Change[] = [];
    const modes = new Map<string, string[]>();
    for (let i = 0; i < raw.length && raw[i]; ) {
      const meta = raw[i++].match(
        /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$/,
      );
      if (!meta) throw new Error("GIT_INVALID_DIFF");
      const first = raw[i++],
        renamed = meta[5] === "R" || meta[5] === "C",
        path = renamed ? raw[i++] : first;
      if (!path || !first || !SHA.test(meta[3]) || !SHA.test(meta[4]))
        throw new Error("GIT_INVALID_DIFF");
      if (all.length >= INVENTORY_LIMIT)
        throw new Error("GIT_HISTORY_DIFF_LIMIT");
      modes.set(path, [meta[1], meta[2]]);
      all.push({
        path,
        oldPath: renamed ? first : null,
        status: meta[5] as GitHistoryFile["status"],
        additions: 0,
        deletions: 0,
        oldOid: meta[3],
        newOid: meta[4],
      });
    }
    // Pair bounded, NUL-delimited numstat rows with raw entries; no pathname splitting on tabs.
    const nums = decode(
      this.git([...this.diffArgs(base, head, ["--numstat", "-z"]), "--"]),
    ).split("\0");
    const stats = new Map<
      string,
      { add: number; del: number; binary: boolean; oldPath: string | null }
    >();
    for (let i = 0; i < nums.length && nums[i]; ) {
      const match = nums[i++].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
      if (!match) throw new Error("GIT_INVALID_DIFF");
      const renamed = match[3] === "",
        oldPath = renamed ? nums[i++] : null,
        path = renamed ? nums[i++] : match[3];
      if (!path) throw new Error("GIT_INVALID_DIFF");
      stats.set(path, {
        add: Number(match[1]),
        del: Number(match[2]),
        binary: match[1] === "-" || match[2] === "-",
        oldPath,
      });
    }
    let hiddenFiles = 0;
    const visible: Change[] = [];
    for (const change of all) {
      this.checkBudget();
      const stat = stats.get(change.path);
      if (!stat || stat.oldPath !== change.oldPath)
        throw new Error("GIT_INVALID_DIFF");
      const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
      const unsafeMode = modes
        .get(change.path)!
        .some((m) => !/^(?:000000|100644|100755)$/.test(m));
      const oversized = snapshots.some((sha) =>
        paths.some((p) => (this.tree(sha).get(p)?.size ?? 0) > MAX_FILE),
      );
      if (
        unsafeMode ||
        oversized ||
        stat.binary ||
        paths.some((p) => !this.allowed(p, snapshots))
      ) {
        hiddenFiles++;
        continue;
      }
      visible.push({ ...change, additions: stat.add, deletions: stat.del });
    }
    return { visible, hiddenFiles };
  }
  comparison(
    base: string | null,
    head: string,
    effectiveBase: string | null,
    mode: "direct" | "merge-base",
    mergeBases: string[],
    page: Page,
  ) {
    const snapshots = [
      ...new Set([base, head, effectiveBase].filter((s): s is string => !!s)),
    ];
    const { visible, hiddenFiles } = this.changes(
      effectiveBase,
      head,
      snapshots,
    );
    const files: GitHistoryFile[] = [];
    for (const item of visible.slice(page.offset, page.offset + page.limit)) {
      const { oldOid: _old, newOid: _new, ...file } = item;
      if (bytes([...files, file]) > TEXT_BUDGET) break;
      files.push(file);
    }
    if (!files.length && page.offset < visible.length)
      throw new Error("GIT_HISTORY_RESPONSE_LIMIT");
    const nextOffset =
      page.offset + files.length < visible.length
        ? page.offset + files.length
        : null;
    let patch = null;
    const selected = page.patchFile
      ? visible.find((f) => f.path === this.access.normalize(page.patchFile!))
      : visible[page.offset];
    if (page.patchFile && !selected) throw new Error("ACCESS_DENIED");
    if (selected) {
      const paths = [
        selected.path,
        ...(selected.oldPath ? [selected.oldPath] : []),
      ];
      for (const [sha, path] of [
        [effectiveBase, selected.oldPath ?? selected.path],
        [head, selected.path],
      ] as const) {
        if (!sha) continue;
        const entry = this.tree(sha).get(path);
        if (entry) this.blob(entry); // Refuse invalid/binary bytes even if attributes claim text.
      }
      const combined = this.git([
        ...this.diffArgs(effectiveBase, head, [
          "--raw",
          "-z",
          "-p",
          "--full-index",
          "--unified=3",
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ]),
        "--",
        ...paths,
      ]);
      const raw = selectGitPatch(combined, selected);
      const full = decode(raw);
      if (
        page.patchOffset > full.length ||
        (page.patchOffset > 0 &&
          page.patchOffset < full.length &&
          /[\uDC00-\uDFFF]/.test(full[page.patchOffset]))
      )
        throw new Error("INVALID_PATCH_OFFSET");
      let low = page.patchOffset,
        high = full.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (bytes(full.slice(page.patchOffset, middle)) <= TEXT_BUDGET)
          low = middle;
        else high = middle - 1;
      }
      if (low < full.length && /[\uDC00-\uDFFF]/.test(full[low])) low--;
      if (low === page.patchOffset && low < full.length)
        throw new Error("GIT_HISTORY_RESPONSE_LIMIT");
      patch = {
        filePath: selected.path,
        text: full.slice(page.patchOffset, low),
        offset: page.patchOffset,
        nextOffset: low < full.length ? low : null,
        totalLength: full.length,
        sha256: hash(raw),
        hashScope: "whole-patch" as const,
      };
    } else if (page.patchOffset) throw new Error("INVALID_PATCH_OFFSET");
    return {
      ...this.meta(),
      base,
      head,
      effectiveBase,
      mode,
      mergeBases,
      files,
      offset: page.offset,
      nextOffset,
      truncated: nextOffset !== null || patch?.nextOffset != null,
      summary: {
        visibleFiles: visible.length,
        hiddenFiles,
        additions: visible.reduce((n, f) => n + f.additions, 0),
        deletions: visible.reduce((n, f) => n + f.deletions, 0),
      },
      patch,
      note: "Immutable commit comparison; statistics cover visible regular text files only. Current and historical ignore policies apply to both rename names. Binary, non-regular and oversized files are hidden. Pin SHAs and policy state when paginating; no claim of linear ancestry. Patch fragments may split lines; offsets count UTF-16 code units.",
    };
  }
}

export class GitHistory {
  constructor(private access: HistoryAccess) {}
  async log(options: GitLogOptions = {}) {
    this.access.ready();
    const input = gitHistoryInputs.git_log.parse(options),
      o = new Observation(this.access),
      resolvedRef = o.resolve(input.ref);
    const ids = decode(
      o.git([
        "rev-list",
        `--skip=${input.offset}`,
        `--max-count=${input.limit + 1}`,
        resolvedRef,
        "--",
      ]),
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (ids.some((s) => !SHA.test(s))) throw new Error("GIT_INVALID_OUTPUT");
    const commits: GitCommit[] = [];
    for (const sha of ids.slice(0, input.limit)) {
      const commit = o.commit(sha);
      if (bytes([...commits, commit]) > 48 * 1024) break;
      commits.push(commit);
    }
    const truncated = ids.length > commits.length;
    return finish({
      ...o.meta(),
      resolvedRef,
      commits,
      offset: input.offset,
      nextOffset: truncated ? input.offset + commits.length : null,
      truncated,
    });
  }
  async show(options: GitShowOptions = {}) {
    this.access.ready();
    const input = gitHistoryInputs.git_show.parse(options),
      o = new Observation(this.access),
      head = o.resolve(input.ref),
      commit = o.commit(head);
    if (input.parent > Math.max(1, commit.parents.length))
      throw new Error("GIT_INVALID_PARENT");
    const base = commit.parents[input.parent - 1] ?? null;
    if (base) o.resolve(base); // Shallow boundaries must fail, never masquerade as root additions.
    const data = {
      ...o.comparison(base, head, base, "direct", [], input),
      commit,
      parent: input.parent,
    };
    const full = o.message(head),
      chunk = textChunk(
        full.text,
        input.messageOffset,
        Math.min(8192, MAX_OUTPUT - bytes(data) - 1024),
      );
    const message = {
      text: chunk.text,
      offset: input.messageOffset,
      nextOffset: chunk.nextOffset,
      totalLength: full.text.length,
      sha256: full.sha256,
    };
    return finish({
      ...data,
      truncated: data.truncated || message.nextOffset !== null,
      message,
    });
  }
  async compare(options: GitCompareOptions) {
    this.access.ready();
    const input = gitHistoryInputs.git_compare.parse(options),
      o = new Observation(this.access),
      base = o.resolve(input.base),
      head = o.resolve(input.head);
    let effectiveBase = base;
    let mergeBases: string[] = [];
    if (input.mode === "merge-base") {
      mergeBases = decode(o.git(["merge-base", "--all", base, head]))
        .trim()
        .split("\n")
        .filter(Boolean);
      if (mergeBases.length !== 1 || !SHA.test(mergeBases[0]))
        throw new Error("GIT_AMBIGUOUS_OR_MISSING_MERGE_BASE");
      effectiveBase = mergeBases[0];
    }
    return finish(
      o.comparison(base, head, effectiveBase, input.mode, mergeBases, input),
    );
  }
  async read(options: GitReadOptions) {
    this.access.ready();
    const input = gitHistoryInputs.git_read_file.parse(options),
      o = new Observation(this.access),
      commit = o.resolve(input.ref),
      filePath = this.access.normalize(input.filePath);
    if (!o.allowed(filePath, [commit])) throw new Error("ACCESS_DENIED");
    const entry = o.tree(commit).get(filePath);
    if (!entry) throw new Error("GIT_FILE_NOT_FOUND");
    const blob = o.blob(entry),
      lines = blob.text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const selected: string[] = [];
    for (const line of lines.slice(
      input.startLine - 1,
      input.startLine - 1 + input.maxLines,
    )) {
      if (bytes([...selected, line].join("\n")) > 48 * 1024) {
        if (!selected.length) throw new Error("LINE_TOO_LONG");
        break;
      }
      selected.push(line);
    }
    const endLine = input.startLine + selected.length - 1,
      truncated = endLine < lines.length;
    return finish({
      ...o.meta(),
      commit,
      blob: entry.oid,
      filePath,
      content: selected.join("\n"),
      startLine: input.startLine,
      endLine,
      totalLines: lines.length,
      nextStartLine: truncated ? endLine + 1 : null,
      truncated,
      sizeBytes: blob.raw.length,
      sha256: hash(blob.raw),
      hashScope: "whole-blob" as const,
    });
  }
}
