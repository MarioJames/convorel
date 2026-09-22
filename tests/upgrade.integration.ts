// Local release server + actual installed standalone CLI; no public network or
// real user installation is touched. Also reused by test:install.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { childEnv } from "../src/command.ts";
import pkg from "../package.json";
const source = resolve(import.meta.dir, "..");
type Run = (
  args: string[],
  options?: { env?: Record<string, string>; failure?: boolean; cwd?: string },
) => Promise<string>;
export async function verifyInstallerLock() {
  const root = mkdtempSync(join(tmpdir(), "convorel-install-lock-"));
  for (const name of ["home", "tools", "tmp", "dist"])
    mkdirSync(join(root, name));
  const marker = join(root, "fetch-started");
  writeFileSync(
    join(root, "tools/curl"),
    `#!/bin/sh\nprintf ready > '${marker}'\nexec sleep 30\n`,
    { mode: 0o700 },
  );
  const env = {
    ...childEnv(),
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    PATH: join(root, "tools") + ":" + process.env.PATH,
  };
  const args = [
    join(source, "install.sh"),
    "--prefix",
    join(root, "prefix"),
    "--bin-dir",
    join(root, "bin"),
    "--release-base",
    "http://127.0.0.1:1/releases",
  ];
  const noFlock = join(root, "no-flock");
  mkdirSync(noFlock);
  symlinkSync(Bun.which("realpath")!, join(noFlock, "realpath"));
  assert.match(
    Bun.spawnSync([Bun.which("bash")!, ...args], {
      env: { ...env, PATH: noFlock },
      stdout: "pipe",
      stderr: "pipe",
    }).stderr.toString(),
    /INSTALL_LOCK_UNAVAILABLE/,
  );
  const installer = spawn("bash", args, {
    env,
    detached: true,
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve, reject) => {
    installer.once("exit", () => resolve());
    installer.once("error", reject);
  });
  const retry = () =>
    Bun.spawnSync(["bash", ...args, "--dist-dir", join(root, "dist")], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    for (let i = 0; i < 250 && !existsSync(marker); i++) await Bun.sleep(20);
    assert.ok(
      existsSync(marker),
      "installer reached the isolated download fixture",
    );
    assert.match(retry().stderr.toString(), /INSTALL_BUSY/);
    const uninstall = Bun.spawnSync(["bash", ...args, "--uninstall"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.match(
      uninstall.stderr.toString(),
      /INSTALL_BUSY/,
      "uninstall must respect an active installation",
    );
    assert.ok(existsSync(join(root, "prefix")));
    process.kill(-installer.pid!, "SIGKILL");
    await exited;
    const resumed = retry();
    assert.match(
      resumed.stderr.toString(),
      /CHECKSUMS_MISSING/,
      "a dead installer must not retain the lock",
    );
    assert.doesNotMatch(resumed.stderr.toString(), /INSTALL_BUSY/);
  } finally {
    try {
      process.kill(-installer.pid!, "SIGKILL");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}
export async function verifyUpgrade(
  run: Run,
  prefix: string,
  bin: string,
  dist: string,
) {
  await verifyInstallerLock();
  const artifact = readdirSync(dist).find((name) =>
    name.endsWith(`linux-${process.arch}.tar.gz`),
  )!;
  const checksums = readFileSync(join(dist, "sha256sums.txt"), "utf8");
  let manifest = checksums;
  const downloads: string[] = [];
  const fixture = mkdtempSync(join(tmpdir(), "convorel-release-fixture-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      downloads.push(path);
      if (path.endsWith("/sha256sums.txt")) return new Response(manifest);
      const name = path.split("/").pop()!;
      if (name === artifact)
        return new Response(Bun.file(join(dist, artifact)));
      if (existsSync(join(fixture, name)))
        return new Response(Bun.file(join(fixture, name)));
      return new Response("missing", { status: 404 });
    },
  });
  const config = join(fixture, "config");
  mkdirSync(config);
  writeFileSync(
    join(config, "preferences.json"),
    JSON.stringify({
      version: 1,
      values: { "release.baseUrl": server.url.toString() },
    }),
  );
  const cli = join(bin, "convorel");
  const cliArgs = [
    cli,
    "--config-dir",
    config,
    "--state-dir",
    join(fixture, "state"),
  ];
  const install = () =>
    run([
      "bash",
      join(source, "install.sh"),
      "--dist-dir",
      dist,
      "--prefix",
      prefix,
      "--bin-dir",
      bin,
    ]);
  const original = readlinkSync(cli);
  const before = readdirSync(join(prefix, "versions"));
  try {
    const check = JSON.parse(await run([...cliArgs, "version", "--check"]));
    assert.equal(check.latest, pkg.version);
    assert.equal(check.upToDate, true);
    const noop = JSON.parse(await run([...cliArgs, "upgrade"]));
    assert.equal(noop.upgraded, false);
    assert.equal(noop.skills.status, "check-required");
    assert.equal(readlinkSync(cli), original);
    assert.match(
      await run([...cliArgs, "upgrade", "--version", "../../escape"], {
        failure: true,
      }),
      /VERSION_INVALID/,
    );
    assert.match(
      await run(
        [
          process.execPath,
          "--no-env-file",
          join(source, "src/cli.ts"),
          "--config-dir",
          config,
          "--state-dir",
          join(fixture, "state"),
          "upgrade",
        ],
        { failure: true },
      ),
      /git pull/,
    );

    const upgraded = JSON.parse(
      await run([...cliArgs, "upgrade", "--version", `v${pkg.version}`]),
    );
    assert.equal(upgraded.upgraded, true);
    assert.equal(upgraded.skills.status, "check-required");
    assert.equal(upgraded.to, pkg.version);
    assert.notEqual(readlinkSync(cli), original);
    assert.ok(
      existsSync(original),
      "same-version overwrite preserves the running tree",
    );
    assert.equal(
      readdirSync(join(prefix, "versions")).length,
      before.length + 1,
    );
    assert.ok(downloads.includes(`/download/v${pkg.version}/${artifact}`));
    const active = readlinkSync(cli);
    manifest = checksums.replace(/^[a-f0-9]{64}/m, "0".repeat(64));
    assert.match(
      await run([...cliArgs, "upgrade", "--version", pkg.version], {
        failure: true,
      }),
      /CHECKSUM_MISMATCH/,
    );
    assert.equal(readlinkSync(cli), active);
    assert.equal((await run([...cliArgs, "--version"])).trim(), pkg.version);
    manifest = checksums;
    assert.match(
      await run([...cliArgs, "upgrade", "--version", "99.0.0"], {
        failure: true,
      }),
      /VERSION_MISMATCH/,
    );

    const layoutFile = join(prefix, "layout.json");
    const layout = readFileSync(layoutFile, "utf8");
    writeFileSync(
      layoutFile,
      JSON.stringify({ version: 1, binDir: "relative" }),
    );
    assert.match(
      await run([...cliArgs, "upgrade"], { failure: true }),
      /UPGRADE_LAYOUT_UNKNOWN/,
    );
    writeFileSync(layoutFile, layout);
    // A higher-version local release proves the no-argument upgrade selects
    // latest. The candidate's version probe is a tiny executable fixture.
    const next = "99.0.1-rc.1";
    const directory = `convorel-${next}-linux-${process.arch}`;
    mkdirSync(join(fixture, directory, "bin"), { recursive: true });
    writeFileSync(
      join(fixture, directory, "bin/convorel"),
      `#!/bin/sh\necho ${next}\n`,
      { mode: 0o755 },
    );
    await run([
      "tar",
      "-czf",
      join(fixture, directory + ".tar.gz"),
      "-C",
      fixture,
      directory,
    ]);
    manifest = `${createHash("sha256")
      .update(readFileSync(join(fixture, directory + ".tar.gz")))
      .digest("hex")}  ${directory}.tar.gz\n`;
    const available = JSON.parse(await run([...cliArgs, "version", "--check"]));
    assert.equal(available.latest, next);
    assert.equal(available.upToDate, false);
    const latest = JSON.parse(await run([...cliArgs, "upgrade"]));
    assert.equal(latest.to, next);
    assert.equal((await run([...cliArgs, "--version"])).trim(), next);
    assert.ok(existsSync(original) && existsSync(active));
    await install();
    assert.equal((await run([...cliArgs, "--version"])).trim(), pkg.version);
    assert.ok(existsSync(original) && existsSync(active));
    assert.equal(
      readdirSync(prefix).some(
        (name) => name.startsWith("parts") || name === ".install-lock",
      ),
      false,
    );
    assert.equal(
      readdirSync(bin).some((name) => name.startsWith(".convorel-links")),
      false,
    );
  } finally {
    server.stop(true);
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "convorel standalone upgrade "));
  const prefix = join(root, "custom prefix"),
    bin = join(root, 'bin "quoted" \\ path'),
    home = join(root, "home");
  mkdirSync(home);
  const env = {
    ...childEnv(),
    HOME: home,
  };
  const run: Run = async (args, options = {}) => {
    const child = Bun.spawn(args, {
      cwd: options.cwd ?? root,
      env: { ...env, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(
      code === 0,
      !options.failure,
      `${args.join(" ")}\n${out}\n${err}`,
    );
    return out + (options.failure ? err : "");
  };
  try {
    await run(
      [
        process.execPath,
        "--no-env-file",
        "run",
        "dist",
        `bun-linux-${process.arch}`,
      ],
      { cwd: source },
    );
    const dist = join(source, "dist");
    await run([
      "bash",
      join(source, "install.sh"),
      "--dist-dir",
      dist,
      "--prefix",
      prefix,
      "--bin-dir",
      bin,
    ]);
    await verifyUpgrade(run, prefix, bin, dist);
    console.log(
      JSON.stringify({
        passed: true,
        checks: [
          "compiled version check",
          "same-version reinstall",
          "latest upgrade",
          "checksum rollback",
          "manifest/path validation",
          "source guidance",
          "custom quoted and backslash paths",
          "all previous releases retained",
        ],
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
