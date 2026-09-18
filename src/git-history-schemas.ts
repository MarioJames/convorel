import { z } from "zod";

const count = z.number().int().nonnegative();
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (s) => !s.startsWith("-") && !/[\s\x00-\x1f\x7f:\\]/.test(s),
    "Expected one commit revision, without options or a path expression",
  );
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.includes("\\") &&
      !s.includes("\0") &&
      !s.split("/").includes(".."),
    "Expected a repository-relative file path",
  );
const page = {
  offset: count.max(10000).default(0),
  limit: z.number().int().min(1).max(100).default(20),
};
const diffPage = {
  ...page,
  patchFile: filePath
    .optional()
    .describe(
      "Patch for this visible changed file; defaults to the first file on the returned page.",
    ),
  patchOffset: count
    .max(16 * 1024 * 1024)
    .default(0)
    .describe(
      "UTF-16 offset from patch.nextOffset. Pin returned commit SHAs and patchFile when continuing.",
    ),
};
export const gitHistoryInputs = {
  git_log: z.strictObject({
    ref: ref.default("HEAD"),
    ...page,
    offset: count.default(0),
  }),
  git_show: z.strictObject({
    ref: ref.default("HEAD"),
    parent: z.number().int().min(1).max(100).default(1),
    messageOffset: count
      .max(1024 * 1024)
      .default(0)
      .describe(
        "Continue commit message text using message.nextOffset; pin ref to the returned SHA.",
      ),
    ...diffPage,
  }),
  git_compare: z.strictObject({
    base: ref,
    head: ref.default("HEAD"),
    mode: z.enum(["direct", "merge-base"]).default("direct"),
    ...diffPage,
  }),
  git_read_file: z.strictObject({
    ref: ref.default("HEAD"),
    filePath,
    startLine: z.number().int().min(1).max(10000000).default(1),
    maxLines: z.number().int().min(1).max(1000).default(200),
  }),
};
const meta = {
  workspaceId: z.string().regex(/^[a-f0-9]{20}$/),
  observedAt: z.iso.datetime(),
  shallow: z
    .boolean()
    .describe(
      "History may be incomplete when true; missing ancestors are never treated as root commits.",
    ),
};
const commit = z.strictObject({
  sha: objectId,
  parents: z.array(objectId).max(100),
  author: z.strictObject({ name: z.string(), email: z.string() }),
  authoredAt: z.iso.datetime(),
  committedAt: z.iso.datetime(),
  subject: z.string(),
});
const file = z.strictObject({
  path: filePath,
  oldPath: filePath.nullable(),
  status: z.enum(["A", "D", "M", "R", "C", "T"]),
  additions: count,
  deletions: count,
});
const patch = z.strictObject({
  filePath,
  text: z.string(),
  offset: count,
  nextOffset: count.nullable(),
  totalLength: count.describe(
    "UTF-16 code units in the whole patch; fragments may split a line.",
  ),
  sha256,
  hashScope: z.literal("whole-patch"),
});
const comparison = {
  ...meta,
  base: objectId
    .nullable()
    .describe(
      "Requested base commit; null means the empty tree for a root commit.",
    ),
  head: objectId,
  effectiveBase: objectId.nullable(),
  mode: z.enum(["direct", "merge-base"]),
  mergeBases: z.array(objectId).max(100),
  files: z.array(file).max(100),
  offset: count,
  nextOffset: count.nullable(),
  truncated: z
    .boolean()
    .describe(
      "More visible files or more patch text remain; see both nextOffset fields.",
    ),
  summary: z.strictObject({
    visibleFiles: count,
    hiddenFiles: count,
    additions: count,
    deletions: count,
  }),
  patch: patch.nullable(),
  note: z.string(),
};
export const gitHistoryOutputs = {
  git_log: z.strictObject({
    ...meta,
    resolvedRef: objectId,
    commits: z.array(commit).max(100),
    offset: count,
    nextOffset: count.nullable(),
    truncated: z.boolean(),
  }),
  git_show: z.strictObject({
    ...comparison,
    commit,
    parent: z.number().int().min(1).max(100),
    message: z.strictObject({
      text: z.string(),
      offset: count,
      nextOffset: count.nullable(),
      totalLength: count,
      sha256,
    }),
  }),
  git_compare: z.strictObject(comparison),
  git_read_file: z.strictObject({
    ...meta,
    commit: objectId,
    blob: objectId,
    filePath,
    content: z.string(),
    startLine: z.number().int().positive(),
    endLine: count,
    totalLines: count,
    nextStartLine: z.number().int().positive().nullable(),
    truncated: z.boolean(),
    sizeBytes: count.max(1024 * 1024),
    sha256,
    hashScope: z.literal("whole-blob"),
  }),
};
export type GitLogOptions = z.input<typeof gitHistoryInputs.git_log>;
export type GitShowOptions = z.input<typeof gitHistoryInputs.git_show>;
export type GitCompareOptions = z.input<typeof gitHistoryInputs.git_compare>;
export type GitReadOptions = z.input<typeof gitHistoryInputs.git_read_file>;
export type GitCommit = z.infer<typeof commit>;
export type GitHistoryFile = z.infer<typeof file>;
