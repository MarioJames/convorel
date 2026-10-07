import { join } from "node:path";
import { Workspace } from "../workspace/workspace.ts";
import { cdpEndpoint } from "../browser/browser.ts";
import {
  choosePort,
  findChrome,
  managedEndpoint,
  type ManagedBrowser,
} from "../browser/managed.ts";
import type { State } from "../storage/state.ts";
import type { Config } from "../config/config.ts";
import { conversationConfig } from "../config/config.ts";
import {
  agentBrowserExecutable,
  resetAgentBrowserInvocation,
} from "../runtime.ts";
import { command, required } from "../command.ts";
import { writePreference } from "../config/preferences.ts";
import { installSkill } from "../distribution/skills.ts";
import { opts, type Printer } from "./args.ts";
import {
  ensureManagedBrowser,
  loginTimeoutMs,
  waitForChatgptLogin,
} from "./browser.ts";

const INIT_OPTIONS = ["workspace", "cdp", "browser", "chrome", "login-timeout"];

export async function runInit(args: string[], store: State, print: Printer) {
  const o = opts(args.slice(1)),
    workspace = new Workspace(required(o, "workspace")).root;
  if (store.root === workspace || store.root.startsWith(workspace + "/"))
    throw new Error("STATE_INSIDE_WORKSPACE");
  for (const key of Object.keys(o))
    if (!INIT_OPTIONS.includes(key))
      throw new Error(
        `Unknown init option --${key}; configure model/project through convorel config set`,
      );
  // Without an endpoint, Convorel owns the browser; --cdp alone keeps it yours.
  const mode = o.browser ?? (o.cdp ? "external" : "managed");
  if (mode !== "managed" && mode !== "external")
    throw new Error("INVALID_VALUE: --browser takes managed or external");
  if (mode === "external" && (o.chrome || o["login-timeout"]))
    throw new Error(
      "MANAGED_BROWSER_OPTION: --chrome and --login-timeout need --browser managed",
    );
  const timeoutMs = loginTimeoutMs(o["login-timeout"]);
  const previous = store.has("config")
    ? store.read<Config>("config")
    : undefined;
  let cdp: string, browser: ManagedBrowser | undefined;
  if (mode === "external") cdp = cdpEndpoint(required(o, "cdp"));
  else {
    cdp = managedEndpoint(o.cdp ?? previous?.cdp ?? (await choosePort()));
    browser = {
      executable: findChrome(o.chrome),
      userDataDir: previous?.browser?.userDataDir ?? join(store.root, "chrome"),
    };
  }
  const config: Config = {
    version: 1,
    workspace,
    cdp,
    ...(browser && { browser }),
  };
  const effective = conversationConfig(config);
  const executable = agentBrowserExecutable();
  const identified = (await command([executable, "--version"])).trim();
  if (!/^agent-browser\s+\S+/.test(identified))
    throw new Error(
      `AGENT_BROWSER_UNAVAILABLE: ${executable} did not identify itself as agent-browser`,
    );
  const recorded = writePreference("browser.executable", executable);
  resetAgentBrowserInvocation();
  await store.locked(async () => {
    if (store.has("config")) {
      const old = store.read<Config>("config");
      if (old.workspace !== workspace || old.cdp !== cdp)
        throw new Error(
          "CONFIG_BINDING_IMMUTABLE: choose a separate --state-dir for another workspace/browser",
        );
    }
    store.write("config", config);
  }, "config");
  // The binding is saved first, so an unfinished sign-in resumes with browser start.
  if (browser) {
    await ensureManagedBrowser(config, store);
    await waitForChatgptLogin(config, store, timeoutMs);
  }
  print({
    ...effective,
    ...(browser && { browser, login: "ready" }),
    modelPolicy: effective.model || "latest-pro",
    stateDirectory: store.root,
    agentBrowser: recorded.value,
  });
  return 0;
}

export async function runSetup(
  args: string[],
  print: Printer,
  run: (args: string[]) => Promise<number>,
) {
  const o = opts(args.slice(1));
  const agent = o.agent;
  delete o.agent;
  await run(["init", ...Object.entries(o).flatMap(([k, v]) => ["--" + k, v])]);
  if (agent) print(await installSkill({ agent }));
  return run(["doctor"]);
}
