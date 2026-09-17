#!/usr/bin/env -S bun --no-env-file
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Resolve the installed symlink before locating the runtime, independent of cwd/PATH.
const root = resolve(dirname(realpathSync(import.meta.path)), "../../..");
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    resolve(root, "src/cli.ts"),
    ...process.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
const stop = (signal: "SIGINT" | "SIGTERM") => child.kill(signal);
const interrupt = () => stop("SIGINT"),
  terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  process.exitCode = await child.exited;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
