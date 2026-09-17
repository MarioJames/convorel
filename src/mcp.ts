import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Workspace } from "./workspace.ts";
export function createServer(root: string) {
  const ws = new Workspace(root),
    server = new McpServer({ name: "convorel", version: "0.1.0" });
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
    "Identify this fixed workspace before reading. Live read-only data; workspaceId is not authentication.",
    {},
    () => ws.info(),
  );
  add(
    "list_directory",
    "List permitted workspace-relative paths. Honor truncation and nextOffset.",
    {
      path: z.string().default("."),
      depth: z.number().int().min(1).max(4).default(1),
      offset: z.number().int().min(0).max(10000).default(0),
      limit: z.number().int().min(1).max(500).default(200),
    },
    (a) => ws.list(a.path, a.depth, a.offset, a.limit),
  );
  add(
    "read_file",
    "Read bounded UTF-8 lines, with SHA-256 of the exact whole-file bytes observed.",
    {
      path: z.string(),
      startLine: z.number().int().min(1).max(10000000).default(1),
      maxLines: z.number().int().min(1).max(1000).default(400),
    },
    (a) => ws.read(a.path, a.startLine, a.maxLines),
  );
  add(
    "search_workspace",
    "Search literal text, never regex. Scan and output are bounded; check truncation and skippedFiles.",
    { query: z.string().min(1).max(200) },
    (a) => ws.search(a.query),
  );
  add(
    "git_status",
    "Filtered Git status. Requires the workspace to be the Git top level. Failures are not a clean tree.",
    {},
    () => ws.status(),
  );
  add(
    "git_diff",
    "Filtered live Git diff; excludes sensitive paths on either rename side, submodules, external drivers and filters. Untracked file contents are excluded.",
    { mode: z.enum(["unstaged", "staged", "head"]).default("unstaged") },
    (a) => ws.diff(a.mode),
  );
  return server;
}
export async function serve(root: string) {
  const s = createServer(root);
  await s.connect(new StdioServerTransport());
  return s;
}
