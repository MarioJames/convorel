import { Workspace } from "../workspace/workspace.ts";
import { cdpEndpoint } from "../browser/browser.ts";
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

export async function runInit(args: string[], store: State, print: Printer) {
  const o = opts(args.slice(1)),
    workspace = new Workspace(required(o, "workspace")).root,
    cdp = cdpEndpoint(required(o, "cdp"));
  if (store.root === workspace || store.root.startsWith(workspace + "/"))
    throw new Error("STATE_INSIDE_WORKSPACE");
  for (const key of Object.keys(o))
    if (!["workspace", "cdp"].includes(key))
      throw new Error(
        `Unknown init option --${key}; configure model/project through convorel config set`,
      );
  const config: Config = { version: 1, workspace, cdp };
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
  print({
    ...effective,
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
