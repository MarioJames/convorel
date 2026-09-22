import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../src/browser.ts";
import { BrowserPacing } from "../src/browser-pacing.ts";
import { State } from "../src/state.ts";
import { setRuntimePaths } from "../src/paths.ts";
import { writePreference } from "../src/user-config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "convorel-pacing-"));
  const previous = setRuntimePaths({ configDir: join(root, "config") });
  const store = new State(join(root, "state"));
  let now = 100_000;
  const sleeps: number[] = [];
  const actions: { at: number; args: string[] }[] = [];
  let failure: Error | undefined;
  const dependencies = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    command: async (args: string[]) => {
      actions.push({ at: now, args });
      if (failure) throw failure;
      return JSON.stringify({
        success: true,
        data: { result: { url: "https://chatgpt.com/", messages: [] } },
      });
    },
  };
  return {
    root,
    store,
    sleeps,
    actions,
    dependencies,
    browser: () => new Browser("1", store.root, dependencies),
    fail: (error?: Error) => {
      failure = error;
    },
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      setRuntimePaths(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("coordination records a delay before dispatch and covers failed commands", async () => {
  const f = fixture();
  try {
    const pacing = new BrowserPacing(f.store.root, f.dependencies);
    await expect(
      pacing.run(["click"], async () => {
        expect(f.store.read("browser-pacing").nextActionAt).toBe(100_750);
        throw new Error("unknown write");
      }),
    ).rejects.toThrow("unknown write");
    await pacing.run(["fill"], async () => {});
    expect(f.sleeps).toEqual([750]);
  } finally {
    f.restore();
  }
});

test("adapter spaces every requested action across browser instances while reads remain immediate", async () => {
  const f = fixture();
  try {
    const first = f.browser(),
      second = f.browser();
    const page = await first.page("target");
    await page.run("click", "#private-selector");
    await page.read();
    await page.run("network", "requests");
    await second.tabs("list");
    expect(f.sleeps).toEqual([]);
    for (const action of ["fill", "press", "focus", "select"])
      await second.invoke("p", true, action, "private-body");
    await first.tabs("close", "target");
    expect(f.sleeps).toEqual([750, 750, 750, 750, 750]);
    expect(f.now()).toBe(103_750);
    const saved = readFileSync(f.store.path("browser-pacing"), "utf8");
    expect(JSON.parse(saved)).toEqual({ version: 1, nextActionAt: 104_500 });
    expect(saved).not.toContain("private");
    expect(lstatSync(f.store.path("browser-pacing")).mode & 0o777).toBe(0o600);
  } finally {
    f.restore();
  }
});

test("open, reload and new tabs wait for stability; elapsed stability satisfies the next action interval", async () => {
  const f = fixture();
  try {
    const browser = f.browser();
    await browser.invoke("p", true, "open", "https://chatgpt.com/");
    await browser.invoke("p", true, "reload");
    await browser.tabs("new", "https://chatgpt.com/");
    await browser.invoke("p", true, "click", "#send");
    expect(f.sleeps).toEqual([1500, 1500, 1500]);
    expect(f.actions.map((x) => x.at)).toEqual([
      100_000, 101_500, 103_000, 104_500,
    ]);
  } finally {
    f.restore();
  }
});

test("preferences control both delays and failed actions are never replayed or exempted", async () => {
  const f = fixture();
  try {
    writePreference("browser.actionIntervalMs", "40");
    writePreference("browser.navigationWaitMs", "90");
    const browser = f.browser();
    f.fail(new Error("transport failed after dispatch"));
    await expect(browser.invoke("p", true, "click", "#send")).rejects.toThrow(
      "transport failed",
    );
    f.fail();
    await f.browser().invoke("p", true, "fill", "#input", "secret");
    f.fail(new Error("navigation unknown"));
    await expect(browser.invoke("p", true, "reload")).rejects.toThrow(
      "navigation unknown",
    );
    expect(f.actions).toHaveLength(3);
    expect(f.sleeps).toEqual([40, 40, 90]);
    expect(f.store.has("lock-browser-pacing")).toBe(false);
  } finally {
    f.restore();
  }
});

test("future timestamps have a finite delay and stale timestamps do not delay actions", async () => {
  const f = fixture();
  try {
    f.store.write("browser-pacing", {
      version: 1,
      nextActionAt: Number.MAX_SAFE_INTEGER,
    });
    await f.browser().invoke("p", true, "click", "#send");
    expect(f.sleeps).toEqual([10_000]);
    f.advance(50_000);
    await f.browser().invoke("p", true, "click", "#send");
    expect(f.sleeps).toEqual([10_000]);
  } finally {
    f.restore();
  }
});

test("concurrent adapters coordinate only actions, allowing observation during an outstanding write", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const browser = new Browser("1", f.store.root, {
      ...f.dependencies,
      command: async (args: string[]) => {
        const result = await f.dependencies.command(args);
        if (args.includes("click")) {
          started();
          await gate;
        }
        return result;
      },
    });
    const first = browser.invoke("p", true, "click", "#send");
    await ready;
    const second = f.browser().invoke("q", true, "fill", "#input", "body");
    await f.browser().invoke("r", true, "eval", "read-only");
    expect(f.actions).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    expect(f.actions.map((x) => x.at)).toEqual([100_000, 100_000, 100_750]);
  } finally {
    release();
    f.restore();
  }
});

test("separate CLI processes share the timestamp and private lock without storing action content", async () => {
  const f = fixture();
  try {
    const script = `
      import { Browser } from ${JSON.stringify(new URL("../src/browser.ts", import.meta.url).pathname)};
      import { setRuntimePaths } from ${JSON.stringify(new URL("../src/paths.ts", import.meta.url).pathname)};
      setRuntimePaths({ configDir: ${JSON.stringify(join(f.root, "config"))} });
      let now = 100000;
      const browser = new Browser("1", ${JSON.stringify(f.store.root)}, {
        now: () => now,
        sleep: async ms => { now += ms; },
        command: async () => { console.log(now); return '{"success":true,"data":{}}'; }
      });
      await browser.invoke("p", true, "fill", "#input", "private text");
    `;
    const children = Array.from({ length: 3 }, () =>
      Bun.spawn([process.execPath, "--eval", script], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        at: Number(await new Response(child.stdout).text()),
        error: await new Response(child.stderr).text(),
        code: await child.exited,
      })),
    );
    expect(results.map((x) => x.code)).toEqual([0, 0, 0]);
    expect(results.map((x) => x.error)).toEqual(["", "", ""]);
    expect(results.map((x) => x.at).sort((a, b) => a - b)).toEqual([
      100_000, 100_750, 101_500,
    ]);
    expect(
      f.store.read<{ version: 1; nextActionAt: number }>("browser-pacing"),
    ).toEqual({
      version: 1,
      nextActionAt: 102_250,
    });
    expect(f.store.has("lock-browser-pacing")).toBe(false);
  } finally {
    f.restore();
  }
});

test("failed preflight leaves the write untouched and command duration counts before the next interval", async () => {
  const f = fixture();
  try {
    f.store.write("browser-pacing", { version: 1, nextActionAt: "invalid" });
    await expect(
      f.browser().invoke("p", true, "click", "#send"),
    ).rejects.toThrow("BROWSER_PACING_METADATA_INVALID");
    expect(f.actions).toHaveLength(0);
    f.store.write("browser-pacing", { version: 1, nextActionAt: 0 });
    const pacing = new BrowserPacing(f.store.root, f.dependencies);
    await pacing.run(["fill"], async () => {
      f.advance(500);
    });
    await f.browser().invoke("p", true, "click", "#send");
    expect(f.actions[0]!.at).toBe(101_250);
    expect(f.sleeps).toEqual([750]);
  } finally {
    f.restore();
  }
});
