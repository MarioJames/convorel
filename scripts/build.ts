#!/usr/bin/env bun
// Release artifacts for GitHub Releases: bun run dist [target,...]
// Each target becomes convorel-<version>-<platform>.tar.gz carrying the standalone
// executable. agent-browser is not included; init finds the one on PATH.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { childEnv } from "../src/command.ts";
const root = resolve(import.meta.dir, "..");
const out = join(root, "dist");
const pkg = await Bun.file(join(root, "package.json")).json();
const commit = process.env.GITHUB_SHA || "development";
const targets = (process.argv[2] || "bun-linux-x64,bun-linux-arm64")
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const checksums: string[] = [];
for (const target of targets) {
  if (!/^bun-linux-(x64|arm64)$/.test(target))
    throw new Error(
      `UNSUPPORTED_TARGET: ${target}; this release ships Linux glibc only`,
    );
  const platform = target.slice(4),
    directory = `convorel-${pkg.version}-${platform}`,
    staging = join(out, directory);
  mkdirSync(join(staging, "bin"), { recursive: true });
  mkdirSync(join(staging, "share/doc/convorel"), { recursive: true });
  // A relative --asset keeps the embedded tree at /$bunfs/root/skills.
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--target",
      target,
      "--no-compile-autoload-dotenv",
      "--compile-exec-argv=--no-env-file",
      "--asset=skills",
      "--define",
      `BUILD_COMMIT=${JSON.stringify(commit)}`,
      "src/cli.ts",
      "--outfile",
      join("dist", directory, "bin/convorel"),
    ],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv(),
    },
  );
  const code = await build.exited;
  if (code) throw new Error(`BUILD_FAILED: ${target} exited ${code}`);
  chmodSync(join(staging, "bin/convorel"), 0o755);
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.md"])
    copyFileSync(join(root, file), join(staging, "share/doc/convorel", file));
  writeFileSync(
    join(staging, "share/doc/convorel/versions.txt"),
    `convorel ${pkg.version}\nbun runtime ${target}\ncommit ${commit}\n`,
  );
  const archive = `${directory}.tar.gz`,
    tar = Bun.spawn(["tar", "-czf", archive, "-C", out, directory], {
      cwd: out,
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv(),
    });
  if (await tar.exited) throw new Error(`TAR_FAILED: ${archive}`);
  rmSync(staging, { recursive: true, force: true });
  checksums.push(
    `${createHash("sha256")
      .update(await Bun.file(join(out, archive)).bytes())
      .digest("hex")}  ${archive}`,
  );
}
writeFileSync(join(out, "sha256sums.txt"), checksums.join("\n") + "\n");
console.log(
  JSON.stringify({
    version: pkg.version,
    commit,
    built: targets,
    directory: out,
    artifacts: [
      ...checksums.map((line) => line.split("  ")[1]),
      "sha256sums.txt",
    ],
  }),
);
