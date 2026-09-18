// Attachment pattern adapted from skill-foundry 19f0122 (Apache-2.0).
import { createHash } from "node:crypto";
import { command } from "./command.ts";
import { PAGE_SCRIPT, SEND_SELECTOR, type PageState } from "./chatgpt/page.ts";
// Only observation failures may be retried automatically; never a browser action.
export class ObservationError extends Error {}

export async function sendPrompt(
  page: { run: (...args: string[]) => Promise<any> },
  observed: PageState,
) {
  if (!observed.sendReady) throw new Error("SEND_CONTROL_UNAVAILABLE");
  return page.run("click", SEND_SELECTOR);
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
  constructor(cdp: string, scope: string) {
    this.cdp = cdpEndpoint(cdp);
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
    const x = JSON.parse(
      await command([
        "agent-browser",
        "--namespace",
        this.namespace,
        "--session",
        session,
        "--cdp",
        this.cdp,
        pin ? "--pin-tab" : "--no-pin-tab",
        "--idle-timeout",
        "1m",
        "--json",
        ...args,
      ]),
    );
    if (!x.success)
      throw new Error(
        "BROWSER_ERROR: " + JSON.stringify(x.error || x.data).slice(0, 600),
      );
    return x.data;
  }
  async tabs(...args: string[]) {
    if (args[0] === "close" && !args[1])
      throw new Error("EXPLICIT_TARGET_REQUIRED");
    return this.invoke("tabs", false, "tab", ...args);
  }
  async page(target: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error("INVALID_TARGET");
    const session =
      "p-" + createHash("sha256").update(target).digest("hex").slice(0, 16);
    await this.invoke(session, false, "tab", target);
    const run = (...args: string[]) => this.invoke(session, true, ...args);
    return {
      session,
      run,
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
