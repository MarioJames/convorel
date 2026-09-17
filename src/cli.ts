#!/usr/bin/env -S bun --no-env-file
import { readFileSync, realpathSync } from "node:fs";
import { State } from "./state.ts";
import { Browser, cdpEndpoint } from "./browser.ts";
import { Conversation, type Config } from "./conversation.ts";
import { Workspace } from "./workspace.ts";
import { WorkspaceAccess, parseRoots } from "./workspace-access.ts";
import { serve } from "./mcp.ts";
import {
  cliPath,
  runTunnel,
  tunnelInstructions,
  recoverTunnelLock,
} from "./tunnel.ts";
import { command, required, childEnv } from "./command.ts";
import { tunnelEnv } from "./tunnel-env.ts";
import { projectId } from "./chatgpt/organize.ts";
import { MODEL_SCRIPT } from "./chatgpt/model.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
function opts(args: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new Error("Expected --option value");
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}
const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const help = `convorel 0.1.0 (Bun, Linux)
setup --workspace PATH --cdp PORT_OR_HTTP [init options]
init --workspace PATH --cdp PORT_OR_HTTP --model LABEL [--project-url URL --project-name NAME --timezone ZONE]
doctor
conversation list
conversation start --id ID --prompt-file FILE [--request-id KEY]
conversation followup --id ID --prompt-file FILE --request-id KEY
conversation status|resume|wait|result --id ID [--run UUID]
conversation retry --id ID --run UUID
conversation finish --id ID --run UUID
conversation attach --id ID --url CONVERSATION --user-message ID
conversation organize --id ID --run UUID --type DES --topic TOPIC
mcp serve [--roots JSON_ARRAY]
tunnel instructions|doctor|run|recover-lock [--tunnel-id ID]
Tunnel ID: --tunnel-id > CONVOREL_TUNNEL_ID environment > installation .env
recover-lock
Use CONVOREL_HOME for a private state directory outside the shared workspace.
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
  if (area === "mcp") {
    if (sub !== "serve") throw new Error("UNKNOWN_MCP_COMMAND");
    const o = opts(rest);
    const roots = o.roots ?? tunnelEnv("CONVOREL_MCP_ROOTS");
    if (!roots) throw new Error("MCP_ROOTS_REQUIRED");
    await serve(parseRoots(roots));
    return 0;
  }
  if (area === "setup") {
    const o = opts(args.slice(1));
    await main([
      "init",
      ...Object.entries(o).flatMap(([k, v]) => ["--" + k, v]),
    ]);
    return main(["doctor"]);
  }
  const store = new State();
  if (area === "recover-lock") {
    print(store.recoverLock());
    return 0;
  }
  if (area === "init") {
    const o = opts(args.slice(1)),
      workspace = new Workspace(required(o, "workspace")).root,
      cdp = cdpEndpoint(required(o, "cdp"));
    if (store.root === workspace || store.root.startsWith(workspace + "/"))
      throw new Error("STATE_INSIDE_WORKSPACE");
    if (o["project-url"]) {
      projectId(o["project-url"]);
      required(o, "project-name");
    }
    if (o.timezone) new Intl.DateTimeFormat("en", { timeZone: o.timezone });
    const config: Config = {
      version: 1,
      workspace,
      cdp,
      model: o.model || "",
      projectUrl: o["project-url"],
      projectName: o["project-name"],
      timezone: o.timezone || "UTC",
      language: "en",
    };
    await store.locked(async () => {
      if (store.has("config")) {
        const old = store.read<Config>("config");
        if (old.workspace !== workspace || old.cdp !== cdp)
          throw new Error(
            "CONFIG_BINDING_IMMUTABLE: choose a separate CONVOREL_HOME for another workspace/browser",
          );
      }
      const old = store.has("config")
        ? store.read<Config>("config")
        : undefined;
      if (old) {
        if (!o.model) config.model = old.model;
        if (!o["project-url"]) config.projectUrl = old.projectUrl;
        if (!o["project-name"]) config.projectName = old.projectName;
        if (!o.timezone) config.timezone = old.timezone;
        config.language = old.language;
      }
      if (!config.model.trim())
        throw new Error("MODEL_REQUIRED: initialize with --model LABEL");
      store.write("config", config);
    });
    print({ ...config, stateDirectory: store.root });
    return 0;
  }
  const config = store.read<Config>("config"),
    configuredRoots = tunnelEnv("CONVOREL_MCP_ROOTS"),
    access = new WorkspaceAccess(
      configuredRoots ? parseRoots(configuredRoots) : [config.workspace],
    ),
    browser = new Browser(config.cdp, store.root),
    conversation = new Conversation(store, browser);
  access.assertPrivate(store.root);
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
        report.browser.expectedModel = config.model;
      }
    } catch (e) {
      report.browser = { status: "failed", error: String(e) };
    }
    const client = new Client({ name: "convorel-doctor", version: "0.1.0" }),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--no-env-file",
          cliPath,
          "mcp",
          "serve",
          "--roots",
          JSON.stringify(roots),
        ],
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
      id = o["tunnel-id"] ?? tunnelEnv("CONVOREL_TUNNEL_ID");
    if (!id)
      throw new Error(
        "TUNNEL_ID_MISSING: set --tunnel-id or CONVOREL_TUNNEL_ID in the environment or convorel .env",
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
      })),
    );
    return 0;
  }
  const o = opts(rest),
    id = required(o, "id");
  if (sub === "start" || sub === "followup") {
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
    );
    print(t);
    return ["waiting", "complete"].includes(t.runs.at(-1)!.state) ? 0 : 2;
  }
  if (sub === "retry") {
    const t = await conversation.retry(id, required(o, "run"));
    print(t);
    return ["waiting", "complete"].includes(t.runs.at(-1)!.state) ? 0 : 2;
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
    print(t);
    return 0;
  }
  if (sub === "resume") {
    print(await conversation.resume(id, o.run));
    return 0;
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
    print(
      await conversation.organize(
        id,
        required(o, "run"),
        required(o, "type"),
        required(o, "topic"),
      ),
    );
    return 0;
  }
  if (sub === "wait") {
    const run = o.run || conversation.get(id).currentRun;
    const seconds = Number(o["timeout-seconds"] || 1800);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
      throw new Error("INVALID_TIMEOUT");
    const deadline = Date.now() + seconds * 1000;
    let stop = false;
    const signal = () => {
      stop = true;
    };
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    try {
      while (!stop && Date.now() < deadline) {
        const t = await conversation.poll(id, run),
          r = t.runs.at(-1)!;
        print({ id, runId: run, state: r.state, error: r.error });
        if (r.state === "complete") return 0;
        if (r.state !== "waiting") return 2;
        await Bun.sleep(Math.min(60000, Math.max(1, deadline - Date.now())));
      }
      print({
        id,
        runId: run,
        state: stop ? "cancelled" : "timeout",
        remoteGenerationStopped: false,
      });
      return 2;
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
