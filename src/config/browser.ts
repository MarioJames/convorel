import { join } from "node:path";
import type { ManagedBrowser } from "../browser/managed.ts";
import type { Config } from "./config.ts";
import { browserUserDataPath, preference } from "./preferences.ts";

/** Preferences change the active profile without replacing the saved fallback. */
export function resolveBrowserProfile(
  stateRoot: string,
  browser?: Pick<ManagedBrowser, "userDataDir">,
  read: typeof preference = preference,
) {
  const configured = read("browser.userDataDir");
  if (configured)
    return {
      userDataDir: browserUserDataPath(configured),
      source: "preference" as const,
    };
  if (browser?.userDataDir)
    return { userDataDir: browser.userDataDir, source: "state" as const };
  return { userDataDir: join(stateRoot, "chrome"), source: "default" as const };
}

export function effectiveManagedBrowser(config: Config, stateRoot: string) {
  return config.browser
    ? {
        ...config.browser,
        userDataDir: resolveBrowserProfile(stateRoot, config.browser)
          .userDataDir,
      }
    : undefined;
}
