import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createServer } from "node:net";
import { childEnv } from "../process.ts";
import type { Browser } from "./browser.ts";

export const CHATGPT_URL = "https://chatgpt.com/";
export const DEFAULT_MANAGED_PORT = 9222;

/** Launch information for the Chrome profile Convorel owns. Its endpoint is
 * the binding's `cdp`; Chrome 136+ only opens CDP for a non-default profile. */
export interface ManagedBrowser {
  executable: string;
  userDataDir: string;
}

const LINUX_CHROME = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];
const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function findChrome(explicit?: string) {
  if (explicit) {
    if (!explicit.startsWith("/") || !existsSync(explicit))
      throw new Error("CHROME_NOT_FOUND: --chrome takes an absolute path");
    return explicit;
  }
  const candidates =
    process.platform === "darwin" ? [MAC_CHROME] : LINUX_CHROME;
  for (const candidate of candidates) {
    const found = candidate.startsWith("/")
      ? existsSync(candidate) && candidate
      : Bun.which(candidate);
    if (found) return found;
  }
  throw new Error(
    "CHROME_NOT_FOUND: install Google Chrome or pass --chrome PATH",
  );
}

/** Chrome binds the debugging port to IPv4 loopback, so the endpoint must too. */
export function managedEndpoint(port: number | string) {
  const value = String(port);
  const url = new URL(
    /^\d+$/.test(value) ? `http://127.0.0.1:${value}` : value,
  );
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error(
      "INVALID_CDP: a managed browser uses http://127.0.0.1:PORT or a port",
    );
  return url.origin;
}

export function chromeArgs(
  browser: ManagedBrowser,
  cdp: string,
  urls: string[] = [],
) {
  return [
    `--user-data-dir=${browser.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${new URL(cdp).port}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...urls,
  ];
}

export async function cdpReachable(cdp: string) {
  try {
    const response = await fetch(cdp + "/json/version", {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Prefer the documented port; otherwise let the OS pick a free one. */
export async function choosePort() {
  if (await portFree(DEFAULT_MANAGED_PORT)) return DEFAULT_MANAGED_PORT;
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function commandLines() {
  if (process.platform === "darwin")
    return execFileSync("/bin/ps", ["-A", "-ww", "-o", "command="], {
      encoding: "utf8",
    }).split("\n");
  return readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .flatMap((pid) => {
      try {
        return [
          readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "),
        ];
      } catch {
        return [];
      }
    });
}

/** CDP does not reveal the profile, so match the Chrome browser process that
 * was started with both this profile and this port. */
export function profileOwnsEndpoint(
  browser: ManagedBrowser,
  cdp: string,
  lines: string[] = commandLines(),
) {
  const has = (line: string, arg: string) =>
    (" " + line.trim() + " ").includes(" " + arg + " ");
  return lines.some(
    (line) =>
      !line.includes(" --type=") &&
      has(line, `--user-data-dir=${browser.userDataDir}`) &&
      has(line, `--remote-debugging-port=${new URL(cdp).port}`),
  );
}

function browserEnv() {
  const env = childEnv();
  // Chrome needs the desktop session to reach its keyring and display.
  for (const key of [
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function spawnChrome(
  executable: string,
  args: string[],
  logPath: string,
) {
  const log = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: browserEnv(),
    });
    // A failed exec surfaces as the startup timeout, which names the log.
    child.on("error", () => undefined);
    child.unref();
  } finally {
    closeSync(log);
  }
}

export type StartDependencies = {
  launch?: typeof spawnChrome;
  reachable?: typeof cdpReachable;
  owns?: typeof profileOwnsEndpoint;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
};

/** Start the managed profile unless its endpoint already answers. Another
 * process on that port is refused rather than silently used. */
export async function startManagedBrowser(
  browser: ManagedBrowser,
  cdp: string,
  logPath: string,
  dependencies: StartDependencies = {},
) {
  const {
    launch = spawnChrome,
    reachable = cdpReachable,
    owns = profileOwnsEndpoint,
    sleep = Bun.sleep,
    now = Date.now,
    timeoutMs = 30_000,
  } = dependencies;
  if (await reachable(cdp)) {
    if (!owns(browser, cdp))
      throw new Error(
        `MANAGED_BROWSER_PORT_IN_USE: ${cdp} belongs to another browser; close it or choose another --cdp`,
      );
    return { launched: false };
  }
  mkdirSync(browser.userDataDir, { recursive: true, mode: 0o700 });
  launch(browser.executable, chromeArgs(browser, cdp, [CHATGPT_URL]), logPath);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(250);
    if (await reachable(cdp)) return { launched: true };
  }
  throw new Error(
    `MANAGED_BROWSER_START_FAILED: Chrome did not open ${cdp} within ${timeoutMs / 1000}s. ` +
      `If this profile is already open without remote debugging, close that window first. Log: ${logPath}`,
  );
}

export type LoginStatus = "ready" | "login" | "verification" | "loading";

const SESSION_SCRIPT = `(async () => {
  const response = await fetch('/api/auth/session', { credentials: 'include' });
  const session = await response.json().catch(() => null);
  return !!(session && session.user);
})()`;

/** Read whether the ChatGPT tab is signed in, opening one when none exists. */
export async function chatgptLoginStatus(
  browser: Browser,
): Promise<LoginStatus> {
  const { tabs } = await browser.tabs("list");
  const target = tabs.find(
    (tab: any) =>
      tab.url?.startsWith(CHATGPT_URL) ||
      tab.url?.startsWith("https://auth.openai.com/"),
  );
  if (!target) {
    await browser.tabs("new", CHATGPT_URL);
    return "loading";
  }
  const page = await browser.page(target.targetId);
  const state = await page.read();
  if (state.blocked === "Login required") return "login";
  if (state.blocked === "Human verification required") return "verification";
  if (state.hasComposer && !state.blocked) return "ready";
  // Settings and other signed-in pages have no composer.
  if (!state.url.startsWith(CHATGPT_URL)) return "loading";
  const session = await page.run("eval", SESSION_SCRIPT);
  return session.result === true ? "ready" : "loading";
}

export async function waitForLogin(
  read: () => Promise<LoginStatus>,
  options: {
    timeoutMs: number;
    onStatus?: (status: LoginStatus) => void;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
    intervalMs?: number;
  },
) {
  const { sleep = Bun.sleep, now = Date.now, intervalMs = 2000 } = options;
  const deadline = now() + options.timeoutMs;
  let last: LoginStatus | undefined;
  for (;;) {
    // Navigation during sign-in makes single reads fail; the deadline bounds it.
    const status = await read().catch((): LoginStatus => "loading");
    if (status === "ready") return;
    if (status !== last) options.onStatus?.(status);
    last = status;
    if (now() >= deadline)
      throw new Error(
        `CHATGPT_LOGIN_TIMEOUT: still ${status} after ${Math.round(options.timeoutMs / 1000)}s; run convorel browser start to continue`,
      );
    await sleep(intervalMs);
  }
}
