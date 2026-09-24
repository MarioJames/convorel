// Attachment pattern adapted from skill-foundry 19f0122 (Apache-2.0).
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { command } from "../command.ts";
import { PAGE_SCRIPT, SEND_SELECTOR, type PageState } from "./chatgpt/page.ts";
import { BrowserPacing, type PacingClock } from "./pacing.ts";
// Only observation failures may be retried automatically; never a browser action.
export class ObservationError extends Error {}
let operationCounter = 0;
/** Unambiguous across concurrently running CLI processes in one namespace. */
export function operationSessionPrefix(pid: number, counter: number) {
  return `o${pid.toString(36)}-${counter.toString(36)}`;
}
/** The adapter command was never handed to its executor. Only this fact may
 * restore pre-dispatch state; an executor error is always delivery-uncertain. */
export class ActionNotDispatched extends Error {
  constructor(readonly cause: unknown) {
    super(String(cause));
  }
}

/** Explicit, compare-and-delete recovery; never use fill("") on contenteditable. */
export async function clearDraft(
  page: {
    run: (...args: string[]) => Promise<any>;
    read: () => Promise<PageState>;
  },
  expected: PageState,
) {
  if (!expected.draft?.trim()) throw new Error("EXPECTED_DRAFT_REQUIRED");
  const result = await page.run(
    "eval",
    `(() => {
    const expected = ${JSON.stringify(expected)};
    const read = () => ${PAGE_SCRIPT};
    const history = p => JSON.stringify(p.messages.map(m => [m.id, m.role, m.text, m.final, m.model]));
    const check = () => {
      const p = read();
      if (p.url !== expected.url || history(p) !== history(expected)) throw new Error('PAGE_CHANGED');
      if (p.blocked || p.generating || p.attachments || !p.hasComposer) throw new Error('PAGE_NOT_IDLE');
      if (p.draft !== expected.draft) throw new Error('DRAFT_CHANGED');
    };
    check();
    const e = document.querySelector('#prompt-textarea');
    if (!e || (e.tagName !== 'TEXTAREA' && !e.isContentEditable)) throw new Error('COMPOSER_UNRECOGNIZED');
    e.focus();
    check();
    if (e.tagName === 'TEXTAREA') e.select();
    else {
      const range = document.createRange(); range.selectNodeContents(e);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    check();
    // Browser editing updates ProseMirror's document and emits its native input event.
    if (!document.execCommand('delete')) throw new Error('DRAFT_CLEAR_UNVERIFIED');
    return { cleared: read().draft.trim() === '' };
  })()`,
  );
  if (result.result?.cleared !== true)
    throw new Error("DRAFT_CLEAR_UNVERIFIED");
  // Observe again after the editor has processed the input; never repeat the mutation.
  await Bun.sleep(250);
  const after = await page.read();
  if (
    after.url !== expected.url ||
    after.draft === undefined ||
    after.draft.trim() !== "" ||
    after.blocked ||
    after.generating ||
    after.attachments ||
    !after.hasComposer ||
    JSON.stringify(after.messages) !== JSON.stringify(expected.messages)
  )
    throw new Error("DRAFT_CLEAR_UNVERIFIED");
}

export async function sendPrompt(
  page: {
    runChecked: (
      args: string[],
      beforeDispatch: () => Promise<void>,
    ) => Promise<any>;
  },
  observed: PageState,
  beforeDispatch: () => Promise<void>,
) {
  if (!observed.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
  return page.runChecked(["click", SEND_SELECTOR], beforeDispatch);
}
export function cdpEndpoint(value: string) {
  const u = new URL(/^\d+$/.test(value) ? `http://127.0.0.1:${value}` : value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("INVALID_CDP: use a loopback HTTP endpoint or port");
  return u.origin;
}
export class Browser {
  readonly cdp: string;
  readonly namespace: string;
  private readonly sessions = new Set<string>();
  private readonly operation = new AsyncLocalStorage<{
    prefix: string;
    sessions: Set<string>;
  }>();
  private readonly pacing: BrowserPacing;
  private readonly execute: typeof command;
  constructor(
    cdp: string,
    scope: string,
    dependencies: PacingClock & { command?: typeof command } = {},
  ) {
    this.cdp = cdpEndpoint(cdp);
    this.pacing = new BrowserPacing(scope, dependencies);
    this.execute = dependencies.command ?? command;
    this.namespace =
      "convorel-" +
      createHash("sha256").update(scope).digest("hex").slice(0, 12);
  }
  async epoch() {
    const r = await fetch(this.cdp + "/json/version", {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    }).catch((e) => {
      throw new ObservationError("CDP_UNAVAILABLE: " + String(e));
    });
    if (!r.ok) throw new ObservationError("CDP_UNAVAILABLE: HTTP " + r.status);
    const x = (await r.json()) as any;
    if (typeof x.webSocketDebuggerUrl !== "string")
      throw new Error("CDP_METADATA_INVALID");
    return createHash("sha256").update(x.webSocketDebuggerUrl).digest("hex");
  }
  async invoke(session: string, pin: boolean, ...args: string[]) {
    return this.dispatch(session, pin, args);
  }
  /** A task operation owns only its adapter sessions. Its cleanup remains inside
   * the task lock, and a new operation never reuses a daemon being closed. */
  async withSessionScope<T>(fn: () => Promise<T>): Promise<T> {
    return this.operation.run(
      // agent-browser embeds this name in a Unix socket path (103-byte limit).
      {
        prefix: operationSessionPrefix(process.pid, ++operationCounter),
        sessions: new Set(),
      },
      async () => {
        try {
          return await fn();
        } finally {
          await this.release();
        }
      },
    );
  }
  private sessionName(logical: string) {
    const scope = this.operation.getStore();
    return scope ? scope.prefix + "-" + logical : logical;
  }
  private async dispatch(
    session: string,
    pin: boolean,
    args: string[],
    beforeDispatch?: () => Promise<void>,
  ) {
    const actualSession = this.sessionName(session);
    (this.operation.getStore()?.sessions ?? this.sessions).add(actualSession);
    let handedToExecutor = false;
    try {
      return await this.pacing.run(args, async () => {
        // Read-only preflight runs after pacing. A caller may also persist its
        // intent here, but must not issue another paced browser action.
        await beforeDispatch?.();
        handedToExecutor = true;
        const x = JSON.parse(
          await this.execute(
            this.argv(
              actualSession,
              pin ? "--pin-tab" : "--no-pin-tab",
              "--json",
              ...args,
            ),
          ),
        );
        if (!x.success)
          throw new Error(
            "BROWSER_ERROR: " + JSON.stringify(x.error || x.data).slice(0, 600),
          );
        return x.data;
      });
    } catch (error) {
      if (beforeDispatch && !handedToExecutor)
        throw new ActionNotDispatched(error);
      throw error;
    }
  }
  private argv(session: string, ...flags: string[]) {
    return [
      "agent-browser",
      "--namespace",
      this.namespace,
      "--session",
      session,
      "--cdp",
      this.cdp,
      // Backstop for a convorel process killed before it reached release().
      "--idle-timeout",
      "1m",
      ...flags,
    ];
  }
  /**
   * Each session owns a daemon process, so an operation that returns without
   * this would keep every tab it touched running until the idle timeout.
   * Tab pinning is sticky, so no pin flag is sent here.
   */
  async release() {
    const owned = this.operation.getStore()?.sessions ?? this.sessions;
    const sessions = [...owned];
    owned.clear();
    if (!sessions.length) return;
    for (const session of sessions) {
      // An already-stopped daemon is not this operation's failure.
      await this.execute([...this.argv(session, "--json"), "close"]).catch(
        () => undefined,
      );
    }
    // close returns before the daemon is gone, and a session command issued in
    // that window reaches for the dying daemon instead of starting a fresh one.
    for (let n = 0; n < 40 && this.running(sessions); n++) await Bun.sleep(50);
  }
  private running(sessions: string[]) {
    const owned = sessions.map((s) => `AGENT_BROWSER_SESSION=${s}`);
    if (process.platform === "darwin") {
      const output = execFileSync(
        "/bin/ps",
        ["-A", "-E", "-ww", "-o", "command="],
        { encoding: "utf8" },
      );
      return output
        .split("\n")
        .some(
          (line) =>
            line.includes(`AGENT_BROWSER_NAMESPACE=${this.namespace}`) &&
            owned.some((session) => line.includes(session)),
        );
    }
    return readdirSync("/proc").some((pid) => {
      if (!/^[0-9]+$/.test(pid)) return false;
      let env: string[];
      try {
        env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      } catch {
        return false;
      }
      return (
        env.includes(`AGENT_BROWSER_NAMESPACE=${this.namespace}`) &&
        owned.some((session) => env.includes(session))
      );
    });
  }
  async tabs(...args: string[]) {
    if (args[0] === "close" && !args[1])
      throw new Error("EXPLICIT_TARGET_REQUIRED");
    return this.invoke("tabs", false, "tab", ...args);
  }
  async closeTab(target: string, beforeClose: () => Promise<void>) {
    if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error("INVALID_TARGET");
    return this.dispatch("tabs", false, ["tab", "close", target], beforeClose);
  }
  async page(target: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error("INVALID_TARGET");
    const session =
      "p-" + createHash("sha256").update(target).digest("hex").slice(0, 16);
    await this.invoke(session, false, "tab", target);
    const scope = this.operation.getStore();
    const run = (...args: string[]) =>
      scope
        ? this.operation.run(scope, () => this.invoke(session, true, ...args))
        : this.invoke(session, true, ...args);
    const runChecked = (args: string[], beforeDispatch: () => Promise<void>) =>
      scope
        ? this.operation.run(scope, () =>
            this.dispatch(session, true, args, beforeDispatch),
          )
        : this.dispatch(session, true, args, beforeDispatch);
    return {
      session: this.sessionName(session),
      run,
      runChecked,
      read: async (): Promise<PageState> => {
        let result;
        try {
          result = await run("eval", PAGE_SCRIPT);
        } catch (e) {
          // A missing/replaced target needs inspection, not a fallback tab.
          if (
            /tab_gone|target.*closed|page.*closed|no tab|not found/i.test(
              String(e),
            )
          )
            throw e;
          throw new ObservationError("BROWSER_READ_FAILED: " + String(e));
        }
        const x = result.result;
        if (!x || !Array.isArray(x.messages) || typeof x.url !== "string")
          throw new Error("UI_UNRECOGNIZED");
        return x;
      },
    };
  }
}
