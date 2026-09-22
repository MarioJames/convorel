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
      join(import.meta.dir, "../../src/cli.ts"),
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

test("all MCP tools distinguish allowed roots from stable project identity", async () => {
  const f = await fixture();
  try {
    const repo = join(f.first, "project");
    const src = join(repo, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "code.txt"), "identity fixture\n");
    writeFileSync(
      join(src, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    f.git("-C", repo, "init", "-q");
    f.git("-C", repo, "config", "user.name", "Fixture");
    f.git("-C", repo, "config", "user.email", "fixture@example.invalid");
    f.git("-C", repo, "add", ".");
    f.git("-C", repo, "commit", "-qm", "identity");
    const roots = (await f.success("workspace_info")).roots;
    const rootId = roots.find((r: any) => r.path === f.first).rootId;
    expect(rootId).toMatch(/^[a-f0-9]{20}$/);
    const project = (await f.success("workspace_info", { path: repo }))
      .workspace;
    expect(project.rootId).toBe(rootId);
    expect(project.workspaceId).not.toBe(rootId);
    expect(project.workspacePath).toBe(repo);
    const nested = (await f.success("workspace_info", { path: src })).workspace;
    expect(nested.workspaceId).toBe(project.workspaceId);
    expect(nested.gitHead).toBe(project.gitHead);
    expect(nested.path).toBe(src);
    const requests: [string, Record<string, unknown>][] = [
      ["tree", { path: src }],
      ["find_files", { path: src }],
      ["search_workspace", { path: src, query: "identity" }],
      ["read_file", { path: join(src, "code.txt") }],
      ["read_image", { path: join(src, "image.png") }],
      ["git_status", { path: repo }],
      ["git_diff", { path: repo }],
      ["git_log", { path: repo }],
      ["git_show", { path: repo }],
      ["git_compare", { path: repo, base: "HEAD", head: "HEAD" }],
      ["git_read_file", { path: repo, filePath: "src/code.txt" }],
    ];
    for (const [name, args] of requests) {
      const result = await f.call(name, args);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        rootId,
        workspaceId: project.workspaceId,
        workspacePath: repo,
        path: args.path,
      });
    }
    const plain = await f.success("read_file", {
      path: join(f.first, "hello.ts"),
    });
    expect(plain.workspaceId).toBe(rootId);
    expect(plain.workspacePath).toBe(f.first);
    const second = await f.success("read_file", {
      path: join(f.second, "second.ts"),
    });
    expect(second.rootId).not.toBe(rootId);
    expect(second.workspaceId).toBe(second.rootId);
  } finally {
    await f.close();
  }
}, 20000);

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
    const listing = await f.success("tree", { path: f.first });
    expect(listing.entries).toContainEqual({
      path: "hello.ts",
      type: "file",
      depth: 1,
      parentPath: ".",
    });
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

test("evidence workflow discovers capabilities, locates code and reads committed changes through SDK schemas", async () => {
  const f = await fixture();
  try {
    const info = await f.success("workspace_info", { path: f.first });
    expect(info.server.capabilityVersion).toBe("evidence-v2");
    expect(info.server.tools.sort()).toEqual(f.tools.map((t) => t.name).sort());
    const found = await f.success("find_files", {
      path: f.first,
      pattern: "*.ts",
    });
    expect(found.entries).toEqual([{ path: "hello.ts", type: "file" }]);
    const search = await f.success("search_workspace", {
      path: f.first,
      query: "answer",
      pattern: "*.ts",
      contextLines: 1,
      limit: 1,
    });
    expect(search.matches[0].sha256).toHaveLength(64);
    expect(search.nextOffset).toBeNull();
    f.git("init", "-q", "-b", "main");
    f.git("config", "user.name", "Fixture");
    f.git("config", "user.email", "fixture@example.invalid");
    f.git("add", "hello.ts");
    f.git("commit", "-qm", "first");
    const first = await f.success("git_log", { path: f.first, limit: 1 });
    const base = first.resolvedRef;
    f.put("hello.ts", "export const answer = 43;\n");
    f.git("add", "hello.ts");
    f.git("commit", "-qm", "second");
    const log = await f.success("git_log", { path: f.first, limit: 1 });
    expect(log.commits[0].subject).toBe("second");
    expect(log.nextOffset).toBe(1);
    expect(
      (
        await f.success("git_log", {
          path: f.first,
          ref: log.resolvedRef,
          offset: log.nextOffset,
        })
      ).commits[0].sha,
    ).toBe(base);
    const show = await f.success("git_show", {
      path: f.first,
      ref: log.resolvedRef,
    });
    expect(show.patch.text).toContain("+export const answer = 43;");
    const comparison = await f.success("git_compare", {
      path: f.first,
      base,
      head: log.resolvedRef,
    });
    expect(comparison.files[0]).toMatchObject({
      path: "hello.ts",
      additions: 1,
      deletions: 1,
    });
    const old = await f.success("git_read_file", {
      path: f.first,
      ref: base,
      filePath: "hello.ts",
    });
    expect(old.content).toContain("42");
    expect(old.commit).toBe(base);
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=";
    writeFileSync(join(f.first, "proof.png"), Buffer.from(png, "base64"));
    const image = await f.call("read_image", {
      path: join(f.first, "proof.png"),
    });
    expect(image.isError).not.toBe(true);
    expect(image.content).toContainEqual({
      type: "image",
      mimeType: "image/png",
      data: png,
    });
    const imageSchema = f.tools.find(
      (t) => t.name === "read_image",
    )!.outputSchema!;
    expect(
      f.validator.getValidator(imageSchema)(image.structuredContent).valid,
    ).toBe(true);
    expect(image.structuredContent).not.toHaveProperty("imageData");
    for (const [name, args] of [
      ["git_log", { path: f.first, ref: "--all" }],
      ["git_read_file", { path: f.first, filePath: ".env" }],
      ["git_compare", { path: f.first, base: "missing" }],
      ["find_files", { path: join(f.root, "outside"), pattern: "*" }],
    ] as const)
      expect((await f.call(name, args)).isError).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);

test("tree shares directory policy, depth and pagination through real stdio", async () => {
  const f = await fixture();
  try {
    expect(f.tools.map((tool) => tool.name).sort()).toEqual([
      "find_files",
      "git_compare",
      "git_diff",
      "git_log",
      "git_read_file",
      "git_show",
      "git_status",
      "read_file",
      "read_image",
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
