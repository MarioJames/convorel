import { Database } from "bun:sqlite";
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation.ts";
import {
  diagnosticCode,
  Diagnostics,
  diagnosticsEnabled,
  diagnosticsPath,
  readDiagnostics,
} from "../src/diagnostics.ts";
import { State } from "../src/state.ts";
import { conversationStatus } from "../src/conversation-status.ts";
import { childEnv } from "../src/command.ts";
import { writePreference } from "../src/user-config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "convorel-diagnostics-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = "task-one";
const run = "11111111-1111-4111-8111-111111111111";

test("diagnostic codes keep the token and drop page text", () => {
  expect(
    diagnosticCode(new Error("NEEDS_ATTENTION: Human verification required")),
  ).toBe("NEEDS_ATTENTION");
  expect(
    diagnosticCode(
      "Error: BROWSER_ERROR: " + JSON.stringify({ secret: "cookie" }),
    ),
  ).toBe("BROWSER_ERROR");
  expect(diagnosticCode(new Error("SQLITE_BUSY"))).toBe("UNCLASSIFIED");
  expect(diagnosticCode(new Error("transport disconnected after submit"))).toBe(
    "UNCLASSIFIED",
  );
  expect(diagnosticsEnabled(() => undefined)).toBe(true);
  expect(diagnosticsEnabled(() => "true")).toBe(true);
  expect(diagnosticsEnabled(() => "false")).toBe(false);
  expect(diagnosticsEnabled(() => "yes")).toBe(false);
  expect(
    diagnosticsEnabled(() => {
      throw new Error("PREFERENCES_READ_FAILED: /private/preferences.json");
    }),
  ).toBe(false);
});

test("phases are stored once per run and a locked writer does not stick", () => {
  const log = new Diagnostics(root);
  expect(log.rememberPhase(task, run, "prepared")).toBe("stored");
  expect(log.rememberPhase(task, run, "prepared")).toBe("same");
  const held = new Database(diagnosticsPath(root));
  held.exec("begin immediate");
  expect(log.rememberPhase(task, run, "waiting")).toBe("skipped");
  held.exec("rollback");
  held.close();
  expect(log.rememberPhase(task, run, "waiting")).toBe("stored");
  const view = readDiagnostics(root, task);
  expect(view).toMatchObject({
    status: "ok",
    complete: false,
    authority: "task-document",
  });
  expect(
    view.events.map((event) => [event.seq, event.event, event.code]),
  ).toEqual([
    [1, "phase", "prepared"],
    [2, "phase", "waiting"],
  ]);
  expect("nextAction" in view).toBe(false);
  expect(readDiagnostics(root, "other-task")).toMatchObject({
    status: "empty",
    events: [],
  });
});

test("failures store a code and refuse free text", () => {
  const log = new Diagnostics(root);
  log.failure({
    taskId: task,
    runId: run,
    event: "observe_failed",
    step: "observe",
    code: "CDP_UNAVAILABLE",
    retryable: true,
  });
  log.failure({
    taskId: task,
    runId: run,
    event: "operation_result",
    step: "send",
    code: "prompt text must not be a code",
  });
  const view = readDiagnostics(root, task);
  expect(view.events).toHaveLength(1);
  expect(view.events[0]).toMatchObject({
    event: "observe_failed",
    code: "CDP_UNAVAILABLE",
    retryable: true,
    step: "observe",
  });
  expect(readFileSync(diagnosticsPath(root), "utf8")).not.toContain(
    "prompt text",
  );
});

test("disabled, unreadable preferences and low space do not create or extend the store", () => {
  const off = new Diagnostics(root, { enabled: () => false });
  expect(off.rememberPhase(task, run, "prepared")).toBe("disabled");
  expect(off.rememberPhase(task, run, "waiting")).toBe("disabled");
  const broken = new Diagnostics(root, {
    enabled: () => {
      throw new Error("PREFERENCES_READ_FAILED: /secret/path");
    },
  });
  expect(broken.rememberPhase(task, run, "prepared")).toBe("disabled");
  expect(readDiagnostics(root, task).status).toBe("missing");
  const full = new Diagnostics(root, { freeFloor: Number.MAX_SAFE_INTEGER });
  expect(full.rememberPhase(task, run, "prepared")).toBe("skipped");
  expect(readDiagnostics(root, task).status).toBe("missing");
});

test("reads distinguish a missing store, an empty task and an unreadable file", () => {
  expect(readDiagnostics(root, task)).toMatchObject({ status: "missing" });
  expect(() => readDiagnostics(root, "Bad")).toThrow("INVALID_TASK_ID");
  const log = new Diagnostics(root);
  log.rememberPhase(task, run, "prepared");
  rmSync(diagnosticsPath(root));
  writeFileSync(diagnosticsPath(root), "not a database");
  expect(() => readDiagnostics(root, task)).toThrow("DIAGNOSTICS_UNREADABLE");
  expect(() => readDiagnostics(root, task, "not-a-uuid")).toThrow(
    "INVALID_RUN_ID",
  );
});

test("a diagnostics failure does not change send permission or copy the prompt", async () => {
  const workspace = join(root, "code");
  mkdirSync(workspace);
  const state = new State(root);
  state.write("config", { version: 1, workspace, cdp: "9222", model: "6 Pro" });
  const prompt = "super-secret-prompt-value";
  const browser = new FakeBrowser();
  browser.blocked = "UNIQUE_PAGE_TEXT";
  const conversation = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const blocked = await sendPrepared(conversation, "blocked-task", prompt);
  expect(blocked.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(conversationStatus(blocked).phase).toBe("before_send");
  const recorded = readDiagnostics(root, "blocked-task");
  expect(
    recorded.events.map((event) => [event.event, event.code, event.step]),
  ).toEqual([
    ["phase", "prepared", null],
    ["operation_result", "NEEDS_ATTENTION", "observe"],
  ]);
  const bytes = readFileSync(diagnosticsPath(root));
  expect(bytes.includes(Buffer.from(prompt))).toBe(false);
  expect(bytes.includes(Buffer.from("UNIQUE_PAGE_TEXT"))).toBe(false);

  rmSync(diagnosticsPath(root));
  mkdirSync(diagnosticsPath(root));
  const live = new FakeBrowser();
  const sender = new Conversation(state, live as any, async () => ({
    observedModel: "6 Pro",
  }));
  const sent = await sendPrepared(sender, "send-task", prompt);
  expect(sent.runs[0].state).toBe("waiting");
  expect(live.sends).toBe(1);
});

test("the diagnostics command reads the private store without Chrome", async () => {
  const log = new Diagnostics(root);
  log.rememberPhase(task, run, "prepared");
  const missing = await runCli(join(root, "absent"), ["--task", task]);
  expect(missing.status).toBe(0);
  expect(missing.json).toMatchObject({
    status: "missing",
    complete: false,
    events: [],
  });
  const found = await runCli(root, ["--task", task, "--run", run]);
  expect(found.status).toBe(0);
  expect(found.json.events).toHaveLength(1);
  const bad = await runCli(root, ["--task", task, "--run", "nope"]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("INVALID_RUN_ID");
});

test("diagnostics.enabled accepts only true or false", () => {
  expect(() => writePreference("diagnostics.enabled", "yes")).toThrow(
    "INVALID_VALUE: diagnostics.enabled must be true or false",
  );
});

class FakeBrowser {
  sends = 0;
  blocked: string | null = null;
  targets: any[] = [];
  pages = new Map<string, any>();
  private static next = 0;
  async epoch() {
    return "epoch";
  }
  async release() {}
  async tabs(...args: string[]) {
    if (args[0] === "list") return { tabs: this.targets };
    if (args[0] === "new") {
      const targetId = "target" + ++FakeBrowser.next;
      const page = {
        url: args[1],
        messages: [],
        generating: false,
        hasComposer: true,
        blocked: this.blocked,
        draft: "",
        sendReady: true,
        attachments: false,
      };
      this.targets.push({ targetId, url: args[1] });
      this.pages.set(targetId, page);
      return { targetId };
    }
    return {};
  }
  async page(target: string) {
    const page = this.pages.get(target);
    return {
      session: "fake",
      read: async () => structuredClone(page),
      run: async (...args: string[]) => {
        if (args[0] === "fill") page.draft = args[2];
        if (args[0] === "click") {
          this.sends++;
          const text = page.draft;
          page.draft = "";
          page.url = "https://chatgpt.com/c/test-conversation";
          this.targets.find((item) => item.targetId === target).url = page.url;
          page.messages.push({
            id: "u1",
            role: "user",
            text,
            final: false,
          });
          page.generating = true;
        }
        return {};
      },
    };
  }
}

async function sendPrepared(
  conversation: Conversation,
  id: string,
  prompt: string,
) {
  // The working tree splits prompt creation from sending. HEAD sends in start.
  if (typeof (conversation as { create?: Function }).create === "function") {
    const prepared = await (
      conversation as unknown as {
        create: (id: string, prompt: string) => Promise<{ currentRun: string }>;
        start: (id: string, run: string) => Promise<any>;
      }
    ).create(id, prompt);
    return (
      conversation as unknown as {
        start: (id: string, run: string) => Promise<any>;
      }
    ).start(id, prepared.currentRun);
  }
  return (
    conversation as unknown as {
      start: (id: string, prompt: string) => Promise<any>;
    }
  ).start(id, prompt);
}

async function runCli(state: string, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "--state-dir",
      state,
      "--config-dir",
      join(root, "prefs"),
      "diagnostics",
      ...args,
    ],
    { env: childEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    status,
    stderr,
    json: stdout.trim() ? JSON.parse(stdout) : null,
  };
}
