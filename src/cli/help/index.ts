import { COMPILED } from "../../runtime.ts";
import packageInfo from "../../../package.json";
import { footer, type Page } from "./shared.ts";
import { initPage, setupPage } from "./setup.ts";
import { skillsPage } from "./skills.ts";
import { servicePages } from "./service.ts";
import { diagnosticsPage } from "./diagnostics.ts";
import { upgradePage, versionPage } from "./release.ts";
import { configPage } from "./config.ts";
import { doctorPage } from "./doctor.ts";
import { conversationPage } from "./conversation.ts";
import { mcpPage } from "./mcp.ts";
import { tunnelPage } from "./tunnel.ts";
import { recoverLockPage } from "./locks.ts";

const pages: Page[] = [
  setupPage,
  initPage,
  skillsPage,
  ...servicePages,
  diagnosticsPage,
  upgradePage,
  configPage,
  doctorPage,
  versionPage,
  conversationPage,
  mcpPage,
  tunnelPage,
  recoverLockPage,
];

function leafPages(page: Page): Page[] {
  return page.commands ? page.commands.flatMap(leafPages) : [page];
}

function render(item: Page): string {
  const lines = [...item.usage, "", item.summary];
  if (item.commands?.length) {
    lines.push("", "Commands:");
    for (const child of item.commands) {
      lines.push(`  ${child.usage[0]}`, `      ${child.summary}`);
    }
    const parent = item.command.join(" ");
    lines.push("", `Use convorel ${parent} <command> --help for one command.`);
  }
  if (item.options?.length) {
    lines.push("", "Options:");
    for (const [flag, text] of item.options)
      lines.push(`  ${flag}`, `      ${text}`);
  }
  if (item.notes?.length) lines.push("", ...item.notes);
  lines.push("", footer);
  return lines.join("\n");
}

function root(): string {
  const usage = pages.flatMap((item) =>
    leafPages(item).flatMap((leaf) => leaf.usage),
  );
  return [
    `convorel ${packageInfo.version} (Linux, ${COMPILED ? "standalone" : "source"})`,
    ...usage,
    "",
    "help, -h, and --help show this index and do not run a command.",
    "convorel <command> --help explains that command.",
    "convorel <group> <command> --help explains that subcommand.",
    "A bare conversation, skills, config, mcp, or tunnel lists that group's commands.",
    "",
    "Global options before the command: --config-dir PATH --state-dir PATH.",
    "Defaults: ~/.local/share/convorel and ~/.config/convorel.",
    "Invoke as: bun --no-env-file src/cli.ts ... or the installed executable.",
    "No command installs system tools or creates OpenAI resources.",
    "bun --no-env-file setup.ts installs locked dependencies, then runs setup. convorel setup does not.",
    "",
    "Configuration keys: model, project.url, project.name, tunnel.id, tunnel.apiKey,",
    "mcp.roots, browser.executable, browser.serial, browser.actionIntervalMs,",
    "browser.navigationWaitMs, locks.taskWaitMs, release.baseUrl, diagnostics.enabled.",
    "Run convorel config --help for the value rules.",
  ].join("\n");
}

const helpGroups = new Set([
  "conversation",
  "skills",
  "config",
  "mcp",
  "tunnel",
]);

function isHelpRequest(args: string[]) {
  if (!args.length) return true;
  if (["help", "--help", "-h"].includes(args[0])) return true;
  if (args.includes("--help") || args.includes("-h")) return true;
  return args.length === 1 && helpGroups.has(args[0]);
}

function commandWords(args: string[]) {
  const source = args[0] === "help" ? args.slice(1) : args;
  const words: string[] = [];
  for (const token of source) {
    if (token === "--help" || token === "-h" || token.startsWith("-")) break;
    words.push(token);
  }
  return words;
}

function lookup(words: string[]) {
  const top = pages.find((item) => item.command[0] === words[0]);
  if (!top) return null;
  if (words.length === 1) return top;
  const child = top.commands?.find((item) => item.command[1] === words[1]);
  if (!child) return null;
  return child;
}

/** Help text for a help request, or null when the arguments run a command. */
export function renderHelp(args: string[]) {
  if (!isHelpRequest(args)) return null;
  const words = commandWords(args);
  if (!words.length) return root();
  const found = lookup(words);
  if (!found)
    throw new Error(
      `Unknown help topic: ${words.join(" ")}. Run convorel --help.`,
    );
  return render(found);
}

export function helpTopics() {
  return pages.flatMap(leafPages).map((item) => ({
    args: [...item.command, "--help"],
    usage: item.usage[0],
  }));
}
