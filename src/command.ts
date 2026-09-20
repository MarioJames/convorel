import { agentBrowserInvocation } from "./runtime.ts";
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
export async function command(argv: string[], seconds = 25): Promise<string> {
  const actual =
    argv[0] === "agent-browser"
      ? [...agentBrowserInvocation(), ...argv.slice(1)]
      : argv;
  const p = Bun.spawn(actual, {
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
        `COMMAND_FAILED: ${argv[0]} (${code}): ${(err || out).slice(0, 600)}`,
      );
    return out;
  } finally {
    clearTimeout(timer);
  }
}
export function required(opts: Record<string, string>, key: string) {
  if (!opts[key]) throw new Error(`Missing --${key}`);
  return opts[key];
}
