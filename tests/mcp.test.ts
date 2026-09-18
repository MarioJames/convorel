import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("real stdio client discovers tools and reads only allowed files", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-mcp-"));
  const second = join(root, "second");
  const first = join(root, "first");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(second, "second.ts"), "export const second = 2;\n");
  writeFileSync(join(first, "hello.ts"), "export const answer = 42;\n");
  writeFileSync(join(first, ".env"), "SECRET_SENTINEL");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "mcp",
      "serve",
      "--roots",
      JSON.stringify([first, second]),
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "acceptance", version: "1" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema!.type).toBe("object");
    }
    expect(tools.map((t) => t.name).sort()).toEqual([
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "tree",
      "workspace_info",
    ]);
    const info = await client.callTool({
      name: "workspace_info",
      arguments: {},
    });
    expect((info.structuredContent as any).roots).toHaveLength(2);
    const other = await client.callTool({
      name: "read_file",
      arguments: { path: join(second, "second.ts") },
    });
    expect(JSON.stringify(other)).toContain("second = 2");
    const project = await client.callTool({
      name: "workspace_info",
      arguments: { path: first },
    });
    expect((project.structuredContent as any).workspace.path).toBe(first);
    const r = await client.callTool({
      name: "read_file",
      arguments: { path: join(first, "hello.ts") },
    });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).toContain("answer = 42");
    const denied = await client.callTool({
      name: "read_file",
      arguments: { path: join(first, ".env") },
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
