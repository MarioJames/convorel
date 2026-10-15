import { join } from "node:path";
import { Browser } from "../browser/browser.ts";
import {
  chatgptLoginProbe,
  managedBrowserProcess,
  startManagedBrowser,
  stopManagedBrowser,
  waitForLogin,
  type LoginStatus,
} from "../browser/managed.ts";
import { preference } from "../config/preferences.ts";
import type { Config } from "../config/config.ts";
import { effectiveManagedBrowser } from "../config/browser.ts";
import type { State } from "../storage/state.ts";
import { opts, rejectUnknown, type Printer } from "./args.ts";

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 600;
// A signed-in headless page settles within this; otherwise sign-in needs a window.
const HEADLESS_LOGIN_CHECK_MS = 20_000;
const LOGIN_HINTS: Record<Exclude<LoginStatus, "ready">, string> = {
  login:
    "Sign in to ChatGPT in the Chrome window Convorel opened. Convorel continues once you are signed in.",
  verification:
    "Complete the ChatGPT human verification in the Chrome window Convorel opened.",
  loading: "Waiting for ChatGPT to load in the Chrome window Convorel opened.",
};

export function loginTimeoutMs(value?: string) {
  if (value === undefined) return DEFAULT_LOGIN_TIMEOUT_SECONDS * 1000;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 3600)
    throw new Error(
      "INVALID_VALUE: --login-timeout must be an integer from 1 to 3600 seconds",
    );
  return Number(value) * 1000;
}

/** Start the binding's own Chrome profile when its endpoint is down. An
 * external endpoint stays the user's to start. */
const headlessPreferred = () => preference("browser.headless") === "true";

export async function ensureManagedBrowser(
  config: Config,
  store: State,
  headless = headlessPreferred(),
) {
  const browser = effectiveManagedBrowser(config, store.root);
  if (!browser) return { launched: false };
  return store.locked(
    () =>
      startManagedBrowser(
        browser,
        config.cdp,
        join(store.root, "chrome.log"),
        {},
        headless,
      ),
    "browser",
    60_000,
  );
}

async function restartManagedBrowser(
  config: Config,
  store: State,
  headless: boolean,
) {
  await store.locked(
    () =>
      stopManagedBrowser(
        effectiveManagedBrowser(config, store.root)!,
        config.cdp,
      ),
    "browser",
    60_000,
  );
  return ensureManagedBrowser(config, store, headless);
}

export async function waitForChatgptLogin(
  config: Config,
  store: State,
  timeoutMs: number,
  quiet = false,
) {
  const browser = new Browser(config.cdp, store.root);
  await browser.withSessionScope(() =>
    waitForLogin(chatgptLoginProbe(browser), {
      timeoutMs,
      onStatus: (status) => {
        if (!quiet && status !== "ready") console.error(LOGIN_HINTS[status]);
      },
    }),
  );
}

/** Start the managed browser and wait until ChatGPT is signed in. Sign-in
 * needs a window: a headless browser that is not signed in is restarted with
 * one, and returns to headless afterwards when that is preferred. A window
 * that was already open is left alone. */
export async function signInManagedBrowser(
  config: Config,
  store: State,
  timeoutMs: number,
) {
  let { launched } = await ensureManagedBrowser(config, store);
  if (
    managedBrowserProcess(
      effectiveManagedBrowser(config, store.root)!,
      config.cdp,
    )?.headless
  ) {
    try {
      await waitForChatgptLogin(config, store, HEADLESS_LOGIN_CHECK_MS, true);
      return { launched };
    } catch (error) {
      if (!String(error).includes("CHATGPT_LOGIN_TIMEOUT")) throw error;
    }
    await restartManagedBrowser(config, store, false);
    launched = true;
    await waitForChatgptLogin(config, store, timeoutMs);
    if (headlessPreferred()) {
      await restartManagedBrowser(config, store, true);
      await waitForChatgptLogin(config, store, HEADLESS_LOGIN_CHECK_MS, true);
    }
    return { launched };
  }
  await waitForChatgptLogin(config, store, timeoutMs);
  return { launched };
}

export async function runBrowser(
  sub: string | undefined,
  rest: string[],
  store: State,
  print: Printer,
) {
  if (sub !== "start") throw new Error("UNKNOWN_BROWSER_COMMAND");
  const o = opts(rest);
  rejectUnknown("browser start", Object.keys(o), ["login-timeout"]);
  const timeoutMs = loginTimeoutMs(o["login-timeout"]);
  const config = store.read<Config>("config");
  if (!config.browser)
    throw new Error(
      `BROWSER_NOT_MANAGED: this binding uses your own browser at ${config.cdp}; start it yourself or run init --browser managed`,
    );
  const { launched } = await signInManagedBrowser(config, store, timeoutMs);
  print({
    cdp: config.cdp,
    profile: effectiveManagedBrowser(config, store.root)!.userDataDir,
    launched,
    login: "ready",
  });
  return 0;
}
