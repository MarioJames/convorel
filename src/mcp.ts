import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspaceAccess, fullPath } from "./workspace-access.ts";
import { MAX_OUT } from "./workspace.ts";
import { outputSchemas } from "./mcp-schemas.ts";
export function createServer(roots: string[]) {
  const access = new WorkspaceAccess(roots),
    server = new McpServer({ name: "convorel", version: "0.1.0" });
  access.assertPrivate(
    process.env.CONVOREL_HOME || join(homedir(), ".local/share/convorel"),
  );
  access.assertPrivate(join(homedir(), ".local/share/convorel-tunnels"));
  const add = (
    name: keyof typeof outputSchemas,
    description: string,
    inputSchema: any,
    fn: (a: any) => Promise<any>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema: outputSchemas[name],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (a: any) => {
        try {
          const data = await fn(a);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
            structuredContent: data,
          };
        } catch (e: any) {
          const code =
            e.code === "ENOENT"
              ? "FILE_NOT_FOUND"
              : /^[A-Z_]+$/.test(e.message)
                ? e.message
                : "TOOL_FAILED";
          return {
            isError: true,
            content: [{ type: "text" as const, text: code }],
          };
        }
      },
    );
  };
  add(
    "workspace_info",
    "List allowed roots with workspace=null, or identify the full project path in workspace before reading. Read-only; workspaceId is not authentication.",
    { path: z.string().optional() },
    async (a) => {
      const info = await access.info(a.path);
      const { roots, mode, ...workspace } = info;
      return { roots, mode, workspace: "path" in info ? workspace : null };
    },
  );
  const directoryInput = {
    path: z.string(),
    depth: z.number().int().min(1).max(4).default(1),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  };
  add(
    "list_directory",
    "List permitted files under a full directory path. Honor truncation and nextOffset.",
    directoryInput,
    async (a) => ({
      ...(await access.directory(a.path).list(".", a.depth, a.offset, a.limit)),
      path: fullPath(a.path),
    }),
  );
  add(
    "tree",
    "Show a bounded page of directory hierarchy for structural review, not proof of code dependencies. Uses list_directory policy and inventory order. Check depthLimited, scanTruncated, truncated and nextOffset; pages are live observations, not a snapshot.",
    directoryInput,
    async (a) => {
      const listing = await access
        .directory(a.path)
        .list(".", a.depth, a.offset, a.limit);
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
      // Rendering adds bytes to list_directory's bounded page. Retain its order
      // and advance only by entries actually returned, so none are skipped.
      while (Buffer.byteLength(JSON.stringify(data)) > MAX_OUT) {
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
    "search_workspace",
    "Search literal text, never regex. Scan and output are bounded; check truncation and skippedFiles.",
    { path: z.string(), query: z.string().min(1).max(200) },
    async (a) => ({
      ...(await access.directory(a.path).search(a.query)),
      path: fullPath(a.path),
    }),
  );
  add(
    "git_status",
    "Filtered Git status for a full repository path. Requires the exact Git top level. Failures are not a clean tree.",
    { path: z.string() },
    async (a) => ({
      ...(await access.directory(a.path).status()),
      path: fullPath(a.path),
    }),
  );
  add(
    "git_diff",
    "Filtered live Git diff; excludes sensitive paths on either rename side, submodules, external drivers and filters. Untracked file contents are excluded.",
    {
      path: z.string(),
      mode: z.enum(["unstaged", "staged", "head"]).default("unstaged"),
    },
    async (a) => ({
      ...(await access.directory(a.path).diff(a.mode)),
      path: fullPath(a.path),
    }),
  );
  return server;
}
export async function serve(roots: string[]) {
  const s = createServer(roots);
  await s.connect(new StdioServerTransport());
  return s;
}
