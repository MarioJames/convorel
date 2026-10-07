import { join } from "node:path";
import { Browser } from "../browser/browser.ts";
import {
  chatgptLoginStatus,
  startManagedBrowser,
  waitForLogin,
  type LoginStatus,
} from "../browser/managed.ts";
import type { Config } from "../config/config.ts";
import type { State } from "../storage/state.ts";
import { opts, rejectUnknown, type Printer } from "./args.ts";

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 600;
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
export async function ensureManagedBrowser(config: Config, store: State) {
  if (!config.browser) return { launched: false };
  return store.locked(
    () =>
      startManagedBrowser(
        config.browser!,
        config.cdp,
        join(store.root, "chrome.log"),
      ),
    "browser",
    60_000,
  );
}

export async function waitForChatgptLogin(
  config: Config,
  store: State,
  timeoutMs: number,
) {
  const browser = new Browser(config.cdp, store.root);
  await browser.withSessionScope(() =>
    waitForLogin(() => chatgptLoginStatus(browser), {
      timeoutMs,
      onStatus: (status) => {
        if (status !== "ready") console.error(LOGIN_HINTS[status]);
      },
    }),
  );
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
  const { launched } = await ensureManagedBrowser(config, store);
  await waitForChatgptLogin(config, store, timeoutMs);
  print({
    cdp: config.cdp,
    profile: config.browser.userDataDir,
    launched,
    login: "ready",
  });
  return 0;
}
