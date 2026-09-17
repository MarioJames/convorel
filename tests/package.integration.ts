// Real local tarball installation, including spaces and an unrelated working directory.
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnv } from "../src/command.ts";
const source = resolve(import.meta.dir, "..");
const pkg = await Bun.file(join(source, "package.json")).json();
const temp = mkdtempSync(join(tmpdir(), "package acceptance "));
const env = childEnv();
async function run(args: string[], cwd: string) {
  console.error("Checking:", args.slice(1, 3).join(" "));
  const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGTERM"), 120000);
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  assert.equal(code, 0, err || out);
  return out;
}
try {
  const archives = join(temp, "archives"),
    consumer = join(temp, "consumer project"),
    workspace = join(temp, "code root"),
    skills = join(temp, "installed skills");
  for (const path of [archives, consumer, workspace]) mkdirSync(path);
  await run(
    [process.execPath, "pm", "pack", "--destination", archives],
    source,
  );
  const archive = join(
    archives,
    readdirSync(archives).find((f) => f.endsWith(".tgz"))!,
  );
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "acceptance-fixture",
      private: true,
      type: "module",
      trustedDependencies: ["agent-browser"],
    }),
  );
  await run([process.execPath, "add", "--prefer-offline", archive], consumer);
  const installed = join(consumer, "node_modules", pkg.name),
    cli = join(installed, "src/cli.ts");
  assert.match(
    await Bun.file(join(installed, ".env.example")).text(),
    /^CONVOREL_TUNNEL_API_KEY=$/m,
  );
  assert.match(
    await run([process.execPath, "--no-env-file", cli, "--help"], temp),
    /review start/,
  );
  await run(
    [
      process.execPath,
      "--no-env-file",
      cli,
      "skill",
      "install",
      "--dir",
      skills,
    ],
    temp,
  );
  assert.match(
    await run(
      [
        process.execPath,
        "--no-env-file",
        join(skills, pkg.name, "scripts/convorel.ts"),
        "--help",
      ],
      temp,
    ),
    /review start/,
  );
  // Resolve the browser controller from the installed artifact and run its native version path.
  const browserVersion = await run(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import {command} from ${JSON.stringify(join(installed, "src/command.ts"))}; console.log(await command(['agent-browser','--version']));`,
    ],
    temp,
  );
  assert.match(browserVersion, /agent-browser 0\.34\.0/);
  writeFileSync(join(workspace, "proof.txt"), "packaged MCP evidence\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-env-file",
      cli,
      "mcp",
      "serve",
      "--roots",
      JSON.stringify([workspace]),
    ],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "package-acceptance", version: "1" });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: join(workspace, "proof.txt") },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /packaged MCP evidence/);
  } finally {
    await client.close();
    await transport.close();
  }
  await run(
    [
      process.execPath,
      "--no-env-file",
      cli,
      "skill",
      "uninstall",
      "--dir",
      skills,
    ],
    temp,
  );
  console.log(
    JSON.stringify({
      passed: true,
      package: pkg.name,
      checks: [
        "tarball install",
        "space paths",
        "non-project cwd",
        "skill wrapper",
        "packaged agent-browser",
        "SDK stdio read",
      ],
    }),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
