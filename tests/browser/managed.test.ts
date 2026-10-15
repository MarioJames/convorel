import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_URL,
  chatgptLoginProbe,
  chromeArgs,
  headedUserAgent,
  managedBrowserProcess,
  managedPortInUse,
  managedEndpoint,
  profileOwnsEndpoint,
  startManagedBrowser,
  stopManagedBrowser,
  waitForLogin,
  type LoginStatus,
} from "../../src/browser/managed.ts";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    occupied: () => false,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

test("a managed endpoint is IPv4 loopback HTTP with a port", () => {
  expect(managedEndpoint(9876)).toBe("http://127.0.0.1:9876");
  expect(managedEndpoint("http://127.0.0.1:9222/")).toBe(
    "http://127.0.0.1:9222",
  );
  for (const value of [
    "http://localhost:9222",
    "https://127.0.0.1:9222",
    "http://10.0.0.2:9222",
  ])
    expect(() => managedEndpoint(value)).toThrow("INVALID_CDP");
});

test("Chrome starts headed on its own profile with CDP bound to loopback", () => {
  const args = chromeArgs(
    { executable: "/usr/bin/google-chrome", userDataDir: "/state/chrome" },
    "http://127.0.0.1:9333",
    [CHATGPT_URL],
  );
  expect(args).toContain("--user-data-dir=/state/chrome");
  expect(args).toContain("--remote-debugging-address=127.0.0.1");
  expect(args).toContain("--remote-debugging-port=9333");
  expect(args.at(-1)).toBe(CHATGPT_URL);
  expect(args.some((arg) => arg.startsWith("--headless"))).toBe(false);
});

test("a headless start keeps the headed user agent of the installed Chrome and a desktop-sized window", async () => {
  expect(headedUserAgent("Google Chrome 155.0.8059.39\n", "linux")).toBe(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  );
  expect(headedUserAgent("Google Chrome 155.0.8059.39", "darwin")).toContain(
    "Macintosh; Intel Mac OS X 10_15_7",
  );
  expect(() => headedUserAgent("Chromium")).toThrow("CHROME_VERSION_UNKNOWN");
  const root = mkdtempSync(join(tmpdir(), "convorel-managed-"));
  try {
    const launches: string[][] = [];
    let up = false;
    await startManagedBrowser(
      { executable: "/chrome", userDataDir: join(root, "profile") },
      "http://127.0.0.1:9444",
      "/log",
      {
        ...fakeClock(),
        reachable: async () => up,
        version: () => "Google Chrome 155.0.8059.39",
        launch: (_, args) => {
          launches.push(args);
          up = true;
        },
      },
      true,
    );
    expect(launches[0]).toContain("--headless=new");
    expect(launches[0]).toContain("--window-size=1600,1000");
    expect(
      launches[0]!.find((arg) => arg.startsWith("--user-agent=")),
    ).not.toContain("Headless");
    expect(launches[0]!.at(-1)).toBe(CHATGPT_URL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the managed profile's own browser process is found and stopped", async () => {
  const browser = { executable: "/chrome", userDataDir: "/state/chrome" };
  const cdp = "http://127.0.0.1:9222";
  const list = [
    {
      pid: 10,
      line: "/chrome --user-data-dir=/other --remote-debugging-port=9222",
    },
    {
      pid: 11,
      line: "/chrome --type=renderer --user-data-dir=/state/chrome --remote-debugging-port=9222",
    },
    {
      pid: 12,
      line: "/chrome --user-data-dir=/state/chrome --remote-debugging-port=9222 --headless=new",
    },
  ];
  expect(managedBrowserProcess(browser, cdp, list)).toEqual({
    pid: 12,
    headless: true,
  });
  expect(managedBrowserProcess(browser, cdp, list.slice(0, 2))).toBeUndefined();

  let running = true;
  const killed: number[] = [];
  expect(
    await stopManagedBrowser(browser, cdp, {
      find: () => (running ? { pid: 12 } : undefined),
      kill: (pid) => {
        killed.push(pid);
        running = false;
      },
      reachable: async () => false,
      sleep: async () => undefined,
    }),
  ).toBe(true);
  expect(killed).toEqual([12]);
  expect(
    await stopManagedBrowser(browser, cdp, { find: () => undefined }),
  ).toBe(false);
});

test("the profile owns an endpoint only when its browser process opened that port", () => {
  const browser = { executable: "/chrome", userDataDir: "/state/chrome" };
  const cdp = "http://127.0.0.1:9222";
  const launched =
    "/opt/google/chrome/chrome --user-data-dir=/state/chrome --remote-debugging-port=9222 https://chatgpt.com/";
  expect(profileOwnsEndpoint(browser, cdp, [launched])).toBe(true);
  for (const other of [
    "/opt/google/chrome/chrome --user-data-dir=/state/chrome2 --remote-debugging-port=9222",
    "/opt/google/chrome/chrome --user-data-dir=/state/chrome --remote-debugging-port=92220",
    "/opt/google/chrome/chrome --user-data-dir=/other --remote-debugging-port=9222",
    "/opt/google/chrome/chrome --type=renderer --user-data-dir=/state/chrome --remote-debugging-port=9222",
    "/opt/google/chrome/chrome --user-data-dir=/state/chrome",
  ])
    expect(profileOwnsEndpoint(browser, cdp, [other])).toBe(false);
});

test("a running managed browser is reused, and a foreign one on its port is refused", async () => {
  const launches: string[][] = [];
  const browser = { executable: "/chrome", userDataDir: "/unused" };
  const reachable = async () => true;
  const launch = (_: string, args: string[]) => void launches.push(args);
  expect(
    await startManagedBrowser(browser, "http://127.0.0.1:9222", "/log", {
      reachable,
      occupied: () => false,
      launch,
      owns: () => true,
    }),
  ).toEqual({ launched: false });
  await expect(
    startManagedBrowser(browser, "http://127.0.0.1:9222", "/log", {
      reachable,
      occupied: () => false,
      launch,
      owns: () => false,
    }),
  ).rejects.toThrow("MANAGED_BROWSER_PORT_IN_USE");
  expect(launches).toEqual([]);
});

test("another profile reserving a port is refused before CDP is ready without launching", async () => {
  const list = [
    {
      pid: 123,
      line: "/chrome --user-data-dir=/old profile --remote-debugging-port=9444",
    },
  ];
  expect(managedPortInUse("http://127.0.0.1:9444", list)).toBe(true);
  expect(managedPortInUse("http://127.0.0.1:944", list)).toBe(false);
  let launched = false;
  await expect(
    startManagedBrowser(
      { executable: "/chrome", userDataDir: "/new profile" },
      "http://127.0.0.1:9444",
      "/log",
      {
        reachable: async () => false,
        occupied: (cdp) => managedPortInUse(cdp, list),
        owns: (browser, cdp) =>
          profileOwnsEndpoint(
            browser,
            cdp,
            list.map((p) => p.line),
          ),
        launch: () => {
          launched = true;
        },
      },
    ),
  ).rejects.toThrow(/MANAGED_BROWSER_PORT_IN_USE.*expected \/new profile/);
  expect(launched).toBe(false);
});

test("a stopped managed browser is launched once and awaited until CDP answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-managed-"));
  try {
    const browser = {
      executable: "/chrome",
      userDataDir: join(root, "profile"),
    };
    const launches: [string, string[], string][] = [];
    let up = false;
    const result = await startManagedBrowser(
      browser,
      "http://127.0.0.1:9444",
      "/log",
      {
        ...fakeClock(),
        reachable: async () => up,
        launch: (executable, args, log) => {
          launches.push([executable, args, log]);
          up = true;
        },
      },
    );
    expect(result).toEqual({ launched: true });
    expect(launches).toHaveLength(1);
    expect(launches[0]![0]).toBe("/chrome");
    expect(launches[0]![1]).toContain("--remote-debugging-port=9444");
    expect(existsSync(browser.userDataDir)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a browser that never opens CDP fails with its log path instead of hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-managed-"));
  try {
    let launches = 0;
    await expect(
      startManagedBrowser(
        { executable: "/chrome", userDataDir: join(root, "profile") },
        "http://127.0.0.1:9444",
        "/state/chrome.log",
        {
          ...fakeClock(),
          timeoutMs: 5000,
          reachable: async () => false,
          launch: () => void launches++,
        },
      ),
    ).rejects.toThrow(/MANAGED_BROWSER_START_FAILED.*\/state\/chrome\.log/);
    expect(launches).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("login waiting reports each new state once and returns when signed in", async () => {
  const sequence: (LoginStatus | Error)[] = [
    "login",
    "login",
    new Error("navigating"),
    "verification",
    "ready",
  ];
  const reported: LoginStatus[] = [];
  await waitForLogin(
    async () => {
      const next = sequence.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    {
      ...fakeClock(),
      timeoutMs: 60_000,
      onStatus: (status) => reported.push(status),
    },
  );
  expect(reported).toEqual(["login", "loading", "verification"]);
  expect(sequence).toEqual([]);
});

test("login waiting stops at its deadline", async () => {
  await expect(
    waitForLogin(async () => "login", { ...fakeClock(), timeoutMs: 10_000 }),
  ).rejects.toThrow(/CHATGPT_LOGIN_TIMEOUT: still login/);
});

test("login polling binds the ChatGPT tab once and leaves the sign-in tab in front", async () => {
  let tabs: { targetId: string; url: string }[] = [];
  const bound: string[] = [];
  const opened: string[] = [];
  let signedIn = false;
  const browser = {
    tabs: async (op: string, url?: string) => {
      if (op === "new") {
        opened.push(url!);
        return {};
      }
      return { tabs: tabs.map((t) => ({ ...t })) };
    },
    page: async (targetId: string) => {
      bound.push(targetId);
      return {
        read: async () => ({
          url: tabs.find((t) => t.targetId === targetId)!.url,
          blocked: signedIn ? undefined : "Login required",
          hasComposer: signedIn,
        }),
        run: async () => ({ result: signedIn }),
      };
    },
  } as any;
  const probe = chatgptLoginProbe(browser);

  expect(await probe()).toBe("loading");
  expect(await probe()).toBe("loading");
  expect(opened).toEqual([CHATGPT_URL]);

  tabs = [{ targetId: "T1", url: CHATGPT_URL }];
  expect(await probe()).toBe("login");
  tabs[0]!.url = "https://accounts.google.com/v3/signin/identifier";
  expect(await probe()).toBe("login");
  expect(await probe()).toBe("login");
  expect(opened).toEqual([CHATGPT_URL]);

  tabs[0]!.url = CHATGPT_URL;
  signedIn = true;
  expect(await probe()).toBe("ready");
  expect(bound).toEqual(["T1"]);

  tabs = [];
  expect(await probe()).toBe("loading");
  expect(opened).toEqual([CHATGPT_URL, CHATGPT_URL]);
});
