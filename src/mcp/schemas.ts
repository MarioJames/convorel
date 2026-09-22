import { z } from "zod";
import { gitHistoryOutputs } from "../workspace/git-history-schemas.ts";

const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitHead = z
  .string()
  .regex(/^[a-f0-9]{40,64}$/)
  .nullable();
const workspaceId = z.string().regex(/^[a-f0-9]{20}$/);
const identity = {
  rootId: workspaceId.describe(
    "Configured allowed-root identity; not authentication.",
  ),
  workspaceId: workspaceId.describe(
    "Nearest Git checkout within the allowed root, or the root itself without Git.",
  ),
  workspacePath: z
    .string()
    .describe(
      "Canonical path corresponding to workspaceId; path remains the requested scope.",
    ),
};
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
      .array(z.strictObject({ path: z.string(), rootId: identity.rootId }))
      .min(1)
      .max(16),
    mode,
    server: z.strictObject({
      name: z.literal("convorel"),
      version: z.string(),
      capabilityVersion: z.literal("evidence-v2"),
      tools: z.array(z.string()),
      maxStructuredResponseBytes: count,
      maxImageBytes: count,
    }),
    workspace: z
      .strictObject({
        path: z.string(),
        ...identity,
        name: z.string(),
        gitHead,
        gitBranch: z.string().nullable(),
        gitError: z.string().nullable(),
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
  tree: listing.extend({
    ...identity,
    observedAt,
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
    ...identity,
  }),
  read_image: z.strictObject({
    path: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    sizeBytes: count,
    sha256,
    hashScope: z.literal("whole-file"),
    observedAt,
    ...identity,
    note: z.string(),
  }),
  find_files: z.strictObject({
    path: z.string(),
    pattern: z.string(),
    entries: z.array(entry).max(500),
    depth: count,
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    truncated: z.boolean(),
    scanTruncated: z.boolean(),
    depthLimited: z.boolean(),
    scannedEntries: count,
    ...identity,
    observedAt,
    note: z.string(),
  }),
  search_workspace: z.strictObject({
    path: z.string(),
    query: z.string(),
    pattern: z.string(),
    depth: count,
    offset: count,
    limit: count,
    contextLines: count,
    matches: z
      .array(
        z.strictObject({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
          sha256,
          contextBefore: z.array(z.string()),
          contextAfter: z.array(z.string()),
          textTruncated: z.boolean(),
        }),
      )
      .max(50),
    nextOffset: count.nullable(),
    truncated: z.boolean(),
    scanTruncated: z.boolean(),
    depthLimited: z.boolean(),
    skippedFiles: count,
    scannedBytes: count,
    ...identity,
    observedAt,
    note: z.string(),
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
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    ...identity,
    observedAt,
  }),
  git_diff: z.strictObject({
    path: z.string(),
    mode: z.enum(["unstaged", "staged", "head"]),
    diff: z.string(),
    files: z
      .array(
        z.strictObject({
          path: z.string(),
          previousPath: z.string().nullable(),
          change: z.string(),
        }),
      )
      .max(500),
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    patchFile: z.string().nullable(),
    patchOffset: count,
    nextPatchOffset: count.nullable(),
    totalPatchLength: count,
    patchSha256: sha256,
    hidden: count,
    truncated: z.boolean(),
    sha256,
    hashScope: z.literal("returned-diff"),
    head: gitHead,
    ...identity,
    observedAt,
    note: z.string(),
  }),
  git_log: gitHistoryOutputs.git_log.extend({ path: z.string(), ...identity }),
  git_show: gitHistoryOutputs.git_show.extend({
    path: z.string(),
    ...identity,
  }),
  git_compare: gitHistoryOutputs.git_compare.extend({
    path: z.string(),
    ...identity,
  }),
  git_read_file: gitHistoryOutputs.git_read_file.extend({
    path: z.string(),
    ...identity,
  }),
};
