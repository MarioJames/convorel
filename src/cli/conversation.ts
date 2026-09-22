import { readFileSync, realpathSync } from "node:fs";
import type { Conversation } from "../conversation/conversation.ts";
import type { State } from "../storage/state.ts";
import { required } from "../command.ts";
import {
  conversationExitCode,
  conversationStatus,
} from "../conversation/status.ts";
import { waitForConversation } from "../conversation/wait.ts";
import type { Printer } from "./args.ts";

export const conversationFlags: Record<string, string[]> = {
  list: ["fields"],
  create: [
    "id",
    "prompt",
    "prompt-stdin",
    "type",
    "topic",
    "language",
    "request-id",
    "workspace",
    "fields",
  ],
  // followup still accepts naming flags so the command can reject them explicitly.
  followup: [
    "id",
    "prompt",
    "prompt-stdin",
    "type",
    "topic",
    "language",
    "request-id",
    "workspace",
    "fields",
  ],
  start: ["id", "run", "workspace", "fields"],
  migrate: ["id", "fields"],
  status: ["id", "run", "workspace", "fields"],
  resume: ["id", "run", "fields"],
  wait: ["id", "run", "timeout-seconds", "fields"],
  result: ["id", "run", "fields"],
  retry: ["id", "run", "workspace", "fields"],
  "recover-send": [
    "id",
    "run",
    "expected-user-message",
    "expected-url",
    "prompt-file",
    "evidence-file",
    "rejected-at",
    "confirm-cloudflare-challenge",
    "reason",
    "workspace",
    "fields",
  ],
  "clear-draft": ["id", "run", "expected-draft-file", "fields"],
  "rebind-workspace": ["id", "run", "from-workspace", "workspace", "fields"],
  finish: ["id", "run", "fields"],
  attach: ["id", "url", "user-message", "fields"],
  organize: ["id", "run", "type", "topic", "language", "fields"],
  archive: ["id", "all", "fields"],
  capture: ["id", "run", "workspace", "fields"],
  history: ["id", "run", "from", "coverage", "fields"],
  search: ["query", "task", "role", "limit", "from", "fields"],
  content: ["version", "from", "fields"],
  export: ["directory", "fields"],
};

export async function promptInput(o: Record<string, string>) {
  const inline = o.prompt !== undefined;
  const stdin = o["prompt-stdin"] !== undefined;
  if (inline === stdin || (stdin && o["prompt-stdin"] !== "true"))
    throw new Error(
      "Choose exactly one of --prompt TEXT or --prompt-stdin true",
    );
  if (inline) return o.prompt;
  if (process.stdin.isTTY) throw new Error("PROMPT_STDIN_REQUIRES_PIPE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 100000) {
        await reader.cancel();
        throw new Error("PROMPT_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

export async function runConversationMigrate(
  o: Record<string, string>,
  getStore: () => State,
  assertOutsideSharedRoots: (path: string) => void,
  print: Printer,
) {
  const store = getStore();
  assertOutsideSharedRoots(store.root);
  print(await store.migrateTask(required(o, "id")));
  return 0;
}

export async function runConversation(
  sub: string,
  o: Record<string, string>,
  conversation: Conversation,
  store: State,
  print: Printer,
) {
  const id = required(o, "id");
  if (sub === "create" || sub === "followup") {
    const naming =
      o.type || o.topic || o.language
        ? {
            type: required(o, "type"),
            topic: required(o, "topic"),
            language: (o.language || "en") as "en" | "zh",
          }
        : undefined;
    const input = await promptInput(o);
    const t = await conversation.create(
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
    return 0;
  }
  if (sub === "start") {
    const t = await conversation.start(id, required(o, "run"), o.workspace);
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
  if (sub === "capture") {
    const result = await conversation.capture(id, o.run, o.workspace);
    print(result);
    // A requested capture that produced nothing is not a success, and the archive
    // outcome is reported apart from the run state it must never change.
    return result.archive?.status === "failed"
      ? 1
      : result.gaps.length || result.archive?.status !== "stored"
        ? 2
        : 0;
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
