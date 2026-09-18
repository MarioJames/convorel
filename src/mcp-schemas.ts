import { z } from "zod";

const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitHead = z
  .string()
  .regex(/^[a-f0-9]{40,64}$/)
  .nullable();
const workspaceId = z.string().regex(/^[a-f0-9]{20}$/);
const observedAt = z.iso.datetime();
const mode = z.literal("live-read-only");
const entry = z.strictObject({
  path: z.string(),
  type: z.enum(["file", "directory"]),
});
const listing = z.strictObject({
  path: z.string(),
  entries: z.array(entry).max(500),
  nextOffset: count
    .nullable()
    .describe(
      "Next page within the observed inventory; null does not imply a complete scan.",
    ),
  truncated: z
    .boolean()
    .describe(
      "More entries exist in this scan, or the scan budget was exhausted.",
    ),
  depthLimited: z
    .boolean()
    .describe(
      "Some directories were not descended into at the requested depth.",
    ),
  scanTruncated: z
    .boolean()
    .describe(
      "The inventory hit its scan/time budget; pagination cannot recover unscanned entries.",
    ),
});

export const outputSchemas = {
  // SDK 1.x requires a top-level object, so the two info results share an envelope.
  workspace_info: z.strictObject({
    roots: z
      .array(z.strictObject({ path: z.string(), workspaceId }))
      .min(1)
      .max(16),
    mode,
    workspace: z
      .strictObject({
        path: z.string(),
        workspaceId,
        name: z.string(),
        gitHead,
        observedAt,
        limits: z.strictObject({
          maxFileBytes: count,
          maxResponseContentBytes: count,
        }),
        policy: z.string(),
      })
      .nullable()
      .describe(
        "Null when listing roots without a path; otherwise the selected project's complete metadata.",
      ),
  }),
  list_directory: listing,
  tree: listing.extend({
    entries: z
      .array(
        entry.extend({
          depth: z.number().int().min(1).max(4),
          parentPath: z
            .string()
            .describe(
              "Parent relative to the requested path; '.' for direct children. The parent may be on another page.",
            ),
        }),
      )
      .max(500),
    depth: z.number().int().min(1).max(4),
    offset: count.max(10000),
    limit: z.number().int().min(1).max(500),
    tree: z
      .string()
      .describe(
        "This page only: two spaces per level, JSON-quoted relative paths, '/' after directories. It is not a complete tree when paginated or limited.",
      ),
    note: z.string(),
  }),
  read_file: z.strictObject({
    path: z.string(),
    content: z.string(),
    startLine: z.number().int().positive(),
    endLine: count,
    totalLines: count,
    truncated: z.boolean(),
    nextStartLine: z.number().int().positive().nullable(),
    sha256,
    hashScope: z.literal("whole-file"),
    sizeBytes: count,
    observedAt,
    workspaceId,
  }),
  search_workspace: z.strictObject({
    path: z.string(),
    matches: z
      .array(
        z.strictObject({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
          sha256,
        }),
      )
      .max(50),
    truncated: z.boolean(),
    skippedFiles: count,
    scannedBytes: count,
    workspaceId,
  }),
  git_status: z.strictObject({
    path: z.string(),
    head: gitHead,
    entries: z
      .array(z.strictObject({ path: z.string(), change: z.string().length(2) }))
      .max(500),
    hidden: count,
    truncated: z.boolean(),
    dirty: z.boolean(),
    workspaceId,
    observedAt,
  }),
  git_diff: z.strictObject({
    path: z.string(),
    mode: z.enum(["unstaged", "staged", "head"]),
    diff: z.string(),
    hidden: count,
    truncated: z.boolean(),
    sha256,
    hashScope: z.literal("returned-diff"),
    head: gitHead,
    workspaceId,
    observedAt,
    note: z.string(),
  }),
};
