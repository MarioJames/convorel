import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { preference, writePreference } from "../../src/config/preferences.ts";
import { State } from "../../src/storage/state.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { conversationStatus } from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";
import { composePrompt } from "../../src/conversation/prompt.ts";
import { sha } from "../../src/hash.ts";

const { setup, start, home, ws, completedWithClaimedTab } =
  conversationHarness();

test("model drift after filling the draft stops before sending", async () => {
  const { state, browser } = setup();
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => ({
      observedModel: opts["verify-only"] === "true" ? "Changed model" : "6 Pro",
    }),
  );
  const t = await start(conversation, "model-drift", "Conversation");
  expect(t.runs[0]).toMatchObject({
    state: "prepared",
    error: "Error: MODEL_CHANGED_BEFORE_SEND",
  });
  expect(browser.sends).toBe(0);
  expect([...browser.pages.values()][0].draft).toContain(t.runs[0].marker);
});
test("an obstructed Send button retains a prepared run without clicking", async () => {
  const { browser, conversation } = setup();
  browser.sendReady = false;
  const t = await start(conversation, "obstructed", "Conversation");
  expect(t.runs[0]).toMatchObject({
    state: "prepared",
    error: "Error: SEND_CONTROL_UNAVAILABLE",
  });
  expect(browser.sends).toBe(0);
  [...browser.pages.values()][0].sendReady = true;
  expect((await conversation.retry(t.id, t.currentRun)).runs[0].state).toBe(
    "waiting",
  );
  expect(browser.sends).toBe(1);
});

test("a draft changed during pacing cannot be sent", async () => {
  const { browser, conversation } = setup();
  browser.gate = async (where) => {
    if (where === "before-dispatch:click:target1")
      browser.pages.get("target1").draft = "Someone else's draft";
  };
  const t = await start(conversation, "paced-draft", "Review");
  expect(t.runs[0].state).toBe("prepared");
  expect(t.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(0);
  expect(browser.pages.get("target1").draft).toBe("Someone else's draft");
});

test("a run manually submitted during pacing is reconciled without a second click", async () => {
  const { browser, conversation } = setup();
  browser.gate = async (where) => {
    if (where !== "before-dispatch:click:target1") return;
    const page = browser.pages.get("target1");
    page.messages.push({
      id: "manual-user",
      role: "user",
      text: page.draft,
      final: false,
    });
    page.draft = "";
    page.generating = true;
    page.url = "https://chatgpt.com/c/test-conversation";
    browser.targets[0].url = page.url;
  };
  const t = await start(conversation, "paced-manual", "Review");
  expect(t.runs[0].state).toBe("waiting");
  expect(t.runs[0].userMessageId).toBe("manual-user");
  expect(browser.sends).toBe(0);
});
test("new tasks resolve stored preferences while followups retain their original snapshot", async () => {
  const { state, browser } = setup();
  const checks: string[] = [];
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => {
      checks.push(opts.model);
      return { observedModel: opts.model || "8 Pro" };
    },
  );
  const keys = ["model", "project.url", "project.name"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, preference(k)]));
  try {
    writePreference("model", "7 Pro");
    writePreference("project.url", "");
    writePreference("project.name", "");
    const first = await start(conversation, "preferences", "First");
    expect(first.config.model).toBe("7 Pro");
    expect(first.config.projectUrl).toBeUndefined();
    browser.complete();
    await conversation.poll(first.id, first.currentRun);
    writePreference("model", "");
    const next = await start(
      conversation,
      first.id,
      "Followup",
      "second",
      true,
    );
    expect(next.config.model).toBe("7 Pro");
    browser.delayedUrl = true;
    const other = await start(conversation, "default-preferences", "Other");
    expect(other.config.model).toBeUndefined();
    expect(checks).toEqual(["7 Pro", "7 Pro", "7 Pro", "7 Pro", "", "8 Pro"]);
    expect(other.runs[0].observedModel).toBe("8 Pro");
    expect(state.read<any>("config").model).toBe("6 Pro");
  } finally {
    for (const key of keys) {
      writePreference(key, saved[key] ?? "");
    }
  }
});
test("duplicate start never resends, exact reply persists, finish closes owned page and a new service instance retains its result", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "design", "Conversation");
  await start(conversation, "design", "Conversation");
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("design", first.currentRun);
  expect(conversation.result("design", first.currentRun).reply.text).toBe(
    "Answer",
  );
  await conversation.finish("design", first.currentRun);
  expect(browser.targets.filter((t) => t.url.includes("/c/"))).toHaveLength(0);
  const other = new Conversation(
    new State(home()),
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
  );
  expect(other.result("design", first.currentRun).reply.text).toBe("Answer");
});
test("a known user turn without composer remains pending, and stale run IDs fail", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "pending", "Conversation");
  const p = [...browser.pages.values()][0];
  p.generating = false;
  p.hasComposer = false;
  expect(
    (await conversation.poll("pending", first.currentRun)).runs.at(-1)!.state,
  ).toBe("waiting");
  await expect(conversation.poll("pending", "different-run")).rejects.toThrow();
  expect(() => conversation.result("pending", first.currentRun)).toThrow();
});
test("a fresh task never fills or sends into a redirected non-ChatGPT page", async () => {
  const { browser, conversation } = setup();
  const original = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const value = await original(...args);
    if (args[0] === "new") {
      browser.pages.get(value.targetId!).url = "https://example.invalid/";
    }
    return value;
  };
  const t = await start(
    conversation,
    "redirect",
    "Private conversation context",
  );
  expect(t.runs.at(-1)!.state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect([...browser.pages.values()][0].draft).toBe("");
});

test("task-only requests send frozen workspace guidance and preserve verbatim input on every run", async () => {
  const { browser, conversation } = setup();
  const input = "请解释这个算法。\n\n```ts\nconst n = 2;\n```\n";
  const first = await start(conversation, "question", input);
  const run = first.runs[0];
  expect(run.input).toBe(input);
  expect(run.promptContext).toMatchObject({ version: 1, workspace: ws() });
  expect(run.promptContext!.instructions).toContain("capabilities");
  expect(run.promptContext!.instructions).toContain("execution.result");
  expect(run.prompt).toContain(JSON.stringify(ws()));
  expect(run.prompt.endsWith(input)).toBe(true);
  expect([...browser.pages.values()][0].messages[0].text).toBe(run.prompt);
  browser.complete();
  await conversation.poll("question", first.currentRun);
  const nextInput = "补充问题：为什么？\n";
  const next = await start(
    conversation,
    "question",
    nextInput,
    "second-question",
    true,
  );
  expect(next.runs.at(-1)!.input).toBe(nextInput);
  expect(next.runs.at(-1)!.promptContext).toEqual(run.promptContext);
  expect(next.runs.at(-1)!.prompt.endsWith(nextInput)).toBe(true);
  expect(next.runs[0].prompt).toBe(run.prompt);
  expect([...browser.pages.values()][0].messages.at(-1).text).toBe(
    next.runs.at(-1)!.prompt,
  );
});

test("reopened queued runs and retries send their saved guidance even when the runtime template differs", async () => {
  const { state, browser, conversation } = setup();
  const task = await conversation.create("frozen-guidance", "Only the goal");
  const r = task.runs[0];
  r.promptContext!.instructions = "Saved guidance from an earlier release";
  r.prompt = composePrompt(r.marker, r.input!, r.promptContext!);
  r.promptHash = sha(r.prompt);
  state.write("task-" + task.id, task);
  const reopened = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  expect((await reopened.create(task.id, "Only the goal")).runs[0].prompt).toBe(
    r.prompt,
  );
  browser.sendReady = false;
  await reopened.start(task.id, task.currentRun);
  expect(browser.sends).toBe(0);
  [...browser.pages.values()][0].sendReady = true;
  await reopened.retry(task.id, task.currentRun);
  expect(browser.sends).toBe(1);
  expect([...browser.pages.values()][0].messages[0].text).toBe(r.prompt);
});

test("a changed request snapshot is rejected before opening or sending", async () => {
  const { state, browser, conversation } = setup();
  const task = await conversation.create("corrupt-guidance", "Original goal");
  task.runs[0].input = "Changed goal";
  state.write("task-" + task.id, task);
  await expect(conversation.start(task.id, task.currentRun)).rejects.toThrow(
    "PROMPT_INTEGRITY_FAILED",
  );
  expect(browser.targets).toHaveLength(0);
  expect(browser.sends).toBe(0);
});

test("a queued historical run without context keeps its exact original prompt", async () => {
  const { state, browser, conversation } = setup();
  const task = await conversation.create("historical-prompt", "Original goal");
  const r = task.runs[0];
  delete r.input;
  delete r.promptContext;
  r.prompt = `${r.marker}\n\nOriginal goal`;
  r.promptHash = sha(r.prompt);
  state.write("task-" + task.id, task);
  await conversation.start(task.id, task.currentRun);
  expect([...browser.pages.values()][0].messages[0].text).toBe(r.prompt);
  expect(conversation.get(task.id).runs[0].promptContext).toBeUndefined();
});

test("followup restores a closed conversation after page loading and retains earlier runs", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "continued", "Initial question");
  browser.complete();
  await conversation.poll("continued", first.currentRun);
  const saved = structuredClone([...browser.pages.values()][0]);
  await conversation.finish("continued", first.currentRun);
  const original = browser.page.bind(browser);
  let reads = 0;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      read: async () => {
        reads++;
        if (reads === 1)
          return {
            ...saved,
            url: "about:blank",
            hasComposer: false,
            messages: [],
          };
        if (reads === 2) return { ...saved, messages: [] };
        if (reads === 3)
          return { ...saved, messages: saved.messages.slice(0, 1) };
        if (reads === 4 || reads === 5)
          return {
            ...saved,
            messages: saved.messages.map((m: any) =>
              m.role === "assistant"
                ? {
                    ...m,
                    text: reads === 4 ? "An" : m.text,
                    final: reads === 4,
                  }
                : m,
            ),
          };
        const p = browser.pages.get(target);
        if (!p.messages.length) Object.assign(p, structuredClone(saved));
        return b.read();
      },
    };
  };
  const modelChecks: Record<string, string>[] = [];
  const restored = new Conversation(
    new State(home()),
    browser as any,
    async (_b, opts) => {
      modelChecks.push(opts);
      if (opts.model !== "6 Pro") throw new Error("No element found: Latest");
      return { observedModel: "6 Pro" };
    },
  );
  const next = await start(restored, "continued", "Follow-up", "second", true);
  expect(modelChecks).toEqual([
    { url: first.url!, target: next.binding!.target, model: "6 Pro" },
    {
      url: first.url!,
      target: next.binding!.target,
      model: "6 Pro",
      "verify-only": "true",
    },
  ]);
  expect(next.url).toBe(first.url);
  expect(next.runs).toHaveLength(2);
  expect(next.runs[0].reply?.text).toBe("Answer");
  expect(next.runs[1].state).toBe("waiting");
  expect(browser.sends).toBe(2);
});

test.each([true, false])(
  "completed followup skips a claimed target (owned=%s) and sends once on its own restored page",
  async (owned) => {
    const { state, browser, conversation, first, other } =
      await completedWithClaimedTab();
    other.binding!.owned = owned;
    state.write("task-" + other.id, other);
    const otherPage = structuredClone(browser.pages.get(other.binding!.target));
    const targets = structuredClone(browser.targets);
    const page = browser.page.bind(browser);
    browser.page = async (target) => {
      expect(target).not.toBe(other.binding!.target);
      return page(target);
    };
    const next = await start(conversation, first.id, "Follow-up", "next", true);
    expect(next.binding).toMatchObject({ owned: true, epoch: "epoch1" });
    expect(next.binding!.target).not.toBe(other.binding!.target);
    expect(next.url).toBe(first.url);
    expect(next.runs).toHaveLength(2);
    expect(next.runs[0].id).toBe(first.currentRun);
    expect(next.runs[0].reply?.text).toBe("Answer");
    expect(next.runs[1].state).toBe("waiting");
    expect(browser.sends).toBe(2);
    expect(browser.targets).toEqual([
      ...targets,
      { targetId: next.binding!.target, url: first.url },
    ]);
    expect(conversation.get(other.id)).toEqual(other);
    expect(browser.pages.get(other.binding!.target)).toEqual(otherPage);
    expect(
      await start(conversation, first.id, "Follow-up", "next", true),
    ).toEqual(next);
    expect(browser.sends).toBe(2);
  },
);

test("restored followup verifies the entire completed branch before sending its saved run", async () => {
  const { browser, conversation, first, other, savedPage } =
    await completedWithClaimedTab();
  savedPage.messages.push({
    id: "foreign-user",
    role: "user",
    text: "Later message",
    final: false,
  });
  const otherPage = structuredClone(browser.pages.get(other.binding!.target));
  const failed = await start(conversation, first.id, "Follow-up", "next", true);
  expect(failed.runs.at(-1)?.error).toContain("COMPLETED_TURN_CHANGED");
  const after = conversation.get(first.id);
  expect(after.currentRun).not.toBe(first.currentRun);
  expect(after.runs).toHaveLength(2);
  expect(after.runs[1].state).toBe("prepared");
  expect(after.runs[0].state).toBe("complete");
  expect(browser.sends).toBe(1);
  expect(conversation.get(other.id)).toEqual(other);
  expect(browser.pages.get(other.binding!.target)).toEqual(otherPage);
});

test("prepared retry still rejects a conflicting target instead of replacing it", async () => {
  const { browser, conversation, other } = await completedWithClaimedTab();
  const conflicting = conversation.get("continued");
  conflicting.id = "conflicting";
  conflicting.url = undefined;
  conflicting.binding = { ...other.binding! };
  conversation.store.write("task-conflicting", conflicting);
  const targets = structuredClone(browser.targets);
  await expect(conversation.retry(other.id, other.currentRun)).rejects.toThrow(
    "TARGET_CONFLICT",
  );
  expect(browser.targets).toEqual(targets);
  expect(browser.sends).toBe(1);
});

test.each([1, 2])(
  "completed followup avoids claimed targets and selects or opens its own page (%s available)",
  async (count) => {
    const { browser, conversation, first, other } =
      await completedWithClaimedTab();
    const candidates = [];
    for (let n = 0; n < count; n++)
      candidates.push(await browser.tabs("new", first.url!));
    const targets = structuredClone(browser.targets);
    if (count === 1) {
      const next = await start(
        conversation,
        first.id,
        "Follow-up",
        "next",
        true,
      );
      expect(next.binding).toMatchObject({
        target: candidates[0]!.targetId,
        owned: false,
      });
      expect(browser.sends).toBe(2);
    } else {
      const next = await start(
        conversation,
        first.id,
        "Follow-up",
        "next",
        true,
      );
      expect(next.runs.at(-1)?.state).toBe("waiting");
      expect(next.binding).toMatchObject({ owned: true });
      expect(candidates.map((x) => x.targetId)).not.toContain(
        next.binding?.target,
      );
      expect(conversation.get(first.id).runs).toHaveLength(2);
      expect(browser.sends).toBe(2);
    }
    if (count === 1) expect(browser.targets).toEqual(targets);
    else expect(browser.targets).toHaveLength(targets.length + 1);
    expect(conversation.get(other.id)).toEqual(other);
  },
);

test("composer nonbreaking spaces preserve indentation without accepting changed words", async () => {
  const { browser, conversation } = setup();
  const original = browser.page.bind(browser);
  let changeWords = false;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        const result = await b.run(...args);
        if (args[0] === "fill") {
          const p = browser.pages.get(target);
          p.draft = p.draft.replace(/  /g, "\u00a0 ");
          if (changeWords) p.draft += "unexpected modification";
        }
        return result;
      },
    };
  };
  const first = await start(conversation, "spaces", "Code:\n  const n = 1;");
  expect(first.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
  // Independent task must still stop on an actual text mutation.
  changeWords = true;
  const second = await start(
    conversation,
    "changed-words",
    "Code:\n  const n = 2;",
  );
  expect(second.runs[0].state).toBe("prepared");
  expect(second.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(1);
});

test("restoring a saved conversation refuses a different conversation without sending", async () => {
  const { browser, conversation } = setup();
  const first = await start(conversation, "restore-drift", "Initial question");
  browser.complete();
  await conversation.poll("restore-drift", first.currentRun);
  await conversation.finish("restore-drift", first.currentRun);
  const original = browser.tabs.bind(browser);
  browser.tabs = async (...args: string[]) => {
    const result = await original(...args);
    if (args[0] === "new") {
      browser.pages.get(result.targetId!).url =
        "https://chatgpt.com/c/unrelated";
    }
    return result;
  };
  const failed = await start(
    conversation,
    "restore-drift",
    "Next question",
    "next",
    true,
  );
  expect(failed.runs.at(-1)?.error).toContain("CONVERSATION_CHANGED");
  expect(failed.runs.at(-1)?.state).toBe("prepared");
  expect(browser.sends).toBe(1);
  expect(conversation.get("restore-drift").runs).toHaveLength(2);
});

test("explicit retry preserves a changed draft and continues only the recorded message", async () => {
  const { browser, conversation } = setup();
  const original = browser.page.bind(browser);
  let failFill = true;
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        const result = await b.run(...args);
        if (args[0] === "fill" && failFill)
          throw new Error("fill response lost");
        return result;
      },
    };
  };
  const first = await start(conversation, "retry-draft", "Recorded question");
  expect(first.runs[0].state).toBe("prepared");
  const p = [...browser.pages.values()][0];
  failFill = false;
  p.draft = "User's changed draft";
  const refused = await conversation.retry("retry-draft", first.currentRun);
  expect(refused.runs[0].error).toContain("DRAFT_CHANGED");
  expect(p.draft).toBe("User's changed draft");
  expect(browser.sends).toBe(0);
  p.draft = first.runs[0].prompt;
  const sent = await conversation.retry("retry-draft", first.currentRun);
  expect(sent.currentRun).toBe(first.currentRun);
  expect(sent.runs).toHaveLength(1);
  expect(sent.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
});

test("workspace snapshots can be selected explicitly and mismatch cannot silently reuse or retry a task", async () => {
  const { browser, conversation } = setup();
  const other = join(ws(), "other");
  mkdirSync(other);
  browser.restoredDraft = "Old draft";
  const t = await start(
    conversation,
    "workspace-binding",
    "Question",
    "initial",
    false,
    other,
  );
  expect(t.config.workspace).toBe(other);
  expect(conversationStatus(t).workspace).toBe(other);
  await expect(
    start(conversation, t.id, "Question", "initial", false, ws()),
  ).rejects.toThrow("WORKSPACE_MISMATCH");
  await expect(conversation.retry(t.id, t.currentRun, ws())).rejects.toThrow(
    "WORKSPACE_MISMATCH",
  );
  expect(browser.sends).toBe(0);
});

test("explicit unsent workspace correction updates context, retains request/run and audits the old prompt", async () => {
  const { state, browser, conversation } = setup();
  const other = join(ws(), "other");
  mkdirSync(other);
  browser.restoredDraft = "Old draft";
  const t = await start(conversation, "correct-workspace", "Question");
  const corrected = await conversation.rebindWorkspace(
    t.id,
    t.currentRun,
    ws(),
    other,
  );
  expect(corrected.config.workspace).toBe(other);
  expect(corrected.workspaceId).not.toBe(t.workspaceId);
  expect(corrected.runs[0].input).toBe(t.runs[0].input);
  expect(corrected.runs[0].promptContext!.workspace).toBe(other);
  expect(corrected.runs[0].prompt).toContain(JSON.stringify(other));
  expect(corrected.workspaceBindingChange!.priorPrompt).toBe(t.runs[0].prompt);
  expect(corrected.workspaceBindingChange!.priorPromptHash).toBe(
    t.runs[0].promptHash,
  );
  expect([...browser.pages.values()][0].draft).toBe("Old draft");
  expect(corrected.currentRun).toBe(t.currentRun);
  expect(state.read<any>("config").workspace).toBe(ws());
  await expect(
    conversation.rebindWorkspace(t.id, t.currentRun, ws(), other),
  ).rejects.toThrow("WORKSPACE_MISMATCH");
  corrected.runs[0].state = "delivery_unknown";
  state.write("task-" + t.id, corrected);
  await expect(
    conversation.rebindWorkspace(t.id, t.currentRun, other, ws()),
  ).rejects.toThrow("RUN_NOT_PREPARED");
  expect(browser.sends).toBe(0);
});

for (const mode of [
  "followup",
  "retry-before-verification",
  "retry-after-verification",
  "explicit-config",
  "model-conflict",
]) {
  test(`continuation preserves the verified model through both checks: ${mode}`, async () => {
    const { state, browser, conversation } = setup();
    const first = await start(conversation, "continue-model", "First");
    browser.complete();
    const completed = await conversation.poll(first.id, first.currentRun);
    completed.config.model = mode === "explicit-config" ? "7 Pro" : undefined;
    state.write("task-" + first.id, completed);
    const checks: Record<string, string>[] = [];
    let fail = mode.startsWith("retry-");
    const expected = mode === "explicit-config" ? "7 Pro" : "6 Pro";
    const continuation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts);
        if (!opts.model) throw new Error("No element found: Latest");
        if (mode === "model-conflict")
          throw new Error("Pro selection did not match expected model 6 Pro");
        if (
          fail &&
          (mode === "retry-before-verification" ||
            opts["verify-only"] === "true")
        )
          throw new Error("Temporary verification failure");
        return { observedModel: opts.model };
      },
    );
    let result = await start(
      continuation,
      first.id,
      "Followup",
      "second",
      true,
    );
    const prepared = structuredClone(result.runs[1]);
    if (mode.startsWith("retry-")) {
      expect(prepared.state).toBe("prepared");
      expect(prepared.observedModel).toBe(
        mode === "retry-after-verification" ? "6 Pro" : undefined,
      );
      expect(browser.sends).toBe(1);
      // A same-run observation must win even over a conflicting saved config.
      if (mode === "retry-after-verification") {
        result.config.model = "7 Pro";
        state.write("task-" + result.id, result);
      }
      fail = false;
      checks.length = 0;
      result = await continuation.retry(result.id, result.currentRun);
      expect(result.runs[1]).toMatchObject({
        id: prepared.id,
        prompt: prepared.prompt,
        promptHash: prepared.promptHash,
        inputHash: prepared.inputHash,
        marker: prepared.marker,
      });
    }
    expect(checks[0]).toEqual({
      url: first.url!,
      target: first.binding!.target,
      model: expected,
    });
    expect(result.runs[0]).toMatchObject({
      id: completed.runs[0].id,
      prompt: completed.runs[0].prompt,
      promptHash: completed.runs[0].promptHash,
      observedModel: "6 Pro",
      reply: completed.runs[0].reply!,
      replyHash: completed.runs[0].replyHash!,
      branch: completed.runs[0].branch!,
      state: "complete",
    });
    if (mode === "model-conflict") {
      expect(result.runs[1].state).toBe("prepared");
      expect(result.runs[1].error).toContain("expected model 6 Pro");
      expect(checks).toHaveLength(1);
      expect(browser.sends).toBe(1);
      expect(browser.pages.get(first.binding!.target).draft).toBe("");
    } else {
      expect(checks).toHaveLength(2);
      expect(checks[1]).toEqual({ ...checks[0], "verify-only": "true" });
      expect(result.runs[1]).toMatchObject({
        state: "waiting",
        observedModel: expected,
      });
      expect(browser.sends).toBe(2);
    }
  });
}

for (const historicalState of [
  "complete",
  "prepared",
  "waiting",
  "blocked",
  "delivery_unknown",
]) {
  test(`continuation only inherits a completed historical observation: ${historicalState}`, async () => {
    const { state, browser, conversation } = setup();
    const first = await start(conversation, "historical-model", "First");
    browser.complete();
    const completed = await conversation.poll(first.id, first.currentRun);
    completed.config.model = undefined;
    const anchor = structuredClone(completed.runs[0]);
    // Legacy completed anchors may lack an observation; inspect older runs only.
    delete completed.runs[0].observedModel;
    completed.runs.unshift({
      ...anchor,
      id: "older",
      requestId: "older",
      state: historicalState,
      observedModel: "5.6 Pro",
    });
    state.write("task-" + first.id, completed);
    const checks: string[] = [];
    const continuation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts.model);
        return { observedModel: opts.model || "7 Pro" };
      },
    );
    const result = await start(
      continuation,
      first.id,
      "Followup",
      "second",
      true,
    );
    expect(checks).toEqual(
      historicalState === "complete" ? ["5.6 Pro", "5.6 Pro"] : ["", "7 Pro"],
    );
    expect(result.runs[2].state).toBe("waiting");
  });
}

test("project starts use only the configured project composer and reject a generic or changed page before send", async () => {
  const oldUrl = preference("project.url"),
    oldName = preference("project.name");
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  try {
    for (const scenario of ["project", "generic", "drift"]) {
      const { state: base, browser } = setup();
      const state = new State(join(home(), scenario));
      state.write("config", base.read("config"));
      const originalPage = browser.page.bind(browser);
      browser.page = async (target: string) => {
        const page = await originalPage(target);
        return {
          ...page,
          run: async (...args: string[]) => {
            if (args[0] === "eval" && args[1].includes("composerCount"))
              return {
                result: {
                  url:
                    scenario === "generic"
                      ? "https://chatgpt.com/"
                      : projectUrl,
                  messageCount: 0,
                  composerCount: 1,
                  editable: true,
                  projectName: scenario === "generic" ? null : "Agent reviews",
                },
              };
            return page.run(...args);
          },
        };
      };
      const conversation = new Conversation(state, browser as any, async () => {
        if (scenario === "drift")
          [...browser.pages.values()][0].url = "https://chatgpt.com/";
        return { observedModel: "6 Pro" };
      });
      const task = await start(conversation, "project-" + scenario, "Review");
      expect(browser.targets).toHaveLength(1);
      expect(task.config.projectUrl).toBe(projectUrl);
      if (scenario === "project") expect(browser.sends).toBe(1);
      else {
        expect(browser.sends).toBe(0);
        expect(task.runs[0].state).toBe("prepared");
        expect(task.runs[0].error).toContain(
          scenario === "generic"
            ? "PROJECT_IDENTITY_CHANGED"
            : "NEW_CONVERSATION_LOCATION_CHANGED",
        );
      }
    }
  } finally {
    writePreference("project.url", oldUrl ?? "");
    writePreference("project.name", oldName ?? "");
  }
});

test("retry returns an owned empty home tab to its saved project before sending the same run", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  const { state, browser } = setup();
  const first = new Conversation(state, browser as any, async () => {
    const page = [...browser.pages.values()][0];
    page.url = "https://chatgpt.com/";
    browser.targets[0].url = page.url;
    throw new Error("Page URL changed; refusing model interaction");
  });
  const task = await start(first, "project-home-retry", "Review");
  const target = browser.targets[0].targetId;
  expect(task.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);

  const resumed = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const result = await resumed.retry(task.id, task.currentRun);
  expect(result.runs[0].state).toBe("waiting");
  expect(result.currentRun).toBe(task.currentRun);
  expect(browser.targets).toHaveLength(1);
  expect(browser.targets[0].targetId).toBe(target);
  expect(browser.sends).toBe(1);
  expect([...browser.pages.values()][0].messages[0].text).toBe(
    task.runs[0].prompt,
  );
});

test("project retry returns any owned page to the saved entry, then sends the same run", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  for (const scenario of [
    "draft",
    "history",
    "attachment",
    "other-project",
    "blocked",
    "external",
  ]) {
    const { state: base, browser } = setup();
    const state = new State(join(home(), scenario));
    state.write("config", base.read("config"));
    const first = new Conversation(state, browser as any, async () => {
      throw new Error("pause before send");
    });
    const task = await start(first, "project-unsafe-" + scenario, "Review");
    const page = [...browser.pages.values()][0];
    page.url =
      scenario === "other-project"
        ? "https://chatgpt.com/g/g-p-other/project"
        : scenario === "external"
          ? "https://example.com/"
          : "https://chatgpt.com/";
    browser.targets[0].url = page.url;
    if (scenario === "draft") page.draft = "Someone else's draft";
    if (scenario === "history")
      page.messages.push({
        id: "other",
        role: "user",
        text: "Other turn",
        final: false,
      });
    if (scenario === "attachment") page.attachments = true;
    if (scenario === "blocked") page.blocked = "UI error";
    const target = task.binding!.target;
    const resumed = new Conversation(state, browser as any, async () => ({
      observedModel: "6 Pro",
    }));
    const result = await resumed.retry(task.id, task.currentRun);
    expect(result.runs[0].state).toBe("waiting");
    expect(result.currentRun).toBe(task.currentRun);
    expect(result.binding!.target).toBe(target);
    expect(browser.sends).toBe(1);
    expect(page.messages[0].text).toBe(task.runs[0].prompt);
  }
});

test("project retry reconciles its existing user message before replacing the owned page", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  const { state, browser } = setup();
  const first = new Conversation(state, browser as any, async () => {
    throw new Error("pause before send");
  });
  const task = await start(first, "already-manual-sent", "Review");
  const page = browser.pages.get(task.binding!.target);
  page.draft = "";
  page.url = "https://chatgpt.com/c/manually-sent";
  browser.targets[0].url = page.url;
  page.messages.push({
    id: "u-manual",
    role: "user",
    text: task.runs[0].prompt,
    final: false,
  });
  page.generating = true;

  const resumed = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const result = await resumed.retry(task.id, task.currentRun);
  expect(result.currentRun).toBe(task.currentRun);
  expect(result.runs[0].userMessageId).toBe("u-manual");
  expect(result.url).toBe(page.url);
  expect(browser.sends).toBe(0);
  expect(page.messages).toHaveLength(1);
});

test("retry replaces a missing borrowed first-run tab with a newly claimed tab", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  const { state, browser } = setup();
  const first = new Conversation(state, browser as any, async () => {
    throw new Error("pause before send");
  });
  const task = await start(first, "missing-borrowed", "Review");
  task.binding!.owned = false;
  state.write("task-" + task.id, task);
  const missing = task.binding!.target;
  await browser.tabs("close", missing);
  browser.pages.delete(missing);

  const resumed = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const result = await resumed.retry(task.id, task.currentRun);
  expect(result.runs[0].state).toBe("waiting");
  expect(result.currentRun).toBe(task.currentRun);
  expect(result.binding).toMatchObject({ owned: true });
  expect(result.binding!.target).not.toBe(missing);
  expect(browser.targets).toHaveLength(1);
  expect(browser.sends).toBe(1);
});

test("retry resumes a prepared run left at the opening checkpoint", async () => {
  const { state, browser, conversation } = setup();
  const task = await conversation.create("opening-interrupted", "Review");
  task.opening = true;
  state.write("task-" + task.id, task);

  const result = await conversation.retry(task.id, task.currentRun);
  expect(result.runs[0].state).toBe("waiting");
  expect(result.currentRun).toBe(task.currentRun);
  expect(result.opening).toBe(false);
  expect(result.binding).toMatchObject({ owned: true });
  expect(browser.targets).toHaveLength(1);
  expect(browser.sends).toBe(1);
});

test("repeatedly lost unsent tabs do not exhaust the same run's recovery", async () => {
  const { state, browser } = setup();
  const paused = new Conversation(state, browser as any, async () => {
    throw new Error("pause before send");
  });
  let task = await start(paused, "repeatedly-lost", "Review");
  for (let n = 0; n < 3; n++) {
    const missing = task.binding!.target;
    await browser.tabs("close", missing);
    browser.pages.delete(missing);
    task = await paused.retry(task.id, task.currentRun);
    expect(task.runs[0].state).toBe("prepared");
  }
  const missing = task.binding!.target;
  await browser.tabs("close", missing);
  browser.pages.delete(missing);
  const resumed = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const result = await resumed.retry(task.id, task.currentRun);
  expect(result.runs[0].state).toBe("waiting");
  expect(result.pageRecreations).toBe(4);
  expect(browser.sends).toBe(1);
});

test("retry does not navigate a borrowed tab that still exists", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-example-reviews/project";
  writePreference("project.url", projectUrl);
  writePreference("project.name", "Agent reviews");
  const { state, browser } = setup();
  const first = new Conversation(state, browser as any, async () => {
    throw new Error("pause before send");
  });
  const task = await start(first, "borrowed-present", "Review");
  task.binding!.owned = false;
  state.write("task-" + task.id, task);
  const page = [...browser.pages.values()][0];
  page.url = "https://chatgpt.com/";
  page.draft = "Other work";
  browser.targets[0].url = page.url;
  const before = structuredClone(page);

  const resumed = new Conversation(state, browser as any, async () => ({
    observedModel: "6 Pro",
  }));
  const result = await resumed.retry(task.id, task.currentRun);
  expect(result.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(page).toEqual(before);
});

test("create is durable and offline; start loads the saved run and never sends it twice", async () => {
  const { state, browser, conversation } = setup();
  const prepared = await conversation.create("queued", "Saved prompt");
  expect(prepared.runs[0].state).toBe("prepared");
  expect(browser.nextTarget).toBe(0);
  expect(browser.sends).toBe(0);
  const resumed = new Conversation(
    new State(home()),
    browser as any,
    async () => ({ observedModel: "6 Pro" }),
  );
  const sent = await resumed.start(prepared.id, prepared.currentRun);
  expect(sent.runs[0].state).toBe("waiting");
  expect(browser.sends).toBe(1);
  expect([...browser.pages.values()][0].messages[0].text).toContain(
    "Saved prompt",
  );
  await resumed.start(prepared.id, prepared.currentRun);
  expect(browser.sends).toBe(1);
  await expect(resumed.start(prepared.id, "stale")).rejects.toThrow(
    "STALE_RUN",
  );
  const repeated = await resumed.create("queued", "Saved prompt");
  expect(repeated.currentRun).toBe(prepared.currentRun);
  await expect(resumed.create("queued", "Changed prompt")).rejects.toThrow(
    "REQUEST_CONFLICT",
  );
  expect(state.read<any>("task-queued").currentRun).toBe(prepared.currentRun);
});

test("followup creation does not contact the browser; execution checks prior reply drift", async () => {
  const { browser, conversation } = setup();
  const prepared = await conversation.create("offline-followup", "First");
  await conversation.start(prepared.id, prepared.currentRun);
  browser.complete();
  await conversation.poll(prepared.id, prepared.currentRun);
  browser.gate = async () => {
    throw new Error("OFFLINE");
  };
  const next = await conversation.create(
    prepared.id,
    "Second",
    "followup-key",
    true,
  );
  expect(next.runs).toHaveLength(2);
  expect(browser.sends).toBe(1);
  browser.gate = undefined;
  [...browser.pages.values()][0].messages.at(-1).text = "Changed reply";
  const failed = await conversation.start(next.id, next.currentRun);
  expect(failed.runs.at(-1)?.state).toBe("prepared");
  expect(failed.runs.at(-1)?.error).toBeTruthy();
  expect(browser.sends).toBe(1);
});

test("replaying an older create request cannot select a queued successor", async () => {
  const { browser, conversation } = setup();
  const first = await conversation.create("old-key", "First");
  await conversation.start(first.id, first.currentRun);
  browser.complete();
  await conversation.poll(first.id, first.currentRun);
  const next = await conversation.create(first.id, "Second", "second", true);
  await expect(conversation.create(first.id, "First")).rejects.toThrow(
    "REQUEST_RUN_SUPERSEDED",
  );
  expect(conversation.get(first.id).currentRun).toBe(next.currentRun);
  expect(browser.sends).toBe(1);
});

test("a database rejection at the submission boundary prevents the browser click", async () => {
  const { browser, conversation } = setup();
  const task = await conversation.create(
    "durability-failure",
    "Do not send before commit",
  );
  const db = new Database(join(home(), "tasks.db"));
  db.exec(`create trigger reject_submission before update on task_document
    when json_extract(new.document, '$.runs[0].state') = 'submitting'
    begin select raise(abort, 'test disk failure'); end`);
  db.close();
  const result = await conversation.start(task.id, task.currentRun);
  expect(result.runs[0].error).toContain("test disk failure");
  expect(browser.sends).toBe(0);
  await conversation.start(task.id, task.currentRun);
  expect(browser.sends).toBe(0);
});
