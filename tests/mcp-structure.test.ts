import { test, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "convorel-mcp-structure-"));
  const first = join(root, "first"),
    second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const put = (path: string, content: string) =>
    writeFileSync(join(first, path), content);
  put("hello.ts", "export const answer = 42;\n");
  put("secret.key", "SECRET_SENTINEL\n");
  put("empty.txt", "");
  writeFileSync(join(second, "second.ts"), "export const second = 2;\n");
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
  const validator = new AjvJsonSchemaValidator();
  let validations = 0;
  const client = new Client(
    { name: "acceptance", version: "1" },
    {
      jsonSchemaValidator: {
        getValidator: <T>(schema: JsonSchemaType) => {
          const validate = validator.getValidator<T>(schema);
          return (data) => {
            validations++;
            return validate(data);
          };
        },
      },
    },
  );
  const close = async () => {
    try {
      await client.close();
      await transport.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });
    const success = async (
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const before = validations;
      const result = await call(name, args);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(validations).toBe(before + 1);
      const data = result.structuredContent as Record<string, unknown>;
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(data) },
      ]);
      const schema = tools.find((tool) => tool.name === name)!.outputSchema!;
      const validate = validator.getValidator(schema);
      // Every returned top-level field must be covered by the required contract.
      for (const key of Object.keys(data)) {
        const incomplete = { ...data };
        delete incomplete[key];
        expect(validate(incomplete).valid).toBe(false);
      }
      return data as any;
    };
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", first, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
        },
      });
      if (result.exitCode) throw new Error(result.stderr.toString());
    };
    return {
      root,
      first,
      second,
      put,
      tools,
      call,
      success,
      git,
      close,
      validator,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("real stdio client validates both workspace results, reads, searches and errors", async () => {
  const f = await fixture();
  try {
    const info = await f.success("workspace_info");
    expect(info.roots).toHaveLength(2);
    expect(info.workspace).toBeNull();
    const project = await f.success("workspace_info", { path: f.first });
    expect(project.workspace.path).toBe(f.first);
    expect(project.workspace.gitHead).toBeNull();
    const schema = f.tools.find(
      (tool) => tool.name === "workspace_info",
    )!.outputSchema!;
    expect(
      f.validator.getValidator(schema)({
        ...project,
        workspace: { path: f.first },
      }).valid,
    ).toBe(false);
    const other = await f.success("read_file", {
      path: join(f.second, "second.ts"),
    });
    expect(other.content).toContain("second = 2");
    const read = await f.success("read_file", {
      path: join(f.first, "hello.ts"),
    });
    expect(read.content).toContain("answer = 42");
    expect(read.hashScope).toBe("whole-file");
    const empty = await f.success("read_file", {
      path: join(f.first, "empty.txt"),
    });
    expect(empty.endLine).toBe(0);
    expect(empty.totalLines).toBe(0);
    const listing = await f.success("list_directory", { path: f.first });
    expect(listing.entries).toContainEqual({ path: "hello.ts", type: "file" });
    const search = await f.success("search_workspace", {
      path: f.first,
      query: "answer",
    });
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0].path).toBe("hello.ts");
    for (const [name, args] of [
      ["read_file", { path: join(f.first, "secret.key") }],
      ["read_file", { path: "../../etc/passwd" }],
      ["read_file", { path: join(f.first, "missing.ts") }],
      ["git_status", { path: f.second }],
      ["git_diff", { path: f.second }],
    ] as const) {
      const result = await f.call(name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    }
  } finally {
    await f.close();
  }
}, 20000);

test("real stdio client validates ordinary repository status and all diff modes", async () => {
  const f = await fixture();
  try {
    f.git("init", "-q");
    f.git("config", "user.name", "Fixture");
    f.git("config", "user.email", "fixture@example.invalid");
    f.git("add", "-f", "hello.ts", "secret.key");
    f.git("commit", "-qm", "fixture");
    f.put("hello.ts", "export const answer = 43;\n");
    f.put("secret.key", "NEW_SECRET_SENTINEL\n");
    const project = await f.success("workspace_info", { path: f.first });
    expect(project.workspace.gitHead).toMatch(/^[a-f0-9]{40,64}$/);
    const status = await f.success("git_status", { path: f.first });
    expect(status.dirty).toBe(true);
    expect(status.entries).toContainEqual({ path: "hello.ts", change: " M" });
    expect(status.hidden).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain("secret.key");
    for (const mode of ["unstaged", "head", "staged"]) {
      if (mode === "staged") f.git("add", "hello.ts", "secret.key");
      const diff = await f.success("git_diff", { path: f.first, mode });
      expect(diff.mode).toBe(mode);
      expect(diff.diff).toContain("+export const answer = 43;");
      expect(diff.hidden).toBeGreaterThan(0);
      expect(diff.hashScope).toBe("returned-diff");
      expect(JSON.stringify(diff)).not.toContain("SECRET_SENTINEL");
    }
  } finally {
    await f.close();
  }
}, 20000);

test("tree shares directory policy, depth and pagination through real stdio", async () => {
  const f = await fixture();
  try {
    expect(f.tools.map((tool) => tool.name).sort()).toEqual([
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "tree",
      "workspace_info",
    ]);
    f.put(".gitignore", "private/\n");
    f.put(".convorelignore", "internal/\n");
    for (const path of ["src/deep/more", "private", "internal", "node_modules"])
      mkdirSync(join(f.first, path), { recursive: true });
    f.put("src/.gitignore", "hidden.ts\n");
    for (const path of [
      "private/leak.ts",
      "internal/leak.ts",
      "node_modules/leak.ts",
      "src/hidden.ts",
    ])
      f.put(path, "SECRET_SENTINEL");
    f.put("src/index.ts", "export {};\n");
    f.put("src/deep/module.ts", "export {};\n");
    f.put("src/deep/more/last.ts", "export {};\n");
    f.put('line\nbreak".ts', "export {};\n");
    symlinkSync(join(f.first, "src"), join(f.first, "alias"));
    const shallow = await f.success("tree", { path: f.first, depth: 1 });
    expect(shallow.depth).toBe(1);
    expect(shallow.depthLimited).toBe(true);
    expect(shallow.entries.some((entry: any) => entry.path === "src")).toBe(
      true,
    );
    expect(shallow.entries.every((entry: any) => entry.depth === 1)).toBe(true);
    expect(JSON.stringify(shallow)).not.toContain("index.ts");
    const full = await f.success("tree", { path: f.first, depth: 4 });
    expect(full.depthLimited).toBe(false);
    expect(full.scanTruncated).toBe(false);
    expect(full.truncated).toBe(false);
    expect(full.nextOffset).toBeNull();
    expect(full.entries).toContainEqual({
      path: "src/deep/module.ts",
      type: "file",
      depth: 3,
      parentPath: "src/deep",
    });
    expect(full.tree).toContain('    "src/deep/module.ts"');
    expect(full.tree).toContain(JSON.stringify('line\nbreak".ts'));
    expect(full.tree.split("\n")).toHaveLength(full.entries.length);
    for (const denied of [
      "secret.key",
      "private",
      "internal",
      "node_modules",
      "hidden.ts",
      "alias",
    ])
      expect(JSON.stringify(full)).not.toContain(denied);
    const list = await f.success("list_directory", { path: f.first, depth: 4 });
    expect(full.entries.map(({ path, type }: any) => ({ path, type }))).toEqual(
      list.entries,
    );
    const paged: unknown[] = [];
    let offset = 0;
    do {
      const page = await f.success("tree", {
        path: f.first,
        depth: 4,
        offset,
        limit: 2,
      });
      expect(page.offset).toBe(offset);
      expect(page.entries.length).toBeLessThanOrEqual(2);
      expect(page.truncated).toBe(page.nextOffset !== null);
      paged.push(...page.entries);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + page.entries.length);
      offset = page.nextOffset;
    } while (offset < 100);
    expect(paged).toEqual(full.entries);
    const nested = await f.success("tree", {
      path: join(f.first, "src"),
      depth: 4,
    });
    expect(nested.entries).toContainEqual({
      path: "deep/module.ts",
      type: "file",
      depth: 2,
      parentPath: "deep",
    });
    expect(JSON.stringify(nested)).not.toContain("hidden.ts");
    for (const args of [
      { path: f.root },
      { path: join(f.first, "private") },
      { path: join(f.first, "alias") },
      { path: f.first, depth: 5 },
      { path: f.first, limit: 501 },
      { path: f.first, offset: 10001 },
    ])
      expect((await f.call("tree", args)).isError).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);

test("tree byte truncation preserves offsets and never drops a page's remaining entries", async () => {
  const f = await fixture();
  try {
    const names = Array.from(
      { length: 400 },
      (_, i) => `${i.toString().padStart(3, "0")}-${"x".repeat(180)}.ts`,
    );
    for (const name of names) f.put(name, "");
    const paths: string[] = [];
    let offset = 0;
    do {
      const page = await f.success("tree", {
        path: f.first,
        limit: 500,
        offset,
      });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        64 * 1024,
      );
      expect(page.scanTruncated).toBe(false);
      expect(page.depthLimited).toBe(false);
      paths.push(...page.entries.map((entry: any) => entry.path));
      if (page.nextOffset === null) break;
      expect(page.truncated).toBe(true);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.nextOffset).toBe(offset + page.entries.length);
      offset = page.nextOffset;
    } while (offset < 500);
    expect(offset).toBeGreaterThan(0);
    expect(paths.sort()).toEqual([...names, "hello.ts", "empty.txt"].sort());
  } finally {
    await f.close();
  }
}, 20000);

test("tree reports inventory scan truncation independently from pagination", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10010; i++) f.put(`file-${i}.ts`, "");
    const page = await f.success("tree", { path: f.first, offset: 10000 });
    expect(page.scanTruncated).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.depthLimited).toBe(false);
    expect(page.nextOffset).toBeNull();
    expect(page.entries).toEqual([]);
    expect(page.tree).toBe("");
  } finally {
    await f.close();
  }
}, 20000);
