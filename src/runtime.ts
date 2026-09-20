import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
    ? [process.execPath, ...args]
    : [process.execPath, "--no-env-file", cliScript, ...args];
}

function interpret(path: string): string[] {
  if (!path.endsWith(".js")) return [path];
  // The JS launcher needs a runtime; a standalone executable is not one.
  const bun = COMPILED ? Bun.which("bun") : process.execPath;
  if (!bun)
    throw new Error(
      "BUN_REQUIRED: install bun, point CONVOREL_AGENT_BROWSER at the native binary, or add agent-browser to PATH",
    );
  return [bun, "--no-env-file", path];
}

let browser: string[] | undefined;
/** The browser controller is a pinned native binary or the packaged JS launcher. */
export function agentBrowserInvocation(): string[] {
  if (!browser) {
    const sidecar = () => {
      // The release layout installs the native binary beside the real
      // executable, so a PATH symlink has to be resolved before looking beside it.
      const path = join(
        dirname(realpathSync(process.execPath)),
        "agent-browser",
      );
      return existsSync(path) ? path : undefined;
    };
    const packaged = () => {
      try {
        return join(
          dirname(
            createRequire(import.meta.url).resolve(
              "agent-browser/package.json",
            ),
          ),
          "bin/agent-browser.js",
        );
      } catch {
        return undefined;
      }
    };
    // Without the sidecar check a global agent-browser would outrank the version
    // this package pins, so it only applies to an installed standalone binary.
    const candidates = [
      process.env.CONVOREL_AGENT_BROWSER,
      ...(COMPILED ? [sidecar()] : [packaged(), sidecar()]),
      Bun.which("agent-browser") || undefined,
    ].filter((path): path is string => !!path);
    if (!candidates.length)
      throw new Error(
        "AGENT_BROWSER_UNAVAILABLE: reinstall convorel or set CONVOREL_AGENT_BROWSER",
      );
    browser = interpret(candidates[0]);
  }
  return browser;
}
