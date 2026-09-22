#!/usr/bin/env -S bun --no-env-file
import { consumeRuntimeArgs, runtimePathArgs } from "./src/paths.ts";
// Source checkout bootstrap: no package dependencies and no global installation.
if (!process.execArgv.includes("--no-env-file"))
  throw new Error("Run bun --no-env-file setup.ts ...");
if (process.platform !== "linux")
  throw new Error("This release supports Linux only");
const [major, minor] = Bun.version.split(".").map(Number);
if (major < 1 || (major === 1 && minor < 3))
  throw new Error("Bun >= 1.3 required");
if (process.argv.includes("--help")) {
  console.log(
    "bun --no-env-file setup.ts [--config-dir PATH] [--state-dir PATH] --workspace PATH --cdp PORT_OR_HTTP [--agent codex|claude-code|codex,claude-code]\nInstalls locked local dependencies, then runs convorel setup. convorel setup itself does not install dependencies. It initializes private state, optionally installs the bundled skill, and checks CDP/MCP. Model/project preferences use convorel config set.",
  );
} else {
  const args = consumeRuntimeArgs(process.argv.slice(2));
  const install = Bun.spawn(
    [process.execPath, "--no-env-file", "install", "--frozen-lockfile"],
    {
      cwd: import.meta.dir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await install.exited;
  if (code) process.exitCode = code;
  else {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `${import.meta.dir}/src/cli.ts`,
        ...runtimePathArgs(),
        "setup",
        ...args,
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    process.exitCode = await child.exited;
  }
}
