import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  linkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Workspace } from "../../src/workspace/workspace.ts";
import { WorkspaceAccess } from "../../src/workspace/access.ts";
import { createServer } from "../../src/mcp/server.ts";
import { MemoryAccess } from "../../src/mcp/memory.ts";
import { setRuntimePaths, type RuntimePaths } from "../../src/paths.ts";

let base: string, root: string, previous: RuntimePaths;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "convorel-workspace-robustness-"));
  root = join(base, "root");
  mkdirSync(root);
  previous = setRuntimePaths({
    configDir: join(base, "config"),
    stateDir: join(base, "state"),
  });
});
afterEach(() => {
  setRuntimePaths(previous);
  rmSync(base, { recursive: true, force: true });
});
const put = (path: string, value: string | Buffer) =>
  writeFileSync(join(root, path), value);
const gitResult = (...args: string[]) =>
  Bun.spawnSync(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      "-C",
      root,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 8000,
    },
  );
const git = (...args: string[]) => {
  const result = gitResult(...args);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
function init() {
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  put("public.txt", "OBJECT_SENTINEL\n");
  git("add", ".");
  git("commit", "-qm", "base");
}
async function withClient(run: (client: Client) => Promise<void>) {
  const server = createServer([root], new MemoryAccess([], "/unused"));
  const client = new Client({ name: "workspace-regression", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("private storage rejects root ancestors, descendants and canonical aliases before MCP starts", () => {
  const state = join(base, "state");
  const reports = join(state, "executions/reports");
  mkdirSync(reports, { recursive: true });
  const access = new WorkspaceAccess([reports]);
  expect(() => access.assertPrivate(state)).toThrow("STATE_INSIDE_WORKSPACE");
  expect(() => access.assertPrivate(reports)).toThrow("STATE_INSIDE_WORKSPACE");
  expect(() =>
    access.assertPrivate(join(reports, "not-created/private")),
  ).toThrow("STATE_INSIDE_WORKSPACE");
  symlinkSync(state, join(base, "alias"));
  expect(() => access.assertPrivate(join(base, "alias"))).toThrow(
    "STATE_INSIDE_WORKSPACE",
  );
  expect(() => access.assertPrivate(join(base, "alias/executions"))).toThrow(
    "STATE_INSIDE_WORKSPACE",
  );
  expect(() => access.assertPrivate(join(base, "state-sibling"))).not.toThrow();
  expect(() =>
    createServer([reports], new MemoryAccess([], "/unused")),
  ).toThrow("STATE_INSIDE_WORKSPACE");
});

for (const location of [
  "loose-file",
  "loose-directory",
  "pack-file",
  "pack-index",
  "pack-directory",
  "loose-hardlink",
  "pack-hardlink",
] as const) {
  test(`Git denies ${location} object storage links, including after an earlier valid read`, async () => {
    init();
    const ws = new WorkspaceAccess([root]).directory(root);
    let target: string;
    if (location.startsWith("pack")) {
      git("repack", "-ad");
      const packs = join(root, ".git/objects/pack");
      target =
        location === "pack-directory"
          ? packs
          : join(
              packs,
              readdirSync(packs).find((p) =>
                p.endsWith(location === "pack-index" ? ".idx" : ".pack"),
              )!,
            );
    } else {
      const oid = git("rev-parse", "HEAD:public.txt");
      target = join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
      if (location === "loose-directory") target = dirname(target);
    }
    expect((await ws.history().read({ filePath: "public.txt" })).content).toBe(
      "OBJECT_SENTINEL",
    );
    const outside = join(base, "external-object");
    renameSync(target, outside);
    if (location.endsWith("hardlink")) linkSync(outside, target);
    else symlinkSync(outside, target);
    // Git itself accepts the redirected valid storage; the access layer must refuse it.
    expect(git("show", "HEAD:public.txt")).toBe("OBJECT_SENTINEL");
    await expect(ws.history().read({ filePath: "public.txt" })).rejects.toThrow(
      "GIT_STORAGE_LINK_DENIED",
    );
    await expect(ws.status()).rejects.toThrow("GIT_STORAGE_LINK_DENIED");
    await expect(ws.diff()).rejects.toThrow("GIT_STORAGE_LINK_DENIED");
    expect((await ws.info()).gitError).toBe("GIT_STORAGE_LINK_DENIED");
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "exec",
        arguments: {
          command: `git_read_file --path '${root}' --filePath public.txt`,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("GIT_STORAGE_LINK_DENIED");
      expect(JSON.stringify(result)).not.toContain("OBJECT_SENTINEL");
    });
  });
}

for (const name of [".gitignore", ".convorelignore"]) {
  for (const [kind, bytes] of [
    ["NUL", Buffer.from("private.txt\0suffix\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["control bytes", Buffer.from("private.txt\x01\n")],
  ] as const) {
    test(`${name} rejects ${kind} through artifact, exec and workspace discovery`, async () => {
      init();
      put("private.txt", "POLICY_SENTINEL");
      put(name, bytes);
      if (kind === "NUL" && name === ".gitignore")
        expect(git("check-ignore", "private.txt")).toBe("private.txt");
      const ws = new Workspace(root);
      await expect(ws.read("private.txt")).rejects.toThrow("POLICY_UNREADABLE");
      await expect(ws.list()).rejects.toThrow("POLICY_UNREADABLE");
      await expect(ws.search("POLICY_SENTINEL")).rejects.toThrow(
        "POLICY_UNREADABLE",
      );
      await expect(
        ws.history().read({ filePath: "public.txt" }),
      ).rejects.toThrow("POLICY_UNREADABLE");
      await withClient(async (client) => {
        expect(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
        ).toEqual(["artifact", "capabilities", "exec", "memory"]);
        for (const call of [
          {
            name: "artifact",
            arguments: { kind: "text", path: join(root, "private.txt") },
          },
          {
            name: "exec",
            arguments: { command: `read_file --path '${root}/private.txt'` },
          },
        ]) {
          const result = await client.callTool(call);
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("POLICY_UNREADABLE");
          expect(JSON.stringify(result)).not.toContain("POLICY_SENTINEL");
        }
      });
    });
  }
}

test("valid UTF-8 BOM and CRLF policies retain Git semantics, and malformed historical policy denies reads", async () => {
  init();
  put(".gitignore", "\uFEFFprivate.txt\r\n# 注释\r\n");
  put("private.txt", "HIDDEN");
  expect(git("check-ignore", "private.txt")).toBe("private.txt");
  const ws = new Workspace(root);
  await expect(ws.read("private.txt")).rejects.toThrow("ACCESS_DENIED");
  expect((await ws.read("public.txt")).content).toBe("OBJECT_SENTINEL");
  put(".gitignore", "private.txt\0suffix\n");
  git("add", "-f", ".gitignore", "private.txt");
  git("commit", "-qm", "malformed historical policy");
  put(".gitignore", "");
  await expect(ws.history().read({ filePath: "private.txt" })).rejects.toThrow(
    "POLICY_UNREADABLE",
  );
});

function conflict() {
  init();
  put("conflict.txt", "base\n");
  put("other.txt", "old\n");
  put(".env", "SECRET_BASE\n");
  git("add", "-f", "conflict.txt", "other.txt", ".env");
  git("commit", "-qm", "base conflict");
  git("checkout", "-qb", "side");
  put("conflict.txt", "theirs\n");
  put(".env", "SECRET_THEIRS\n");
  git("commit", "-qam", "side");
  git("checkout", "main");
  put("conflict.txt", "ours\n");
  put(".env", "SECRET_OURS\n");
  git("commit", "-qam", "main");
  expect(gitResult("merge", "--no-edit", "side").exitCode).toBe(1);
  put("other.txt", "new\n");
}

test("default and staged diff provide unique unmerged status and stage evidence while ordinary patches stay usable", async () => {
  conflict();
  const ws = new Workspace(root);
  expect((await ws.status()).entries).toContainEqual({
    path: "conflict.txt",
    change: "UU",
  });
  for (const mode of ["unstaged", "staged"] as const) {
    const result = await ws.diff(mode);
    expect(result.files.filter((file) => file.path === "conflict.txt")).toEqual(
      [{ path: "conflict.txt", previousPath: null, change: "U" }],
    );
    expect(result.patchFile).toBe("conflict.txt");
    expect(result.diff).toContain("Unmerged");
    for (const stage of [1, 2, 3])
      expect(result.diff).toContain(git("rev-parse", `:${stage}:conflict.txt`));
    expect(JSON.stringify(result)).not.toContain("SECRET_");
    expect(JSON.stringify(result)).not.toContain('"path":".env"');
  }
  expect(
    (await ws.diff("unstaged", { patchFile: "other.txt" })).diff,
  ).toContain("+new");
  expect((await ws.diff("head", { patchFile: "conflict.txt" })).diff).toContain(
    "<<<<<<<",
  );
  const first = await ws.diff("unstaged", { limit: 1 });
  expect(first.nextOffset).toBe(1);
  expect(
    (await ws.diff("unstaged", { offset: first.nextOffset!, limit: 1 }))
      .patchFile,
  ).toBe("other.txt");
  const suffix = await ws.diff("unstaged", {
    patchFile: "conflict.txt",
    patchOffset: 12,
  });
  expect(suffix.patchSha256).toBe(first.patchSha256);
  expect(suffix.diff).toBe(first.diff.slice(12));
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "exec",
      arguments: { command: `git diff --path '${root}'` },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("Unmerged");
    expect(JSON.stringify(result)).not.toContain("SECRET_");
  });
  git("add", "conflict.txt");
  expect(
    (await ws.diff("staged", { patchFile: "conflict.txt" })).diff,
  ).toContain("+<<<<<<<");
});

test("object storage refuses special files and bounded-depth overflow before Git reads", async () => {
  init();
  const objects = join(root, ".git/objects");
  const fifo = join(objects, "pack/unsafe.pipe");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  await expect(new Workspace(root).status()).rejects.toThrow(
    "GIT_STORAGE_NOT_REGULAR",
  );
  rmSync(fifo);
  mkdirSync(join(objects, ...Array(9).fill("nested")), { recursive: true });
  await expect(new Workspace(root).status()).rejects.toThrow(
    "GIT_STORAGE_SCAN_LIMIT",
  );
});

test("ordinary many-object repositories remain readable before and after packing", async () => {
  init();
  mkdirSync(join(root, "sources"));
  for (let i = 0; i < 1500; i++)
    put(`sources/${i}.txt`, `unique fixture ${i}\n`);
  git("add", "sources");
  git("commit", "-qm", "many loose objects");
  const ws = new Workspace(root);
  expect(
    (await ws.history().read({ filePath: "sources/1499.txt" })).content,
  ).toBe("unique fixture 1499");
  expect((await ws.status()).dirty).toBe(false);
  // This fixture exercises packed reads, not garbage collection/expiry.
  git("repack", "-ad");
  expect(
    readdirSync(join(root, ".git/objects/pack")).some((name) =>
      name.endsWith(".pack"),
    ),
  ).toBe(true);
  expect(
    (await ws.history().read({ filePath: "sources/1499.txt" })).content,
  ).toBe("unique fixture 1499");
  expect((await ws.diff()).files).toEqual([]);
});

test("delete/modify conflicts retain missing stage semantics and quoted filenames", async () => {
  init();
  const path = 'conflict\n"quoted".txt';
  put(path, "base\n");
  git("add", path);
  git("commit", "-qm", "base");
  git("checkout", "-qb", "side");
  put(path, "theirs\n");
  git("commit", "-qam", "modify");
  git("checkout", "main");
  git("rm", path);
  git("commit", "-qm", "delete");
  expect(gitResult("merge", "--no-edit", "side").exitCode).toBe(1);
  const ws = new Workspace(root);
  for (const mode of ["unstaged", "staged"] as const) {
    const result = await ws.diff(mode);
    expect(result.files).toEqual([{ path, previousPath: null, change: "U" }]);
    expect(result.diff).toContain(JSON.stringify(path));
    expect(result.diff).toContain("base (stage 1)");
    expect(result.diff).toContain("theirs (stage 3)");
    expect(result.diff).not.toContain("ours (stage 2)");
    expect(result.diff).toContain(git("rev-parse", `:3:${path}`));
  }
});
