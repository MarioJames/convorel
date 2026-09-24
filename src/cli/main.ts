import { localConversationCommand } from "./local-conversation.ts";
import { consumeRuntimeArgs } from "../paths.ts";
import { Browser } from "../browser/browser.ts";
import { Conversation } from "../conversation/conversation.ts";
import { type Config } from "../config/config.ts";
import { WorkspaceAccess, parseRoots } from "../workspace/access.ts";
import { preference, preferenceDirectory } from "../config/preferences.ts";
import { jsonPrinter } from "./output.ts";
import { renderHelp } from "./help/index.ts";
import { opts, rejectUnknown } from "./args.ts";
import { createStore } from "./store.ts";
import {
  conversationFlags,
  runConversation,
  runConversationMigrate,
} from "./conversation.ts";
import { archiveCommands, runArchive } from "./archive.ts";
import { runDiagnostics } from "./diagnostics.ts";
import { runUpgrade, runVersion } from "./release.ts";
import { isServiceCommand, runService } from "./service.ts";
import { runMcp } from "./mcp.ts";
import { runInit, runSetup } from "./init.ts";
import { runSkills } from "./skills.ts";
import { runConfig } from "./config.ts";
import { runRecoverLock } from "./locks.ts";
import { runDoctor, runDoctorLocal } from "./doctor.ts";
import { runTunnelArea } from "./tunnel.ts";

export async function main(args = process.argv.slice(2)) {
  args = consumeRuntimeArgs(args);
  const rendered = renderHelp(args);
  if (rendered !== null) {
    console.log(rendered);
    return 0;
  }
  const [area, sub, ...rest] = args;
  if (!process.execArgv.includes("--no-env-file"))
    throw new Error(
      "ENV_AUTOLOAD_DISABLED_REQUIRED: invoke bun --no-env-file or the installed executable",
    );
  if (area === "conversation") {
    const allowed = conversationFlags[sub ?? ""];
    if (!allowed) throw new Error("UNKNOWN_CONVERSATION_COMMAND");
    rejectUnknown(sub!, Object.keys(opts(rest)), allowed);
  }
  if (area === "diagnostics") return runDiagnostics(args);
  const conversationOptions = area === "conversation" ? opts(rest) : undefined;
  const print = jsonPrinter(conversationOptions?.fields);
  if (area === "version" || area === "--version")
    return runVersion(area, sub, rest, print);
  if (area === "upgrade") return runUpgrade(args, print);
  if (isServiceCommand(area)) return runService(area!, args, print);
  if (area === "mcp") return runMcp(sub, rest);
  if (area === "setup") return runSetup(args, print, main);
  if (area === "skills") return runSkills(sub, rest, print);
  if (area === "config") return runConfig(sub, rest, print);
  const { stateRoot, getStore, assertOutsideSharedRoots } = createStore();
  if (area === "conversation" && sub === "migrate")
    return runConversationMigrate(
      conversationOptions!,
      getStore,
      assertOutsideSharedRoots,
      print,
    );
  if (area === "conversation" && sub && archiveCommands.includes(sub))
    return runArchive(
      sub,
      conversationOptions!,
      stateRoot,
      assertOutsideSharedRoots,
      print,
    );
  if (area === "doctor") {
    const doctorOptions = opts(args.slice(1));
    rejectUnknown("doctor", Object.keys(doctorOptions), ["local"]);
    if (doctorOptions.local !== undefined && doctorOptions.local !== "true")
      throw new Error("DOCTOR_LOCAL_BOOLEAN: --local takes true");
  }
  if (area === "doctor" && opts(args.slice(1)).local === "true")
    return runDoctorLocal(stateRoot, assertOutsideSharedRoots, print);
  const store = getStore();
  if (area === "recover-lock") return runRecoverLock(args, store, print);
  if (area === "init") return runInit(args, store, print);
  if (
    area === "conversation" &&
    (sub === "list" || sub === "status" || sub === "result")
  ) {
    assertOutsideSharedRoots(store.root);
    assertOutsideSharedRoots(preferenceDirectory());
    return localConversationCommand(sub, conversationOptions!, store, print);
  }
  // Existing task operations use their saved task snapshot. A removed checkout
  // must not prevent observing or releasing that task's browser conversation.
  const existingTaskOperation =
    area === "conversation" &&
    [
      "start",
      "retry",
      "recover-send",
      "clear-draft",
      "resume",
      "wait",
      "finish",
      "organize",
      "capture",
    ].includes(sub ?? "");
  if (existingTaskOperation) {
    assertOutsideSharedRoots(store.root);
    assertOutsideSharedRoots(preferenceDirectory());
    const config = store.read<Config>("config");
    return runConversation(
      sub!,
      conversationOptions!,
      new Conversation(store, new Browser(config.cdp, store.root)),
      store,
      print,
    );
  }
  const config = store.read<Config>("config"),
    configuredRoots = preference("mcp.roots"),
    access = new WorkspaceAccess(
      configuredRoots ? parseRoots(configuredRoots) : [config.workspace],
    ),
    browser = new Browser(config.cdp, store.root),
    conversation = new Conversation(store, browser);
  access.assertPrivate(store.root);
  access.assertPrivate(preferenceDirectory());
  const roots = access.roots.map((ws) => ws.root);
  if (area === "doctor") return runDoctor(config, browser, roots, print);
  if (area === "tunnel") return runTunnelArea(sub, rest, config, roots, print);
  if (area !== "conversation") throw new Error("UNKNOWN_COMMAND");
  return runConversation(
    sub!,
    conversationOptions!,
    conversation,
    store,
    print,
  );
}
