// The standalone updater embeds the installer so install and upgrade share one
// checksum, archive validation and rollback protocol, with no downloaded scripts.
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { COMPILED } from "./runtime.ts";
import { childEnv } from "./command.ts";
import packageInfo from "../package.json";
// @ts-expect-error Bun's text loader embeds the shell script in standalone builds.
import installer from "../install.sh" with { type: "text" };

const releases = () =>
  (
    process.env.CONVOREL_RELEASE_BASE_URL ||
    "https://github.com/MarioJames/convorel/releases"
  ).replace(/\/$/, "");
export function platform() {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch))
    throw new Error(
      "PLATFORM_UNSUPPORTED: standalone releases require Linux x64 or arm64",
    );
  return `linux-${process.arch}`;
}
const validVersion =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/;

/** The checksum list names the artifact, so latest needs no release API. */
export async function releaseManifest(requested?: string) {
  const version = requested?.replace(/^v/, "");
  if (version !== undefined && !validVersion.test(version))
    throw new Error("VERSION_INVALID: expected a release version");
  const reference =
    version === undefined ? "latest/download" : `download/v${version}`;
  const response = await fetch(`${releases()}/${reference}/sha256sums.txt`, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `RELEASE_FETCH_FAILED: ${response.status} for ${reference}`,
    );
  const entries = (await response.text())
    .split("\n")
    .filter((entry) => entry.endsWith(`-${platform()}.tar.gz`));
  if (!entries.length)
    throw new Error(`ARTIFACT_MISSING: no ${platform()} build in ${reference}`);
  const match =
    entries.length === 1
      ? /^([a-f0-9]{64})\s+(convorel-([^/\s]+)-linux-(?:x64|arm64)\.tar\.gz)$/.exec(
          entries[0],
        )
      : null;
  if (!match || !validVersion.test(match[3]))
    throw new Error(
      "MANIFEST_INVALID: expected one safe artifact per platform",
    );
  if (version !== undefined && match[3] !== version)
    throw new Error(
      "VERSION_MISMATCH: manifest does not match requested version",
    );
  return {
    version: match[3],
    archive: match[2],
    sha256: match[1],
    url: `${releases()}/${reference}/${match[2]}`,
  };
}

export async function versionCheck() {
  const latest = await releaseManifest();
  return {
    latest: latest.version,
    upToDate: latest.version === packageInfo.version,
  };
}

// Use the same filesystem resolver as install.sh. Bun 1.4.2 realpath currently
// treats a Linux backslash in a path as a separator, unlike the kernel.
function realpathSync(path: string) {
  const result = Bun.spawnSync(["realpath", "-e", "--", path], {
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode)
    throw new Error("INSTALL_PATH_INVALID: cannot resolve installation path");
  return result.stdout.toString().replace(/\n$/, "");
}

/** Only installer-owned layouts are upgradable; source checkouts are never changed. */
export function installLayout() {
  if (!COMPILED)
    throw new Error(
      "UPGRADE_SOURCE_CHECKOUT: run git pull && bun install --frozen-lockfile in the checkout",
    );
  const executable = realpathSync(process.execPath);
  const current = dirname(dirname(executable));
  const versions = dirname(current);
  const installDir = dirname(versions);
  try {
    const layout = JSON.parse(
      readFileSync(join(installDir, "layout.json"), "utf8"),
    );
    if (
      basename(executable) !== "convorel" ||
      basename(dirname(executable)) !== "bin" ||
      basename(versions) !== "versions" ||
      realpathSync(versions) !== versions ||
      layout?.version !== 1 ||
      typeof layout.binDir !== "string" ||
      !isAbsolute(layout.binDir) ||
      realpathSync(layout.binDir) !== layout.binDir ||
      realpathSync(join(layout.binDir, "convorel")) !== executable
    )
      throw new Error("invalid layout");
    return { installDir, binDir: layout.binDir as string, current };
  } catch {
    throw new Error(
      `UPGRADE_LAYOUT_UNKNOWN: ${join(installDir, "layout.json")} does not describe the active installation; reinstall with install.sh`,
    );
  }
}

export async function upgrade(requested?: string) {
  const layout = installLayout();
  const manifest = await releaseManifest(requested);
  if (!requested && manifest.version === packageInfo.version)
    return { upgraded: false, upToDate: true, version: packageInfo.version };
  const process_ = Bun.spawn(
    [
      "bash",
      "-s",
      "--",
      "--version",
      manifest.version,
      "--prefix",
      layout.installDir,
      "--bin-dir",
      layout.binDir,
    ],
    {
      env: { ...childEnv(), CONVOREL_RELEASE_BASE_URL: releases() },
      stdin: new TextEncoder().encode(installer),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  if (code) throw new Error(`UPGRADE_FAILED: ${(err || out).slice(0, 1000)}`);
  return {
    upgraded: true,
    from: packageInfo.version,
    to: manifest.version,
    executable: join(layout.binDir, "convorel"),
    retained: layout.current,
  };
}
