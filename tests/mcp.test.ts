import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real stdio client discovers tools and reads only allowed files", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-mcp-"));
  writeFileSync(join(root, "hello.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, ".env"), "SECRET_SENTINEL");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "mcp",
      "serve",
      "--workspace",
      root,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "acceptance", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "workspace_info",
    ]);
    const r = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.ts" },
    });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain("answer = 42");
    const denied = await client.callTool({
      name: "read_file",
      arguments: { path: ".env" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("SECRET_SENTINEL");
    const traversal = await client.callTool({
      name: "read_file",
      arguments: { path: "../../etc/passwd" },
    });
    expect(traversal.isError).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
