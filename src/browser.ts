// Attachment pattern adapted from skill-foundry 19f0122 (Apache-2.0).
import { createHash } from "node:crypto";
import { command } from "./command.ts";
import { PAGE_SCRIPT, type PageState } from "./chatgpt/page.ts";
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
    });
    if (!r.ok) throw new Error("CDP_UNAVAILABLE");
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
        const x = (await run("eval", PAGE_SCRIPT)).result;
        if (!x || !Array.isArray(x.messages) || typeof x.url !== "string")
          throw new Error("UI_UNRECOGNIZED");
        return x;
      },
    };
  }
}
