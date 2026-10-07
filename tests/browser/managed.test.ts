import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_URL,
  chromeArgs,
  managedEndpoint,
  profileOwnsEndpoint,
  startManagedBrowser,
  waitForLogin,
  type LoginStatus,
} from "../../src/browser/managed.ts";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
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
      launch,
      owns: () => true,
    }),
  ).toEqual({ launched: false });
  await expect(
    startManagedBrowser(browser, "http://127.0.0.1:9222", "/log", {
      reachable,
      launch,
      owns: () => false,
    }),
  ).rejects.toThrow("MANAGED_BROWSER_PORT_IN_USE");
  expect(launches).toEqual([]);
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
