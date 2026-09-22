import { textChunk } from "./evidence.ts";
import {
  gitHistoryInputs,
  type GitLogOptions,
  type GitShowOptions,
  type GitCompareOptions,
  type GitReadOptions,
  type GitCommit,
} from "./git-history-schemas.ts";
import { Observation, type HistoryAccess } from "./git-observation.ts";
import { MAX_OUTPUT, SHA, bytes, decode, finish, hash } from "./git-output.ts";
export type { HistoryAccess } from "./git-observation.ts";
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
