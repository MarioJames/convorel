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
  const p = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), seconds * 1000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code)
      throw new Error(
        `COMMAND_FAILED: ${label} (${code}): ${(err || out).slice(0, 600)}`,
      );
    return out;
  } finally {
    clearTimeout(timer);
  }
}
