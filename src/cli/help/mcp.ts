import { page } from "./shared.ts";

const mcp = [
  page(
    ["mcp", "serve"],
    ["mcp serve [--roots JSON_ARRAY]"],
    "Serve exec, memory, artifact and capabilities on stdio for the tunnel client or another MCP client. stdout is reserved for the MCP protocol.",
    [
      [
        "--roots JSON_ARRAY",
        "Allowed directories. When omitted, mcp.roots from preferences is required. The value is a JSON array of 1 to 16 paths.",
      ],
    ],
    [
      "The process answers tool calls until the client closes it. It does not open Chrome.",
    ],
  ),
];

export const mcpPage = page(
  ["mcp"],
  ["mcp <command>"],
  "Serve guarded execution, evidence and explicitly shared memory.",
  [],
  [],
  mcp,
);
