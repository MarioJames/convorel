// Offline acceptance for the released artifact: build, install.sh, then drive the
// installed standalone executable exactly as a user would. No network, no Chrome.
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { childEnv } from "../../src/process.ts";
import { verifyUpgrade } from "./upgrade.integration.ts";
const source = resolve(import.meta.dir, "../..");
const pkg = await Bun.file(join(source, "package.json")).json();
const platform = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const temp = mkdtempSync(join(tmpdir(), "convorel install acceptance "));
const home = join(temp, "home"),
  prefix = join(temp, "lib"),
  bin = join(temp, "bin"),
  state = join(temp, "state"),
  workspace = join(temp, "code"),
  shared = join(temp, "shared"),
  env: Record<string, string> = {
    ...childEnv(),
    HOME: home,
  };
// A custom preferences directory proves selfExec forwards global path flags.
const preferences = join(temp, "prefs");
const cliArgs = [
  join(bin, "convorel"),
  "--config-dir",
  preferences,
  "--state-dir",
  state,
];
for (const directory of [home, workspace, shared]) mkdirSync(directory);
const controller = join(
  source,
  "node_modules/agent-browser/bin",
  `agent-browser-${platform}`,
);
const controllerBin = join(temp, "controller");
mkdirSync(controllerBin);
symlinkSync(controller, join(controllerBin, "agent-browser"));
env.PATH = `${controllerBin}:${env.PATH ?? ""}`;
// Prove uninstall never reaches conversation state, preferences or skills.
mkdirSync(join(home, ".local/share/convorel"), { recursive: true });
writeFileSync(join(home, ".local/share/convorel/keep.json"), "{}\n");
async function run(
  args: string[],
  options: {
    env?: Record<string, string>;
    failure?: boolean;
    cwd?: string;
  } = {},
) {
  const process_ = Bun.spawn(args, {
    cwd: options.cwd ?? temp,
    env: { ...env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  if (options.failure) {
    assert.notEqual(code, 0, `Expected failure: ${args.join(" ")}`);
    return out + err;
  }
  assert.equal(code, 0, err || out);
  return out;
}
const installer = (...args: string[]) => [
  "bash",
  join(source, "install.sh"),
  ...args,
];
try {
  await run(
    [process.execPath, "--no-env-file", "run", "dist", `bun-${platform}`],
    { cwd: source, env: { ...childEnv(), HOME: home } },
  );
  const dist = join(source, "dist");
  const artifacts = readdirSync(dist).filter((f) => f.endsWith(".tar.gz"));
  assert.equal(
    artifacts.length,
    1,
    "expected one archive for this platform: " + artifacts.join(","),
  );
  const checksums = readFileSync(join(dist, "sha256sums.txt"), "utf8");
  assert.match(
    checksums,
    new RegExp("^[a-f0-9]{64}  " + artifacts[0].replaceAll(".", "\\."), "m"),
  );

  await run(
    installer("--dist-dir", dist, "--prefix", prefix, "--bin-dir", bin),
  );
  assert.equal((await run([...cliArgs, "--version"])).trim(), pkg.version);
  const reported = JSON.parse(await run([...cliArgs, "version"]));
  assert.equal(reported.version, pkg.version);
  assert.equal(reported.runtime, "standalone");
  assert.equal(existsSync(join(bin, "agent-browser")), false);
  assert.equal(
    statSync(reported.browserController).ino,
    statSync(controller).ino,
  );

  await verifyUpgrade(run, prefix, bin, dist);

  // Preferences resolve for the child the CLI re-enters, and for a standalone
  // MCP server that is given no roots of its own.
  await run([
    ...cliArgs,
    "config",
    "set",
    "mcp.roots",
    JSON.stringify([shared]),
  ]);
  writeFileSync(join(shared, "proof.txt"), "installed artifact evidence\n");
  await run([...cliArgs, "config", "set", "model", "6 Pro"]);
  const initialized = JSON.parse(
    await run([...cliArgs, "init", "--workspace", workspace, "--cdp", "9223"]),
  );
  assert.equal(initialized.modelPolicy, "6 Pro");
  const queued = JSON.parse(
    await run([
      ...cliArgs,
      "conversation",
      "create",
      "--id",
      "offline-queue",
      "--prompt",
      "Persist before opening a browser",
    ]),
  );
  assert.equal(queued.summary.nextAction, "start");
  assert.ok(existsSync(join(state, "tasks.db")));
  assert.equal(existsSync(join(state, "task-offline-queue.json")), false);
  const saved = JSON.parse(
    await run([
      ...cliArgs,
      "conversation",
      "status",
      "--id",
      queued.id,
      "--run",
      queued.currentRun,
    ]),
  );
  assert.equal(saved.runs[0].prompt, queued.runs[0].prompt);
  const legacy = { ...queued, id: "legacy-queue" };
  const legacyBytes = JSON.stringify(legacy);
  writeFileSync(join(state, "task-legacy-queue.json"), legacyBytes);
  const migrated = JSON.parse(
    await run([...cliArgs, "conversation", "migrate", "--id", legacy.id]),
  );
  assert.equal(migrated.migrated, true);
  assert.equal(
    JSON.parse(
      await run([...cliArgs, "conversation", "migrate", "--id", legacy.id]),
    ).alreadyStored,
    true,
  );
  assert.equal(
    readFileSync(join(state, "task-legacy-queue.json"), "utf8"),
    legacyBytes,
  );
  const doctor = await run([...cliArgs, "doctor"], {
    failure: true,
  });
  const report = JSON.parse(doctor);
  assert.match(report.agentBrowser, /agent-browser 0\.34\.0/);
  assert.equal(report.localMcp.status, "verified");
  assert.equal(report.localMcp.tools.length, 12);
  assert.deepEqual(
    report.localMcp.roots.map((root: any) => root.path),
    [shared],
  );
  // A dead CDP endpoint must be reported, never mistaken for a crash.
  assert.equal(report.browser.status, "failed");
  assert.match(doctor, /CDP_UNAVAILABLE/);

  const mcp = Bun.spawn([...cliArgs, "mcp", "serve"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  mcp.stdin.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"acceptance","version":"1"}}}\n',
  );
  const hello = await mcp.stdout.getReader().read();
  mcp.kill("SIGKILL");
  await mcp.exited;
  assert.match(
    new TextDecoder().decode(hello.value),
    /"serverInfo":\{"name":"convorel"/,
    "a bare mcp serve must resolve roots from the forwarded preferences directory",
  );

  const skillOutput = JSON.parse(
    await run([
      ...cliArgs,
      "skills",
      "install",
      "--agent",
      "codex,claude-code",
    ]),
  );
  assert.equal(skillOutput.files.length, 7);
  for (const file of skillOutput.files)
    assert.equal(
      readFileSync(join(home, ".agents/skills/chatgpt-review", file), "utf8"),
      readFileSync(join(source, "skills/chatgpt-review", file), "utf8"),
      `installed skill asset differs: ${file}`,
    );
  assert.equal(
    readFileSync(join(home, ".claude/skills/chatgpt-review/SKILL.md"), "utf8")
      .length > 0,
    true,
  );

  const customSkills = join(temp, "custom skills");
  const custom = JSON.parse(
    await run([...cliArgs, "skills", "install", "--dir", customSkills]),
  );
  assert.deepEqual(custom.paths, [join(customSkills, "chatgpt-review")]);
  for (const file of custom.files)
    assert.equal(
      readFileSync(join(custom.paths[0], file), "utf8"),
      readFileSync(join(source, "skills/chatgpt-review", file), "utf8"),
    );
  assert.match(
    await run([...cliArgs, "skills", "install", "--dir", customSkills], {
      failure: true,
    }),
    /SKILL_ALREADY_EXISTS/,
  );

  // Exercise compiled selfExec and detached supervision without contacting a real tunnel.
  const tunnelClient = join(bin, "tunnel-client");
  writeFileSync(
    tunnelClient,
    `#!/bin/sh\ntrap 'exit 0' TERM INT\nprintf 'standalone client ready\\n'\nwhile :; do sleep 1; done\n`,
    { mode: 0o700 },
  );
  const preferenceFile = join(preferences, "preferences.json");
  const stored = JSON.parse(readFileSync(preferenceFile, "utf8"));
  stored.values["tunnel.id"] = "tunnel_" + "a".repeat(32);
  stored.values["tunnel.apiKey"] = "fixture-key";
  writeFileSync(preferenceFile, JSON.stringify(stored));
  const serviceEnv = { PATH: bin + ":" + env.PATH };
  const service = (action: string) =>
    run([...cliArgs, action], { env: serviceEnv });
  try {
    const started = JSON.parse(await service("start"));
    assert.equal(started.running, true);
    assert.equal(JSON.parse(await service("start")).alreadyRunning, true);
    assert.equal(JSON.parse(await service("status")).running, true);
    assert.match(await service("logs"), /standalone client ready/);
    const restarted = JSON.parse(await service("restart"));
    assert.equal(restarted.running, true);
    assert.notEqual(restarted.client.pid, started.client.pid);
  } finally {
    await service("stop");
  }
  assert.equal(JSON.parse(await service("status")).running, false);
  rmSync(tunnelClient);

  const backup = readFileSync(join(dist, "sha256sums.txt"), "utf8");
  writeFileSync(
    join(dist, "sha256sums.txt"),
    backup.replace(/^.{64}/m, "0".repeat(64)),
  );
  assert.match(
    await run(
      installer("--dist-dir", dist, "--prefix", prefix, "--bin-dir", bin),
      {
        failure: true,
      },
    ),
    /CHECKSUM_MISMATCH/,
  );
  writeFileSync(join(dist, "sha256sums.txt"), backup);

  assert.match(
    await run(
      installer("--dist-dir", dist, "--prefix", prefix, "--bin-dir", bin),
    ),
    new RegExp(`installed convorel ${pkg.version}`),
  );
  await run(installer("--uninstall", "--prefix", prefix, "--bin-dir", bin));
  assert.equal(existsSync(join(bin, "convorel")), false);
  assert.equal(existsSync(prefix), false);
  assert.ok(existsSync(join(home, ".local/share/convorel/keep.json")));
  assert.ok(existsSync(join(preferences, "preferences.json")));
  assert.ok(existsSync(join(home, ".agents/skills/chatgpt-review/SKILL.md")));
  console.log(
    JSON.stringify({
      passed: true,
      platform,
      checks: [
        "standalone archive without a bundled browser controller",
        "offline install from a local directory",
        "standalone version check, upgrade, failure preservation and retained releases",
        "config preferences read back by a re-entered MCP child",
        "doctor reports a dead CDP endpoint without crashing",
        "installed skill assets are byte identical",
        "custom skill directory and repeat-install protection",
        "standalone detached start/status/logs/restart/stop",
        "checksum tampering is refused",
        "reinstall and uninstall keep state, preferences and skills",
      ],
    }),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
