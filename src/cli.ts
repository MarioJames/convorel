#!/usr/bin/env -S bun --no-env-file
import { readFileSync, realpathSync } from "node:fs";
import {
  State,
  registryLockName,
  tabsLockName,
  taskLockName,
} from "./state.ts";
import { Browser, cdpEndpoint } from "./browser.ts";
import { Conversation, type Config } from "./conversation.ts";
import { Workspace } from "./workspace.ts";
import { WorkspaceAccess, parseRoots } from "./workspace-access.ts";
import { serve } from "./mcp.ts";
import { runTunnel, tunnelInstructions, recoverTunnelLock } from "./tunnel.ts";
import { command, required, childEnv } from "./command.ts";
import { jsonPrinter } from "./output.ts";
import { settingValue } from "./env.ts";
import { agentBrowserLocation, COMPILED, selfExec } from "./runtime.ts";
import { conversationConfig } from "./config.ts";
import { configCommand } from "./config-command.ts";
import { preferenceDirectory } from "./user-config.ts";
import { installSkill } from "./skills.ts";
import {
  forwardedEnvironment,
  manageService,
  serviceLogs,
  serviceStatus,
} from "./service.ts";
import { upgrade, versionCheck } from "./upgrade.ts";
import { waitForConversation, watcherLockName } from "./wait.ts";
import {
  conversationStatus,
  conversationExitCode,
} from "./conversation-status.ts";
import { MODEL_SCRIPT } from "./chatgpt/model.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageInfo from "../package.json";
function opts(args: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new Error("Expected --option value");
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}
const help = `convorel ${packageInfo.version} (Linux, ${COMPILED ? "standalone" : "source"})
setup --workspace PATH --cdp PORT_OR_HTTP [--agent codex|claude-code|codex,claude-code]
init --workspace PATH --cdp PORT_OR_HTTP
skills install --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH]
skills install --dir PATH
start|stop|restart|status [--tunnel-id ID]
logs [--tunnel-id ID] [--lines NUMBER] [--follow]
upgrade [--version TAG]
config list|get KEY|set KEY VALUE|unset KEY|path|import-env
doctor
version [--check]|--version
conversation list
conversation start --id ID --prompt-file FILE [--type DES --topic TOPIC] [--language en|zh] [--request-id KEY] [--workspace PATH]
conversation followup --id ID --prompt-file FILE --request-id KEY [--workspace PATH]
conversation status|resume|wait|result --id ID [--run UUID]
conversation retry --id ID --run UUID [--workspace PATH]
conversation recover-send --id ID --run UUID --expected-user-message ID --expected-url URL --prompt-file FILE --evidence-file FILE --rejected-at UNIX_MS --confirm-cloudflare-challenge true --reason TEXT [--workspace PATH]
conversation clear-draft --id ID --run UUID --expected-draft-file FILE
conversation rebind-workspace --id ID --run UUID --from-workspace PATH --workspace PATH
conversation status --id ID [--run UUID] [--workspace EXPECTED_PATH]
conversation finish --id ID --run UUID
conversation attach --id ID --url CONVERSATION --user-message ID
conversation organize --id ID --run UUID --type DES --topic TOPIC [--language en|zh]
All conversation commands: [--fields id,currentRun,summary] selects top-level JSON fields.
Lists select fields per item; missing fields are null. Exit codes are unchanged.
mcp serve [--roots JSON_ARRAY]
tunnel instructions|doctor|run|recover-lock [--tunnel-id ID]
Model/project: CONVOREL_MODEL, CONVOREL_PROJECT_URL, CONVOREL_PROJECT_NAME
Precedence: command line > process environment (including empty) > installation .env > preferences file
Tunnel ID: --tunnel-id > CONVOREL_TUNNEL_ID environment > preferences file
Unset model: Latest + maximum Pro. config path prints the preferences file.
recover-lock --task ID | --watch-task ID | --registry true | --tabs true | --name NAME
Reclaims only a lock whose recorded process identity is dead; never a live owner's.
Use CONVOREL_HOME for a private state directory outside the shared workspace, and CONVOREL_CONFIG_HOME for another preferences file.
Invoke as: bun --no-env-file src/cli.ts ... or the installed executable.
No command installs system tools or creates OpenAI resources.`;
export async function main(args = process.argv.slice(2)) {
  const [area, sub, ...rest] = args;
  if (!area || ["--help", "help"].includes(area)) {
    console.log(help);
    return 0;
  }
  if (!process.execArgv.includes("--no-env-file"))
    throw new Error(
      "ENV_AUTOLOAD_DISABLED_REQUIRED: invoke bun --no-env-file or the installed executable",
    );
  const conversationOptions = area === "conversation" ? opts(rest) : undefined;
  const print = jsonPrinter(conversationOptions?.fields);
  if (area === "version" || area === "--version") {
    if (
      rest.length ||
      (sub !== undefined && !(area === "version" && sub === "--check"))
    )
      throw new Error("Expected version [--check] or --version");
    if (area === "--version") console.log(packageInfo.version);
    else
      print({
        version: packageInfo.version,
        commit: process.env.CONVOREL_BUILD_COMMIT || "source checkout",
        runtime: COMPILED ? "standalone" : `bun ${Bun.version}`,
        architecture: process.arch,
        browserController: agentBrowserLocation(),
        ...(sub === "--check" ? await versionCheck() : {}),
      });
    return 0;
  }
  if (area === "upgrade") {
    const o = opts(args.slice(1));
    for (const key of Object.keys(o))
      if (key !== "version") throw new Error(`Unknown upgrade option --${key}`);
    if (o.version !== undefined && !o.version)
      throw new Error("Missing --version");
    print(await upgrade(o.version));
    return 0;
  }
  if (["start", "stop", "restart", "status", "logs"].includes(area)) {
    const values = args.slice(1);
    const follow = area === "logs" && values.includes("--follow");
    const o = opts(
      follow ? values.filter((value) => value !== "--follow") : values,
    );
    for (const key of Object.keys(o))
      if (key !== "tunnel-id" && !(area === "logs" && key === "lines"))
        throw new Error(`Unknown ${area} option --${key}`);
    const id = o["tunnel-id"] ?? settingValue("CONVOREL_TUNNEL_ID");
    if (!id)
      throw new Error(
        "TUNNEL_ID_MISSING: pass --tunnel-id or configure tunnel.id",
      );
    if (area === "status") print(serviceStatus(id));
    else if (area === "logs") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.on("SIGINT", abort);
      process.on("SIGTERM", abort);
      try {
        return await serviceLogs(
          id,
          Number(o.lines ?? 100),
          follow,
          controller.signal,
        );
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    } else {
      // Stopping remains possible even if the workspace or configuration has gone away.
      const config =
        area === "stop" ? undefined : new State().read<Config>("config");
      print(
        await manageService(
          area as "start" | "stop" | "restart",
          id,
          config?.workspace,
          forwardedEnvironment(),
        ),
      );
    }
    return 0;
  }
  if (area === "mcp") {
    if (sub !== "serve") throw new Error("UNKNOWN_MCP_COMMAND");
    const o = opts(rest);
    const roots = o.roots ?? settingValue("CONVOREL_MCP_ROOTS");
    if (!roots) throw new Error("MCP_ROOTS_REQUIRED");
    await serve(parseRoots(roots));
    return 0;
  }
  if (area === "setup") {
    const o = opts(args.slice(1));
    const agent = o.agent;
    delete o.agent;
    await main([
      "init",
      ...Object.entries(o).flatMap(([k, v]) => ["--" + k, v]),
    ]);
    if (agent) print(await installSkill({ agent }));
    return main(["doctor"]);
  }
  if (area === "skills") {
    if (sub !== "install") throw new Error("UNKNOWN_SKILLS_COMMAND");
    print(await installSkill(opts(rest)));
    return 0;
  }
  if (area === "config") {
    print(configCommand(sub, rest));
    return 0;
  }
  const store = new State();
  if (area === "recover-lock") {
    const o = opts(args.slice(1));
    const name = o["watch-task"]
      ? watcherLockName(o["watch-task"])
      : o.task
        ? taskLockName(o.task)
        : o.registry
          ? registryLockName()
          : o.tabs
            ? tabsLockName()
            : o.name;
    if (!name)
      throw new Error(
        "LOCK_NAME_REQUIRED: pass --task ID | --watch-task ID | --registry true | --tabs true | --name NAME",
      );
    print(store.recoverLock(name));
    return 0;
  }
  if (area === "init") {
    const o = opts(args.slice(1)),
      workspace = new Workspace(required(o, "workspace")).root,
      cdp = cdpEndpoint(required(o, "cdp"));
    if (store.root === workspace || store.root.startsWith(workspace + "/"))
      throw new Error("STATE_INSIDE_WORKSPACE");
    for (const key of Object.keys(o))
      if (!["workspace", "cdp"].includes(key))
        throw new Error(
          `Unknown init option --${key}; configure model/project through CONVOREL_* environment variables`,
        );
    const config: Config = { version: 1, workspace, cdp };
    const effective = conversationConfig(config);
    await store.locked(async () => {
      if (store.has("config")) {
        const old = store.read<Config>("config");
        if (old.workspace !== workspace || old.cdp !== cdp)
          throw new Error(
            "CONFIG_BINDING_IMMUTABLE: choose a separate CONVOREL_HOME for another workspace/browser",
          );
      }
      store.write("config", config);
    }, "config");
    print({
      ...effective,
      modelPolicy: effective.model || "latest-pro",
      stateDirectory: store.root,
    });
    return 0;
  }
  const config = store.read<Config>("config"),
    configuredRoots = settingValue("CONVOREL_MCP_ROOTS"),
    access = new WorkspaceAccess(
      configuredRoots ? parseRoots(configuredRoots) : [config.workspace],
    ),
    browser = new Browser(config.cdp, store.root),
    conversation = new Conversation(store, browser);
  access.assertPrivate(store.root);
  access.assertPrivate(preferenceDirectory());
  const roots = access.roots.map((ws) => ws.root);
  if (area === "doctor") {
    const report: any = {
      agentBrowser: null,
      browser: { status: "not_run" },
      localMcp: { status: "not_run" },
      tunnel: { installed: !!Bun.which("tunnel-client"), status: "not_run" },
      chatgptMcp: { status: "not_run" },
    };
    try {
      report.agentBrowser = (
        await command(["agent-browser", "--version"])
      ).trim();
      const epoch = await browser.epoch();
      const { tabs } = await browser.tabs("list");
      report.browser = {
        status: "connected",
        epoch,
        chatgptTabs: tabs.filter((x: any) =>
          x.url?.startsWith("https://chatgpt.com/"),
        ).length,
        ui: "not_run",
        model: "not_run",
      };
      const target = tabs.find((x: any) =>
        x.url?.startsWith("https://chatgpt.com/"),
      );
      if (target) {
        const b = await browser.page(target.targetId),
          p = await b.read(),
          m = (await b.run("eval", MODEL_SCRIPT)).result;
        report.browser.ui =
          p.blocked ||
          (!p.hasComposer ? "unrecognized_or_loading" : "recognized");
        report.browser.model = m.control?.label || "unavailable";
        report.browser.expectedModel =
          conversationConfig(config).model || "latest-pro";
      }
    } catch (e) {
      report.browser = { status: "failed", error: String(e) };
    } finally {
      await browser.release();
    }
    const [selfCommand, ...selfArgs] = selfExec([
      "mcp",
      "serve",
      "--roots",
      JSON.stringify(roots),
    ]);
    const client = new Client({
        name: "convorel-doctor",
        version: packageInfo.version,
      }),
      transport = new StdioClientTransport({
        command: selfCommand,
        args: selfArgs,
        env: childEnv(),
        stderr: "pipe",
      });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const info = await client.callTool({
        name: "workspace_info",
        arguments: {},
      });
      if (info.isError) throw new Error("MCP_INFO_FAILED");
      report.localMcp = {
        status: "verified",
        tools: tools.tools.map((t) => t.name),
        roots: (info.structuredContent as any).roots,
      };
    } catch (e) {
      report.localMcp = { status: "failed", error: String(e) };
    } finally {
      await client.close();
      await transport.close();
    }
    print(report);
    return report.browser.status === "failed" ||
      report.localMcp.status === "failed"
      ? 1
      : 0;
  }
  if (area === "tunnel") {
    const o = opts(rest),
      id = o["tunnel-id"] ?? settingValue("CONVOREL_TUNNEL_ID");
    if (!id)
      throw new Error(
        "TUNNEL_ID_MISSING: pass --tunnel-id, or set CONVOREL_TUNNEL_ID with convorel config set tunnel.id",
      );
    if (sub === "instructions") {
      print(tunnelInstructions(id, config.workspace, roots));
      return 0;
    }
    if (sub === "recover-lock") {
      print(recoverTunnelLock(id, config.workspace));
      return 0;
    }
    if (sub === "run" || sub === "doctor")
      return runTunnel(sub, id, config.workspace, roots);
    throw new Error("UNKNOWN_TUNNEL_COMMAND");
  }
  if (area !== "conversation") throw new Error("UNKNOWN_COMMAND");
  if (sub === "list") {
    print(
      store.tasks().map((t) => ({
        id: t.id,
        url: t.url,
        currentRun: t.currentRun,
        state: t.runs.at(-1)?.state,
        locked: store.isLockedActive(taskLockName(t.id)),
        summary: conversationStatus(t),
      })),
    );
    return 0;
  }
  const o = conversationOptions!,
    id = required(o, "id");
  if (sub === "start" || sub === "followup") {
    const naming =
      o.type || o.topic || o.language
        ? {
            type: required(o, "type"),
            topic: required(o, "topic"),
            language: (o.language || "en") as "en" | "zh",
          }
        : undefined;
    const input = readFileSync(
      realpathSync(required(o, "prompt-file")),
      "utf8",
    );
    const t = await conversation.start(
      id,
      input,
      sub === "followup"
        ? required(o, "request-id")
        : o["request-id"] || "initial",
      sub === "followup",
      o.workspace,
      naming,
    );
    print({ ...t, summary: conversationStatus(t) });
    return conversationExitCode(t, "start");
  }
  if (sub === "retry") {
    const t = await conversation.retry(id, required(o, "run"), o.workspace);
    print({ ...t, summary: conversationStatus(t) });
    return conversationExitCode(t, "start");
  }
  if (sub === "recover-send") {
    const t = await conversation.recoverSend(
      id,
      required(o, "run"),
      {
        expectedUserMessageId: required(o, "expected-user-message"),
        expectedUrl: required(o, "expected-url"),
        input: readFileSync(realpathSync(required(o, "prompt-file")), "utf8"),
        evidence: JSON.parse(
          readFileSync(realpathSync(required(o, "evidence-file")), "utf8"),
        ),
        rejectedAt: Number(required(o, "rejected-at")),
        confirmCloudflareChallenge:
          required(o, "confirm-cloudflare-challenge") === "true",
        reason: required(o, "reason"),
      },
      o.workspace,
    );
    print({ ...t, summary: conversationStatus(t) });
    return conversationExitCode(t, "start");
  }
  if (sub === "rebind-workspace") {
    const t = await conversation.rebindWorkspace(
      id,
      required(o, "run"),
      required(o, "from-workspace"),
      required(o, "workspace"),
    );
    print({ ...t, summary: conversationStatus(t) });
    return 0;
  }
  if (sub === "clear-draft") {
    const expected = readFileSync(
      realpathSync(required(o, "expected-draft-file")),
      "utf8",
    );
    const t = await conversation.clearDraft(id, required(o, "run"), expected);
    print({ ...t, summary: conversationStatus(t) });
    return 0;
  }
  if (sub === "attach") {
    print(
      await conversation.attach(
        id,
        required(o, "url"),
        required(o, "user-message"),
      ),
    );
    return 0;
  }
  if (sub === "status") {
    const t = conversation.get(id);
    if (o.run && o.run !== t.currentRun) throw new Error("STALE_RUN");
    const expected = o.workspace ? new Workspace(o.workspace).root : undefined;
    const workspaceMismatch =
      expected && expected !== t.config.workspace
        ? {
            expected,
            bound: t.config.workspace,
            recovery:
              t.runs.length === 1 &&
              t.runs[0].state === "prepared" &&
              !t.runs[0].userMessageId &&
              !t.url
                ? "rebind-workspace"
                : "inspect_saved_prompt_and_binding",
          }
        : null;
    print({
      ...t,
      summary: conversationStatus(t),
      workspaceMismatch,
      locked: store.isLockedActive(taskLockName(id)),
    });
    return workspaceMismatch ? 2 : 0;
  }
  if (sub === "resume") {
    try {
      const t = await conversation.resume(id, o.run);
      print({ ...t, summary: conversationStatus(t) });
      return conversationExitCode(t, "resume");
    } catch (e) {
      const t = conversation.get(id);
      if (o.run && o.run !== t.currentRun) throw e;
      if (
        t.runs.find((r) => r.id === t.currentRun)?.observationError?.message !==
        String(e)
      )
        throw e;
      print({ ...t, summary: conversationStatus(t), error: String(e) });
      return 2;
    }
  }
  if (sub === "result") {
    print(conversation.result(id, o.run));
    return 0;
  }
  if (sub === "finish") {
    print(await conversation.finish(id, required(o, "run")));
    return 0;
  }
  if (sub === "organize") {
    const organization = await conversation.organize(
      id,
      required(o, "run"),
      required(o, "type"),
      required(o, "topic"),
      o.language || "en",
    );
    print(organization);
    return organization.verified === true ? 0 : 2;
  }
  if (sub === "wait") {
    const run = o.run || conversation.get(id).currentRun;
    const seconds = Number(o["timeout-seconds"] || 1800);
    const controller = new AbortController();
    const signal = () => controller.abort();
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    try {
      return await waitForConversation(
        store,
        conversation,
        id,
        run,
        seconds,
        controller.signal,
        print,
      );
    } finally {
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
    }
  }
  throw new Error("UNKNOWN_CONVERSATION_COMMAND");
}
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(JSON.stringify({ error: String(e) }));
    process.exitCode = 1;
  }
}
