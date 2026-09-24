import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionNotDispatched, Browser } from "../../src/browser/browser.ts";
import { State } from "../../src/storage/state.ts";

test("concurrent operations close only their own adapter sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-session-"));
  const calls: { session: string; action: string }[] = [];
  const browser = new Browser("9222", root, {
    command: (async (argv: string[]) => {
      calls.push({
        session: argv[argv.indexOf("--session") + 1]!,
        action: argv.at(-1)!,
      });
      return JSON.stringify({ success: true, data: {} });
    }) as any,
  });
  let finishA!: () => void, finishB!: () => void;
  const holdA = new Promise<void>((resolve) => (finishA = resolve));
  const holdB = new Promise<void>((resolve) => (finishB = resolve));
  let enteredA!: () => void, enteredB!: () => void;
  const readyA = new Promise<void>((resolve) => (enteredA = resolve));
  const readyB = new Promise<void>((resolve) => (enteredB = resolve));
  try {
    const a = browser.withSessionScope(async () => {
      await browser.invoke("tabs", false, "tab", "list");
      enteredA();
      await holdA;
    });
    const b = browser.withSessionScope(async () => {
      await browser.invoke("tabs", false, "tab", "list");
      enteredB();
      await holdB;
    });
    await Promise.all([readyA, readyB]);
    const used = calls.filter((call) => call.action === "list");
    expect(used).toHaveLength(2);
    expect(used[0]!.session).not.toBe(used[1]!.session);
    finishA();
    await a;
    expect(calls.filter((call) => call.action === "close")).toEqual([
      { session: used[0]!.session, action: "close" },
    ]);
    finishB();
    await b;
    expect(calls.filter((call) => call.action === "close")).toEqual([
      { session: used[0]!.session, action: "close" },
      { session: used[1]!.session, action: "close" },
    ]);
  } finally {
    finishA();
    finishB();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pacing failure reports that checked Send was not dispatched", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-predispatch-"));
  const actions: string[] = [];
  const browser = new Browser("9222", root, {
    command: (async (argv: string[]) => {
      actions.push(argv.at(-2)!);
      return JSON.stringify({ success: true, data: {} });
    }) as any,
  });
  try {
    new State(root).write("browser-pacing", {
      version: 1,
      nextActionAt: "invalid",
    });
    let checked = false;
    await expect(
      browser.withSessionScope(async () => {
        const page = await browser.page("target1");
        return page.runChecked(["click", "#send"], async () => {
          checked = true;
        });
      }),
    ).rejects.toBeInstanceOf(ActionNotDispatched);
    expect(checked).toBe(false);
    expect(actions).not.toContain("click");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
