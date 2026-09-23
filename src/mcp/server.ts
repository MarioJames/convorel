import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { stateDirectory } from "../paths.ts";
import { join } from "node:path";
import { WorkspaceAccess, parseRoots } from "../workspace/access.ts";
import { fullPath } from "../paths.ts";
import { MAX_OUT } from "../workspace/workspace.ts";
import { outputSchemas } from "./schemas.ts";
import { gitHistoryInputs } from "../workspace/git-history-schemas.ts";
import { preferenceDirectory } from "../config/preferences.ts";
import packageInfo from "../../package.json";
import { registerFunctions } from "./functions.ts";
import type { Operation } from "./functions.ts";
import { MemoryAccess } from "./memory.ts";
import { parseMemoryRoots } from "../config/mcp.ts";
import { ExecutionAccess } from "./execution.ts";
import { preference } from "../config/preferences.ts";
export function createServer(roots: string[], memory?: MemoryAccess) {
  const access = new WorkspaceAccess(roots),
    server = new McpServer({ name: "convorel", version: packageInfo.version });
  access.assertPrivate(stateDirectory());
  access.assertPrivate(join(homedir(), ".local/share/convorel-tunnels"));
  access.assertPrivate(preferenceDirectory());
  const operations = new Map<string, Operation>();
  const add = (
    name: keyof typeof outputSchemas,
    description: string,
    inputSchema: any,
    fn: (
      a: any,
      identity: ReturnType<WorkspaceAccess["identity"]> | null,
    ) => Promise<any>,
  ) => {
    const schema =
      inputSchema instanceof z.ZodObject
        ? inputSchema.strict()
        : z.strictObject(inputSchema);
    operations.set(name, {
      description,
      input: schema,
      output: outputSchemas[name],
      async run(args) {
        const a: any = schema.parse(args);
        const identity =
          name === "workspace_info" ? null : access.identity(a.path);
        const { imageData, ...result } = await fn(a, identity);
        const data = outputSchemas[name].parse({ ...result, ...identity });
        return { data, imageData };
      },
    });
  };
  add(
    "workspace_info",
    "List allowed roots by rootId with workspace=null, or identify the selected directory's project. workspaceId/workspacePath identify the nearest Git checkout inside the allowed root, falling back to that root without Git. path remains the requested scope. IDs are not authentication.",
    { path: z.string().optional() },
    async (a) => {
      const info = await access.info(a.path);
      const { roots, mode, ...workspace } = info;
      return {
        roots,
        mode,
        workspace: "path" in info ? workspace : null,
        server: {
          name: "convorel",
          version: packageInfo.version,
          capabilityVersion: "functions-v1",
          tools: ["exec", "memory", "artifact", "capabilities"],
          maxStructuredResponseBytes: MAX_OUT,
          maxImageBytes: 1024 * 1024,
        },
      };
    },
  );
  const directoryInput = {
    path: z.string(),
    depth: z.number().int().min(1).max(4).default(1),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  };
  add(
    "tree",
    "Show a bounded page of directory hierarchy for structural review, not proof of code dependencies. Returns both structured entries and rendered tree, sorted by relative path. Check depthLimited, scanTruncated, truncated and nextOffset; pages are live observations, not a snapshot.",
    directoryInput,
    async (a, identity) => {
      const workspace = access.directory(a.path);
      const listing = await workspace.list(".", a.depth, a.offset, a.limit);
      const entries = listing.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          ...entry,
          depth: parts.length,
          parentPath: parts.slice(0, -1).join("/") || ".",
        };
      });
      const data = {
        ...listing,
        path: fullPath(a.path),
        entries,
        depth: a.depth as number,
        offset: a.offset as number,
        limit: a.limit as number,
        tree: "",
        ...identity!,
        observedAt: new Date().toISOString(),
        note: "Directory layout only, not dependency analysis. This page may omit parents returned on earlier pages. Depth-limited directories are not necessarily empty. Live pages may shift when files change; scanTruncated means unscanned entries cannot be recovered by nextOffset.",
      };
      const render = () =>
        entries
          .map(
            (entry) =>
              `${"  ".repeat(entry.depth - 1)}${JSON.stringify(entry.path)}${entry.type === "directory" ? "/" : ""}`,
          )
          .join("\n");
      data.tree = render();
      // Rendering adds bytes to the bounded listing. Retain its order
      // and advance only by entries actually returned, so none are skipped.
      while (Buffer.byteLength(JSON.stringify(data)) > MAX_OUT - 2048) {
        if (!entries.length) throw new Error("TREE_RESPONSE_TOO_LARGE");
        entries.pop();
        data.tree = render();
        data.truncated = true;
        data.nextOffset = a.offset + entries.length;
      }
      return data;
    },
  );
  add(
    "read_file",
    "Read a full file path within allowed roots, returning bounded UTF-8 lines and whole-file SHA-256.",
    {
      path: z.string(),
      startLine: z.number().int().min(1).max(10000000).default(1),
      maxLines: z.number().int().min(1).max(1000).default(400),
    },
    async (a) => {
      const target = access.file(a.path);
      return {
        ...(await target.workspace.read(target.path, a.startLine, a.maxLines)),
        path: fullPath(a.path),
      };
    },
  );
  add(
    "read_image",
    "Read an allowed PNG/JPEG/WebP screenshot or image as native image content, up to 1 MiB. Same file policy as read_file. A screenshot is evidence, not proof of execution time or tested revision; the caller must supply that context.",
    { path: z.string() },
    async (a) => {
      const target = access.file(a.path);
      return {
        ...(await target.workspace.image(target.path)),
        path: fullPath(a.path),
      };
    },
  );
  const discoveryInput = {
    path: z.string(),
    pattern: z.string().min(1).max(200).default("*"),
    depth: z.number().int().min(1).max(32).default(12),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  };
  add(
    "find_files",
    "Locate permitted files by glob, sorted by relative path. Patterns without '/' match basenames at any depth; e.g. '*.ts', '**/migrations/*.sql'. Check scanTruncated, depthLimited and nextOffset; narrowing path avoids scan limits.",
    discoveryInput,
    async (a) => ({
      ...(await access
        .directory(a.path)
        .find(a.pattern, a.depth, a.offset, a.limit)),
      path: fullPath(a.path),
    }),
  );
  add(
    "search_workspace",
    "Search literal case-sensitive text within a full directory path and optional file glob. Returns matching lines, bounded context and file hashes. Follow nextOffset; scanTruncated/depthLimited/skippedFiles mean incomplete coverage, not absence. Use read_file for truncated excerpts.",
    {
      ...discoveryInput,
      query: z.string().min(1).max(200),
      offset: z.number().int().min(0).max(1000000).default(0),
      limit: z.number().int().min(1).max(50).default(50),
      contextLines: z.number().int().min(0).max(5).default(2),
    },
    async (a) => ({
      ...(await access.directory(a.path).search(a.query, a)),
      path: fullPath(a.path),
    }),
  );
  add(
    "git_status",
    "Filtered Git status for a full repository path. Requires the exact Git top level. Failures are not a clean tree. A clean worktree does not mean there are no recent commits; use git_log/git_show.",
    {
      path: z.string(),
      offset: z.number().int().min(0).max(1000000).default(0),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async (a) => ({
      ...(await access.directory(a.path).status(a.offset, a.limit)),
      path: fullPath(a.path),
    }),
  );
  add(
    "git_diff",
    "Filtered live Git diff; excludes sensitive paths on either rename side, submodules, external drivers and filters. Untracked file contents are excluded. Paginated files plus one patch fragment; select patchFile and follow nextPatchOffset. Use git_show for a commit and git_compare for version differences.",
    {
      path: z.string(),
      mode: z.enum(["unstaged", "staged", "head"]).default("unstaged"),
      offset: z.number().int().min(0).max(1000000).default(0),
      limit: z.number().int().min(1).max(500).default(100),
      patchFile: z.string().optional(),
      patchOffset: z.number().int().min(0).max(10000000).default(0),
    },
    async (a) => ({
      ...(await access.directory(a.path).diff(a.mode, a)),
      path: fullPath(a.path),
    }),
  );
  const historyTools = [
    [
      "git_log",
      "log",
      "Read paginated commit history. Resolve ref to an immutable SHA and reuse it on later pages. Empty worktree diff is unrelated to this history. Check shallow and truncation.",
    ],
    [
      "git_show",
      "show",
      "Inspect a commit with metadata, parent comparison, filtered file statistics and a resumable patch. Root commits compare to empty; merge commits select parent explicitly. Follow top-level nextOffset for files and patch.nextOffset with patchFile.",
    ],
    [
      "git_compare",
      "compare",
      "Compare immutable versions: direct endpoint difference or merge-base change. Returns resolved SHAs, filtered file statistics and a resumable single-file patch. Pin returned SHAs for continuation.",
    ],
    [
      "git_read_file",
      "read",
      "Read UTF-8 filePath relative to the repository root at ref, including deleted historical files. Enforces current and historical ignore policies. Returns commit/blob identity, whole-file SHA-256 and line continuation.",
    ],
  ] as const;
  for (const [name, method, description] of historyTools) {
    add(
      name,
      description,
      gitHistoryInputs[name].extend({ path: z.string() }),
      async (a) => {
        const { path, ...options } = a;
        const history = access.directory(path).history();
        return {
          ...(await (history[method] as (options: any) => Promise<any>)(
            options,
          )),
          path: fullPath(path),
        };
      },
    );
  }
  registerFunctions(
    server,
    operations,
    memory ??
      new MemoryAccess(
        parseMemoryRoots(preference("mcp.memoryRoots")),
        preference("mcp.memoryExecutable") ?? "ov",
      ),
    new ExecutionAccess(
      access,
      preference("mcp.execDependencyRoots")
        ? parseRoots(preference("mcp.execDependencyRoots")!).map(fullPath)
        : [],
    ),
  );
  return server;
}
export async function serve(roots: string[]) {
  const s = createServer(roots);
  await s.connect(new StdioServerTransport());
  return s;
}
