import { serve } from "../mcp/server.ts";
import { preference } from "../config/preferences.ts";
import { parseRoots } from "../workspace/access.ts";
import { opts, rejectUnknown } from "./args.ts";

export async function runMcp(sub: string | undefined, rest: string[]) {
  if (sub !== "serve") throw new Error("UNKNOWN_MCP_COMMAND");
  const o = opts(rest);
  rejectUnknown("mcp serve", Object.keys(o), ["roots"]);
  const roots = o.roots ?? preference("mcp.roots");
  if (!roots) throw new Error("MCP_ROOTS_REQUIRED");
  await serve(parseRoots(roots));
  return 0;
}
