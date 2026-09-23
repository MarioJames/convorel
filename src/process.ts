import { executeManaged } from "./process-lifecycle.ts";
export function childEnv() {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

/** Execute an explicit argv with the same bounded environment used by Git and services. */
export async function runProcess(
  argv: string[],
  seconds = 25,
  label = argv[0],
): Promise<string> {
  const { stdout, stderr, code } = await executeManaged(argv, {
    env: childEnv(),
    timeoutMs: seconds * 1000,
  });
  if (code)
    throw new Error(
      `COMMAND_FAILED: ${label} (${code}): ${(stderr || stdout).slice(0, 600)}`,
    );
  return stdout;
}
