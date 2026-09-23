import { command } from "../command.ts";
import { childEnv } from "../process.ts";
import { MODEL_SCRIPT } from "../browser/chatgpt/model.ts";
import { conversationConfig } from "../config/config.ts";
import { selfExec } from "../runtime.ts";
import { openArchive, scanTasks } from "../archive/post-archive.ts";
import type { Browser } from "../browser/browser.ts";
import type { Config } from "../config/config.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageInfo from "../../package.json";
import type { Printer } from "./args.ts";
import { WorkspaceAccess } from "../workspace/access.ts";

export function assertDoctorMcp(
  tools: { name: string }[],
  capabilities: any,
  expectedRoots: { rootId: string; path: string }[],
) {
  const roots = capabilities?.roots;
  if (
    JSON.stringify(tools.map((tool) => tool.name).sort()) !==
      JSON.stringify(["artifact", "capabilities", "exec", "memory"]) ||
    capabilities?.mode !== "guarded" ||
    !Array.isArray(roots) ||
    roots.length !== expectedRoots.length ||
    expectedRoots.some(
      (expected) =>
        roots.filter(
          (root: any) =>
            root?.path === expected.path && root?.rootId === expected.rootId,
        ).length !== 1,
    )
  )
    throw new Error("MCP_CONTRACT_MISMATCH");
}

export function runDoctorLocal(
  stateRoot: string,
  assertOutsideSharedRoots: (path: string) => void,
  print: Printer,
) {
  assertOutsideSharedRoots(stateRoot);
  const scanned = scanTasks(stateRoot);
  const opened = openArchive(stateRoot, { write: true });
  const coverage = opened.archive
    ? scanned.found.map((item) => ({
        taskId: item.taskId,
        ...opened.archive!.coverage(item.task, item.hash),
      }))
    : [];
  const integrity = opened.archive?.integrity();
  print({
    stateDirectory: stateRoot,
    sources: {
      readable: scanned.found.length,
      errors: scanned.errors,
      taskIds: scanned.found.map((item) => item.taskId),
    },
    archive: opened.notice
      ? opened.notice
      : {
          ...opened.archive!.stats(),
          ...integrity,
          coverage,
        },
  });
  opened.archive?.close();
  // A store that fails its own structure or index check is broken rather than merely
  // incomplete, so it exits 1; 2 means the local record is readable but incomplete.
  return opened.notice?.status === "failed" ||
    (integrity &&
      (integrity.integrity_check !== "ok" ||
        integrity.fts_integrity_check !== "ok"))
    ? 1
    : scanned.errors.length || opened.notice
      ? 2
      : coverage.some((item: any) => item.state !== "current")
        ? 2
        : 0;
}

export async function runDoctor(
  config: Config,
  browser: Browser,
  roots: string[],
  print: Printer,
) {
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
      name: "capabilities",
      arguments: {},
    });
    if (info.isError) throw new Error("MCP_INFO_FAILED");
    assertDoctorMcp(
      tools.tools,
      info.structuredContent,
      new WorkspaceAccess(roots).roots.map((root) => ({
        rootId: root.id,
        path: root.root,
      })),
    );
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
