import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkspaceAccess, fullPath } from "./workspace-access.ts";
export function createServer(roots: string[]) {
  const access = new WorkspaceAccess(roots),
    server = new McpServer({ name: "convorel", version: "0.1.0" });
  access.assertPrivate(
    process.env.CONVOREL_HOME || join(homedir(), ".local/share/convorel"),
  );
  access.assertPrivate(join(homedir(), ".local/share/convorel-tunnels"));
  const add = (
    name: string,
    description: string,
    inputSchema: any,
    fn: (a: any) => Promise<any>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
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
    "List allowed roots, or identify the full project path before reading. Read-only; workspaceId is not authentication.",
    { path: z.string().optional() },
    (a) => access.info(a.path),
  );
  add(
    "list_directory",
    "List permitted files under a full directory path. Honor truncation and nextOffset.",
    {
      path: z.string(),
      depth: z.number().int().min(1).max(4).default(1),
      offset: z.number().int().min(0).max(10000).default(0),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async (a) => ({
      ...(await access.directory(a.path).list(".", a.depth, a.offset, a.limit)),
      path: fullPath(a.path),
    }),
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
