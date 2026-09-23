// Real local tarball installation, including spaces and an unrelated working directory.
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnv } from "../../src/process.ts";
const source = resolve(import.meta.dir, "../..");
const pkg = await Bun.file(join(source, "package.json")).json();
const temp = mkdtempSync(join(tmpdir(), "package acceptance "));
// Dependency postinstall scripts may resolve `npm prefix -g` even for a local
// install. Isolate the package-manager home and prefix, not only skill installs.
const packageHome = join(temp, "package manager home");
mkdirSync(packageHome);
const env = {
  ...childEnv(),
  HOME: packageHome,
  npm_config_prefix: join(temp, "package manager prefix"),
  BUN_INSTALL_CACHE_DIR:
    process.env.BUN_INSTALL_CACHE_DIR ||
    join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install/cache"),
};
async function run(
  args: string[],
  cwd: string,
  options: { env?: Record<string, string>; failure?: boolean } = {},
) {
  console.error("Checking:", args.slice(1, 3).join(" "));
  const p = Bun.spawn(args, {
    cwd,
    env: options.env ?? env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGTERM"), 120000);
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  if (options.failure) {
    assert.notEqual(code, 0, "Expected command to reject the operation");
    return out + err;
  }
  assert.equal(code, 0, err || out);
  return out;
}
try {
  const archives = join(temp, "archives"),
    consumer = join(temp, "consumer project"),
    workspace = join(temp, "code root");
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
  const skillFiles = [
    "SKILL.md",
    "agents/openai.yaml",
    "references/convorel.md",
    "references/herdr.md",
    "references/proactive-review.md",
    "references/review-prompt.md",
    "references/result-review.md",
  ];
  for (const file of skillFiles) {
    const relative = join("skills/chatgpt-review", file);
    assert.equal(
      await Bun.file(join(installed, relative)).text(),
      await Bun.file(join(source, relative)).text(),
      `Packaged skill asset differs: ${relative}`,
    );
  }
  assert.match(
    await run([process.execPath, "--no-env-file", cli, "--help"], temp),
    /conversation start/,
  );
  // Install the packaged skill without init, isolated from the user's Agent homes.
  const skillHome = join(temp, "skill user home");
  mkdirSync(skillHome);
  const skillEnv = {
    ...env,
    HOME: skillHome,
  };
  const installArgs = [
    process.execPath,
    "--no-env-file",
    cli,
    "skills",
    "install",
    "--agent",
    "codex,claude-code",
  ];
  await run(installArgs, temp, { env: skillEnv });
  const canonicalSkill = join(skillHome, ".agents/skills/chatgpt-review"),
    claudeSkill = join(skillHome, ".claude/skills/chatgpt-review");
  assert.equal(realpathSync(claudeSkill), realpathSync(canonicalSkill));
  assert.equal(existsSync(join(skillHome, ".local/share/convorel")), false);
  const installedSkillContents = new Map<string, string>();
  for (const file of skillFiles) {
    const expected = await Bun.file(
      join(installed, "skills/chatgpt-review", file),
    ).text();
    for (const skill of [canonicalSkill, claudeSkill]) {
      assert.equal(
        await Bun.file(join(skill, file)).text(),
        expected,
        `Installed skill asset differs: ${join(skill, file)}`,
      );
    }
    installedSkillContents.set(file, expected);
  }
  // A personal edit must survive a rejected repeated installation.
  const personalEntry =
    installedSkillContents.get("SKILL.md")! + "\nPersonal review guidance.\n";
  writeFileSync(join(canonicalSkill, "SKILL.md"), personalEntry);
  installedSkillContents.set("SKILL.md", personalEntry);
  assert.match(
    await run(installArgs, temp, { env: skillEnv, failure: true }),
    /SKILL_ALREADY_EXISTS/,
  );
  assert.equal(realpathSync(claudeSkill), realpathSync(canonicalSkill));
  for (const [file, expected] of installedSkillContents) {
    assert.equal(await Bun.file(join(canonicalSkill, file)).text(), expected);
    assert.equal(await Bun.file(join(claudeSkill, file)).text(), expected);
  }
  // Resolve the browser controller from the installed artifact and run its native version path.
  const browserVersion = await run(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import {command} from ${JSON.stringify(join(installed, "src/command.ts"))}; console.log(await command(['agent-browser','--version']));`,
    ],
    temp,
    {
      env: {
        ...env,
        PATH: `${join(consumer, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
    },
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
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 4);
    assert.ok(tools.every((tool) => tool.outputSchema?.type === "object"));
    const result = await client.callTool({
      name: "artifact",
      arguments: { kind: "text", path: join(workspace, "proof.txt") },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result), /packaged MCP evidence/);
  } finally {
    await client.close();
    await transport.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      package: pkg.name,
      checks: [
        "tarball install",
        "bundled chatgpt-review skill and references",
        "Codex and Claude skill installation with isolated HOME and no init",
        "Claude skill link and repeat-install overwrite protection",
        "space paths",
        "non-project cwd",
        "PATH agent-browser",
        "SDK stdio read",
      ],
    }),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
