import { runtimePathArgs } from "./paths.ts";
import { preference } from "./user-config.ts";
import { join, resolve } from "node:path";

// Bun's standalone executable serves embedded modules and --asset files from a
// virtual root, where neither node_modules resolution nor ../ relative paths work.
export const COMPILED = import.meta.url.includes("/$bunfs/");
const VIRTUAL_ROOT = "/$bunfs/root";

export const cliScript = resolve(import.meta.dir, "cli.ts");

/** Bundled tree root: the package directory in a source checkout, the embed otherwise. */
export function assetPath(...parts: string[]) {
  return join(
    COMPILED ? VIRTUAL_ROOT : resolve(import.meta.dir, ".."),
    ...parts,
  );
}

/** Re-enter this CLI as a child process without assuming it runs under bun. */
export function selfExec(args: string[]) {
  return COMPILED
    ? [process.execPath, ...runtimePathArgs(), ...args]
    : [
        process.execPath,
        "--no-env-file",
        cliScript,
        ...runtimePathArgs(),
        ...args,
      ];
}

function interpret(path: string): string[] {
  if (!path.endsWith(".js")) return [path];
  // The JS launcher needs a runtime; a standalone executable is not one.
  const bun = COMPILED ? Bun.which("bun") : process.execPath;
  if (!bun)
    throw new Error(
      "BUN_REQUIRED: install bun, or configure browser.executable with the native agent-browser binary",
    );
  return [bun, "--no-env-file", path];
}

/** The saved controller, or the agent-browser command currently on PATH. */
export function agentBrowserExecutable() {
  const configured = preference("browser.executable");
  if (configured) return configured;
  const found = Bun.which("agent-browser");
  if (!found)
    throw new Error(
      "AGENT_BROWSER_UNAVAILABLE: install agent-browser and put it on PATH, then run init",
    );
  return found;
}

/** Where the controller resolves to, reported by a diagnostic that must not fail. */
export function agentBrowserLocation() {
  try {
    return agentBrowserExecutable();
  } catch {
    return "unresolved";
  }
}

let browser: string[] | undefined;
/** Use the controller init saved, otherwise the agent-browser command on PATH. */
export function agentBrowserInvocation(): string[] {
  if (!browser) browser = interpret(agentBrowserExecutable());
  return browser;
}

export function resetAgentBrowserInvocation() {
  browser = undefined;
}
