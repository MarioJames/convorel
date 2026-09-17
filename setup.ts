#!/usr/bin/env -S bun --no-env-file
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
    "bun --no-env-file setup.ts --workspace PATH --cdp PORT [init options]\nInstalls locked local dependencies, initializes private state and checks CDP/MCP.",
  );
} else {
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
        "setup",
        ...process.argv.slice(2),
      ],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    process.exitCode = await child.exited;
  }
}
