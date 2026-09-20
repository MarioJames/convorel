#!/usr/bin/env bun
// Standalone executables for GitHub Release artifacts: bun run dist [target,...]
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { childEnv } from "../src/command.ts";
const root = resolve(import.meta.dir, "..");
const out = join(root, "dist");
const pkg = await Bun.file(join(root, "package.json")).json();
const targets = (process.argv[2] || "bun-linux-x64,bun-linux-arm64")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const target of targets) {
  if (!/^bun-linux-(x64|arm64)$/.test(target))
    throw new Error(
      `UNSUPPORTED_TARGET: ${target}; this release ships Linux glibc only`,
    );
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
      "src/cli.ts",
      "--outfile",
      join("dist", `convorel-${pkg.version}-${target.slice(4)}`),
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
}
console.log(
  JSON.stringify({ version: pkg.version, built: targets, directory: out }),
);
