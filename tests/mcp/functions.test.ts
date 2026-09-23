import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function fixture(withDependencies = false) {
  const dir = mkdtempSync(join(tmpdir(), "convorel-functions-test-"));
  const root = join(dir, "project"),
    config = join(dir, "config"),
    state = join(dir, "state");
  mkdirSync(root);
  mkdirSync(config);
  if (withDependencies) mkdirSync(join(root, "node_modules"));
  const memoryRoot = "viking://user/test/memories/project";
  const backend = join(dir, "ov-fixture");
  writeFileSync(
    backend,
    `#!${process.execPath}\nconst a=process.argv.slice(2); console.log(JSON.stringify({ok:true,result:a[0]==="read"?"shared memory":{memories:[{uri:${JSON.stringify(memoryRoot + "/shared fact.md")},abstract:"shared fact",score:0.9},{uri:"viking://user/test/memories/private/secret.md",abstract:"PRIVATE_SENTINEL",score:1}],resources:[],skills:[]}}));`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(config, "preferences.json"),
    JSON.stringify({
      version: 1,
      values: {
        "mcp.memoryRoots": JSON.stringify([memoryRoot]),
        "mcp.memoryExecutable": backend,
        ...(withDependencies
          ? {
              "mcp.execDependencyRoots": JSON.stringify([
                join(root, "node_modules"),
              ]),
            }
          : {}),
      },
    }),
  );
  const put = (path: string, content: string) =>
    writeFileSync(join(root, path), content);
  put(
    "package.json",
    JSON.stringify({
      packageManager: "bun@1.4.2",
      scripts: {
        build: "bun build.ts",
        test: "bun test",
        "test:hang": "bun hang.ts",
        "test:fail": "exit 7",
        "test:noise": "bun noise.ts",
      },
    }),
  );
  put(".env", "SECRET_SENTINEL=hidden");
  put("report.txt", "line one\nline two\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-env-file",
      join(import.meta.dir, "../../src/cli.ts"),
      "--config-dir",
      config,
      "--state-dir",
      state,
      "mcp",
      "serve",
      "--roots",
      JSON.stringify([root]),
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "functions-test", version: "1" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  return {
    dir,
    root,
    state,
    memoryRoot,
    put,
    tools,
    client,
    call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await transport.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("four public functions expose complete schemas and reject command injection and artifact escapes", async () => {
  const f = await fixture();
  try {
    expect(f.tools.map((tool) => tool.name).sort()).toEqual([
      "artifact",
      "capabilities",
      "exec",
      "memory",
    ]);
    expect(
      f.tools.find((tool) => tool.name === "exec")!.annotations!.readOnlyHint,
    ).toBe(false);
    const cap = await f.call("capabilities", { path: f.root });
    expect(cap.isError).not.toBe(true);
    expect((cap.structuredContent as any).execution.buildsAndTests).toBe(true);
    for (const command of [
      "rm --path /tmp",
      "git status --path /tmp; id",
      "git status $(id)",
      "git status > out",
      "git status | cat",
      "git status\nid",
      "read_file --path $HOME",
      "bun run build && id",
      "bun -e 'console.log(1)'",
      "bun run build --watch",
    ]) {
      expect((await f.call("exec", { command, cwd: f.root })).isError).toBe(
        true,
      );
    }
    const report = await f.call("artifact", {
      kind: "text",
      path: join(f.root, "report.txt"),
      startLine: 2,
      maxLines: 1,
    });
    expect((report.structuredContent as any).artifact.result.content).toBe(
      "line two",
    );
    for (const path of [join(f.root, ".env"), "/etc/passwd"])
      expect((await f.call("artifact", { kind: "text", path })).isError).toBe(
        true,
      );
    expect(
      (
        await f.call("exec", {
          command: `read_file --path '${join(f.root, "report.txt")}' --unknown 1`,
        })
      ).isError,
    ).toBe(true);
    f.put(
      "package.json",
      JSON.stringify({ scripts: { build: "echo should-not-run" } }),
    );
    f.put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const wrongManager = await f.call("exec", {
      command: "bun run build",
      cwd: f.root,
    });
    expect(wrongManager.isError).toBe(true);
    expect(JSON.stringify(wrongManager)).toContain(
      "EXEC_PACKAGE_MANAGER_UNSUPPORTED",
    );
  } finally {
    await f.close();
  }
}, 20000);

test("explicit dependency grants are read-only and never bypass file policy", async () => {
  const f = await fixture(true);
  try {
    f.put("node_modules/value.js", "export default 42;");
    f.put(
      "build.ts",
      `import value from './node_modules/value.js';
import {writeFileSync} from 'node:fs';
if(value!==42) throw Error('dependency missing');
let denied=false;try{writeFileSync('node_modules/value.js','changed')}catch{denied=true}
if(!denied) throw Error('dependency writable'); console.log('DEPENDENCY_OK');`,
    );
    const result = await f.call("exec", {
      command: "bun run build",
      cwd: f.root,
    });
    expect((result.structuredContent as any).execution.result.exitCode).toBe(0);
    expect((result.structuredContent as any).execution.result.stdout).toContain(
      "DEPENDENCY_OK",
    );
    expect(
      (
        await f.call("artifact", {
          kind: "text",
          path: join(f.root, "node_modules/value.js"),
        })
      ).isError,
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 20000);

test("client cancellation releases the running sandbox so another execution can start", async () => {
  const f = await fixture();
  try {
    f.put("hang.ts", "console.log('started');setInterval(()=>{},1000);");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await expect(
        f.client.callTool(
          {
            name: "exec",
            arguments: { command: "bun run test:hang", cwd: f.root },
          },
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    let result: any;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await f.call("exec", {
        command: "bun run test:fail",
        cwd: f.root,
      });
      if (!JSON.stringify(result).includes("EXEC_BUSY")) break;
      await Bun.sleep(50);
    }
    expect(result.structuredContent.execution.result.exitCode).toBe(7);
  } finally {
    await f.close();
  }
}, 20000);

test("memory enforces explicit URI scope and filters out-of-scope backend hits", async () => {
  const f = await fixture();
  try {
    const search = await f.call("memory", {
      action: "search",
      uri: f.memoryRoot,
      query: "fact",
    });
    expect(search.isError).not.toBe(true);
    expect((search.structuredContent as any).matches).toHaveLength(1);
    expect(JSON.stringify(search)).not.toContain("PRIVATE_SENTINEL");
    const read = await f.call("memory", {
      action: "read",
      uri: f.memoryRoot + "/shared fact.md",
    });
    expect((read.structuredContent as any).content).toBe("shared memory");
    for (const uri of [
      f.memoryRoot + "-private/fact.md",
      f.memoryRoot + "/../private/fact.md",
      f.memoryRoot + "/%2e%2e/private",
      "viking://~/memories",
      "viking://user/test/memories",
    ])
      expect((await f.call("memory", { action: "read", uri })).isError).toBe(
        true,
      );
  } finally {
    await f.close();
  }
}, 20000);

test("real sandbox builds and tests without exposing secrets, network or host writes", async () => {
  const f = await fixture();
  try {
    f.put(
      "build.ts",
      `import {existsSync,writeFileSync} from 'node:fs';
if(existsSync('.env')||existsSync(${JSON.stringify(join(f.root, ".env"))})||existsSync('/home/mocha')) throw Error('host exposed');
let blocked=false; try { await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(500)}); } catch { blocked=true; }
if(!blocked) throw Error('network exposed');
writeFileSync('generated.txt','built'); console.log('BUILD_OK');`,
    );
    f.put(
      "sample.test.ts",
      `import {test,expect} from 'bun:test';test('arithmetic',()=>expect(2+2).toBe(4));`,
    );
    for (const command of ["bun run build", "bun test"]) {
      const result = await f.call("exec", { command, cwd: f.root });
      expect(result.isError).not.toBe(true);
      const data = (result.structuredContent as any).execution.result;
      expect(data.exitCode as number | null, String(data.stderr)).toBe(0);
      expect(data.timedOut).toBe(false);
      expect(data.inputSha256).toHaveLength(64);
      expect(JSON.stringify(data)).not.toContain("SECRET_SENTINEL");
    }
    expect(existsSync(join(f.root, "generated.txt"))).toBe(false);
    expect(readdirSync(join(f.state, "executions"))).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20000);

test("sandbox returns failures and terminates timed out work with bounded output", async () => {
  const f = await fixture();
  try {
    f.put("hang.ts", "setInterval(()=>{},1000);");
    f.put("noise.ts", "console.log('x'.repeat(50000));");
    const fail = await f.call("exec", {
      command: "bun run test:fail",
      cwd: f.root,
    });
    expect(
      (fail.structuredContent as any).execution.result.exitCode,
      JSON.stringify(fail.structuredContent),
    ).toBe(7);
    const hang = await f.call("exec", {
      command: "bun run test:hang",
      cwd: f.root,
      timeoutSeconds: 1,
    });
    expect((hang.structuredContent as any).execution.result.timedOut).toBe(
      true,
    );
    const noise = await f.call("exec", {
      command: "bun run test:noise",
      cwd: f.root,
    });
    expect(
      (noise.structuredContent as any).execution.result.outputLimited,
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(noise.structuredContent)),
    ).toBeLessThan(65536);
  } finally {
    await f.close();
  }
}, 20000);
