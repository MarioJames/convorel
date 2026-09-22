import { agentBrowserInvocation } from "./runtime.ts";
import { runProcess } from "./process.ts";
export async function command(argv: string[], seconds = 25): Promise<string> {
  const actual =
    argv[0] === "agent-browser"
      ? [...agentBrowserInvocation(), ...argv.slice(1)]
      : argv;
  return runProcess(actual, seconds, argv[0]);
}

export function required(opts: Record<string, string>, key: string) {
  if (!opts[key]) throw new Error(`Missing --${key}`);
  return opts[key];
}
