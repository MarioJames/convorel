import { test, expect } from "bun:test";
import { Conversation } from "../../src/conversation/conversation.ts";
import { conversationStatus } from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";

const { setup, start, missingDelivery } = conversationHarness();
test("an error after recognizing the submitted message never restores permission to send", async () => {
  const { state, browser, conversation } = setup();
  const write = state.write.bind(state);
  let failed = false;
  state.write = (key, value) => {
    if (!failed && value.runs?.[0]?.state === "waiting") {
      failed = true;
      throw new Error("Temporary state write failure");
    }
    return write(key, value);
  };
  const t = await start(conversation, "confirmed-send", "Review");
  expect(t.runs[0].userMessageId).toBe("u1");
  expect(t.runs[0].state).toBe("waiting");
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  browser.complete();
  await conversation.resume(t.id, t.currentRun);
  expect(conversation.result(t.id, t.currentRun).reply.text).toBe("Answer");
  expect(browser.sends).toBe(1);
});

test("a submitted message can precede its persisted conversation URL without allowing a resend", async () => {
  const { browser, conversation } = setup();
  browser.delayedUrl = true;
  const first = await start(conversation, "url-pending", "Conversation");
  expect(first.url).toBeUndefined();
  expect(first.runs[0].state).toBe("waiting");
  expect(first.runs[0].userMessageId).toBe("u1");
  await expect(conversation.retry(first.id, first.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  const p = [...browser.pages.values()][0];
  p.url = "https://chatgpt.com/c/test-conversation";
  browser.targets[0].url = p.url;
  browser.complete();
  expect((await conversation.resume(first.id, first.currentRun)).url).toBe(
    p.url,
  );
  expect(conversation.result(first.id, first.currentRun).reply.text).toBe(
    "Answer",
  );
  expect(browser.sends).toBe(1);
});
test("resume recovers a saved draft URL only on its original target with the exact submitted message", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "legacy-pending", "Conversation");
  first.url = "https://chatgpt.com/";
  first.runs[0].state = "delivery_unknown";
  state.write("task-" + first.id, first);
  browser.complete();
  expect((await conversation.resume(first.id, first.currentRun)).url).toBe(
    "https://chatgpt.com/c/test-conversation",
  );
  expect(browser.sends).toBe(1);
});
test("draft URL recovery never trusts a different submitted message", async () => {
  const { state, browser, conversation } = setup();
  const first = await start(conversation, "wrong-pending", "Conversation");
  first.url = "https://chatgpt.com/";
  first.runs[0].state = "delivery_unknown";
  state.write("task-" + first.id, first);
  [...browser.pages.values()][0].messages[0].id = "unrelated-user";
  await expect(conversation.resume(first.id, first.currentRun)).rejects.toThrow(
    "PENDING_URL_UNVERIFIED",
  );
  expect(browser.sends).toBe(1);
  expect(state.read<any>("task-" + first.id).url).toBe("https://chatgpt.com/");
});

test("uncertain send reconciles existing marker without a second click", async () => {
  const { browser, conversation } = setup();
  browser.failSend = true;
  const first = await start(conversation, "uncertain", "Conversation");
  expect(browser.sends).toBe(1);
  expect(conversationStatus(first)).toMatchObject({
    delivery: "unknown",
    nextAction: "resume",
    phase: "confirming_delivery",
    observationError: null,
  });
  await conversation.resume("uncertain", first.currentRun);
  expect(browser.sends).toBe(1);
  browser.complete();
  await conversation.poll("uncertain", first.currentRun);
  expect(conversation.result("uncertain", first.currentRun).reply.text).toBe(
    "Answer",
  );
});

test("pre-submit recovery is explicit, run-bound and never retries uncertain delivery", async () => {
  const { state, browser } = setup();
  let available = false;
  const conversation = new Conversation(state, browser as any, async () => {
    if (!available) throw new Error("MODEL_UNVERIFIED");
    return { observedModel: "6 Pro" };
  });
  const first = await start(conversation, "recover-send", "Question");
  expect(first.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(
    (await conversation.resume("recover-send", first.currentRun)).runs[0].state,
  ).toBe("prepared");
  available = true;
  await expect(conversation.retry("recover-send", "stale")).rejects.toThrow(
    "STALE_RUN",
  );
  browser.failSend = true;
  const next = await conversation.retry("recover-send", first.currentRun);
  expect(next.currentRun).toBe(first.currentRun);
  expect(next.runs[0].state).toBe("delivery_unknown");
  expect(browser.sends).toBe(1);
  await expect(
    conversation.retry("recover-send", first.currentRun),
  ).rejects.toThrow("RUN_NOT_PREPARED");
  await conversation.resume("recover-send", first.currentRun);
  expect(browser.sends).toBe(1);
});

test("restored draft recovery backs up, confirms clearing, then retries the same prompt with model verification", async () => {
  const { state, browser } = setup();
  let modelChecks = 0;
  const conversation = new Conversation(state, browser as any, async () => {
    modelChecks++;
    return { observedModel: "6 Pro" };
  });
  browser.restoredDraft = "Old restored draft\nsecond line";
  const t = await start(conversation, "restored", "Recorded question");
  expect(t.runs[0].error).toContain("DRAFT_CHANGED");
  expect(browser.sends).toBe(0);
  expect(modelChecks).toBe(0);
  const original = browser.page.bind(browser);
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "eval")
          expect(conversation.get(t.id).runs[0].draftRecovery).toMatchObject({
            draft: browser.restoredDraft,
            cleared: false,
            target,
          });
        return b.run(...args);
      },
    };
  };
  const cleared = await conversation.clearDraft(
    t.id,
    t.currentRun,
    browser.restoredDraft,
  );
  expect(cleared.runs[0].draftRecovery?.cleared).toBe(true);
  expect(cleared.runs[0].state).toBe("prepared");
  expect(browser.sends).toBe(0);
  expect(browser.clears).toBe(1);
  const sent = await conversation.retry(t.id, t.currentRun);
  expect(sent.runs).toHaveLength(1);
  expect(sent.currentRun).toBe(t.currentRun);
  expect(sent.runs[0].prompt).toBe(t.runs[0].prompt);
  expect(sent.runs[0].state).toBe("waiting");
  expect(sent.runs[0].observedModel).toBe("6 Pro");
  expect(modelChecks).toBe(2);
  expect(browser.sends).toBe(1);
  expect(browser.pages.get(t.binding!.target).messages[0].text).toBe(
    t.runs[0].prompt,
  );
  await expect(
    conversation.clearDraft(t.id, t.currentRun, browser.restoredDraft),
  ).rejects.toThrow("RUN_NOT_PREPARED");
});

test("recovery refuses changed drafts, stale runs, attachments, history, and borrowed pages without clearing", async () => {
  const { state, browser, conversation } = setup();
  browser.restoredDraft = "Old draft";
  const t = await start(conversation, "recovery-guards", "Question");
  const p = browser.pages.get(t.binding!.target);
  await expect(
    conversation.clearDraft(t.id, "stale", "Old draft"),
  ).rejects.toThrow("STALE_RUN");
  p.draft = "User edit";
  await expect(
    conversation.clearDraft(t.id, t.currentRun, "Old draft"),
  ).rejects.toThrow("DRAFT_CHANGED");
  expect(p.draft).toBe("User edit");
  p.draft = "Old draft";
  p.attachments = true;
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("PAGE_NOT_IDLE");
  p.attachments = false;
  p.messages = [{ id: "submitted", role: "user", text: t.runs[0].prompt }];
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("UNEXPECTED_CONVERSATION_HISTORY");
  p.messages = [];
  const borrowed = conversation.get(t.id);
  borrowed.binding!.owned = false;
  state.write("task-" + t.id, borrowed);
  await expect(
    conversation.clearDraft(t.id, t.currentRun, p.draft),
  ).rejects.toThrow("DRAFT_RECOVERY_REQUIRES_OWNED_NEW_PAGE");
  expect(browser.clears).toBe(0);
  expect(browser.sends).toBe(0);
});

test("a successful browser command does not prove the draft cleared and never triggers retry", async () => {
  const { browser, conversation } = setup();
  browser.restoredDraft = "Restored draft";
  browser.ignoreClear = true;
  const t = await start(conversation, "unverified-clear", "Question");
  await expect(
    conversation.clearDraft(t.id, t.currentRun, browser.restoredDraft),
  ).rejects.toThrow("DRAFT_CLEAR_UNVERIFIED");
  expect(conversation.get(t.id).runs[0].draftRecovery?.cleared).toBe(false);
  expect(conversation.get(t.id).runs[0].state).toBe("prepared");
  expect(browser.clears).toBe(1);
  expect(browser.sends).toBe(0);
});

for (const delivery of ["submitting", "delivery_unknown"]) {
  test(`draft recovery cannot reauthorize ${delivery} delivery`, async () => {
    const { state, browser, conversation } = setup();
    browser.restoredDraft = "Old draft";
    const t = await start(conversation, "unknown-recovery", "Question");
    t.runs[0].state = delivery;
    state.write("task-" + t.id, t);
    await expect(
      conversation.clearDraft(t.id, t.currentRun, "Old draft"),
    ).rejects.toThrow("RUN_NOT_PREPARED");
    await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
      "RUN_NOT_PREPARED",
    );
    expect(browser.clears).toBe(0);
    expect(browser.sends).toBe(0);
  });
}

test("explicit rejected-send recovery keeps task/run/prompt and durably audits the old user before sending once", async () => {
  const { conversation, browser, t, options } = await missingDelivery();
  const prior = structuredClone(t.runs[0]);
  const original = browser.page.bind(browser);
  browser.page = async (target) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "click") {
          const saved = conversation.get(t.id).runs.at(-1)!;
          expect(saved.state).toBe("submitting");
          expect(saved.sendRecoveries?.at(-1)).toMatchObject({
            priorUserMessageId: options.expectedUserMessageId,
            priorAttemptId: t.attemptId,
            reason: options.reason,
            evidence: options.evidence[0],
          });
        }
        return b.run(...args);
      },
    };
  };
  const recovered = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(recovered.currentRun).toBe(t.currentRun);
  expect(recovered.url).toBe(t.url);
  expect(recovered.runs).toHaveLength(2);
  expect(recovered.runs[0]).toEqual(prior);
  expect(recovered.runs[1].prompt).toBe(t.runs[1].prompt);
  expect(recovered.runs[1].userMessageId).toBe("u3");
  expect(recovered.runs[1].state).toBe("waiting");
  expect(browser.sends).toBe(3);
  await expect(
    conversation.recoverSend(t.id, t.currentRun, options),
  ).rejects.toThrow("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  await conversation.resume(t.id, t.currentRun);
  expect(browser.sends).toBe(3);
});

for (const scenario of [
  "stale-run",
  "old-user",
  "url",
  "prompt",
  "reason",
  "unconfirmed",
  "missing-evidence",
  "wrong-status",
  "wrong-endpoint",
  "wrong-time",
  "ambiguous-evidence",
  "waiting",
  "delivery_unknown",
  "prepared",
  "complete",
  "borrowed",
  "closed",
  "epoch",
  "target-gone",
  "target-navigated",
  "user-present",
  "marker-present",
  "draft",
  "attachments",
  "generating",
  "no-composer",
  "blocked-page",
  "changed-reply",
  "changed-branch",
  "changed-prior-user",
]) {
  test(`rejected-send recovery refuses ${scenario} without filling, sending, or changing saved delivery`, async () => {
    const { state, conversation, browser, t, p, options } =
      await missingDelivery();
    let run = t.currentRun;
    if (scenario === "stale-run") run = "stale";
    if (scenario === "old-user") options.expectedUserMessageId = "other";
    if (scenario === "url") options.expectedUrl = "https://chatgpt.com/c/other";
    if (scenario === "prompt") options.input += "changed";
    if (scenario === "reason") options.reason = " ";
    if (scenario === "unconfirmed") options.confirmCloudflareChallenge = false;
    if (scenario === "missing-evidence") options.evidence = [];
    if (scenario === "wrong-status") options.evidence[0].status = 200;
    if (scenario === "wrong-endpoint") options.evidence[0].url += "/prepare";
    if (scenario === "wrong-time") options.rejectedAt -= 60000;
    if (scenario === "ambiguous-evidence")
      options.evidence.push({ ...options.evidence[0] });
    if (
      ["waiting", "delivery_unknown", "prepared", "complete"].includes(scenario)
    )
      t.runs[1].state = scenario;
    if (scenario === "waiting") t.runs[1].observationError = undefined;
    if (scenario === "borrowed") t.binding!.owned = false;
    if (scenario === "closed") t.binding!.closed = true;
    if (scenario === "epoch") browser.epochValue = "restarted";
    if (scenario === "target-gone") browser.targets = [];
    if (scenario === "target-navigated") browser.targets[0].url += "-other";
    if (scenario === "user-present")
      p.messages.push({
        id: options.expectedUserMessageId,
        role: "user",
        text: "changed",
      });
    if (scenario === "marker-present")
      p.messages.push({
        id: "different",
        role: "user",
        text: t.runs[1].prompt,
      });
    if (scenario === "draft") p.draft = "User edit";
    if (scenario === "attachments") p.attachments = true;
    if (scenario === "generating") p.generating = true;
    if (scenario === "no-composer") p.hasComposer = false;
    if (scenario === "blocked-page") p.blocked = "Cloudflare";
    if (scenario === "changed-reply") p.messages[1].text = "changed";
    if (scenario === "changed-branch")
      p.messages.splice(1, 0, {
        id: "new-branch",
        role: "assistant",
        text: "new",
      });
    if (scenario === "changed-prior-user")
      p.messages[0].text = "edited prior user";
    state.write("task-" + t.id, t);
    const before = conversation.get(t.id);
    await expect(
      conversation.recoverSend(t.id, run, options),
    ).rejects.toThrow();
    expect(conversation.get(t.id)).toEqual(before);
    expect(browser.sends).toBe(2);
    expect(p.draft).toBe(scenario === "draft" ? "User edit" : "");
    expect(browser.nextTarget).toBe(1);
  });
}

for (const drift of ["marker", "history", "target", "epoch"]) {
  test(`rejected-send recovery rechecks ${drift} after model selection without granting ordinary retry`, async () => {
    const { state, browser, t, p, options } = await missingDelivery();
    const conversation = new Conversation(state, browser as any, async () => {
      if (drift === "marker")
        p.messages.push({ id: "late", role: "user", text: t.runs[1].prompt });
      if (drift === "history") p.messages[1].text = "changed reply";
      if (drift === "target") browser.targets = [];
      if (drift === "epoch") browser.epochValue = "new epoch";
      return { observedModel: "6 Pro" };
    });
    const result = await conversation.recoverSend(t.id, t.currentRun, options);
    expect(result.runs[1].state).toBe("waiting");
    expect(result.runs[1].userMessageId).toBe(options.expectedUserMessageId);
    expect(result.runs[1].sendRecoveries).toBeUndefined();
    expect(result.runs[1].error).toBeTruthy();
    await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
      "RUN_NOT_PREPARED",
    );
    expect(browser.sends).toBe(2);
    expect(browser.nextTarget).toBe(1);
  });
}

test("a recovery send transport failure stays uncertain, retains audit, and cannot reuse rejection evidence", async () => {
  const { conversation, browser, t, options, p } = await missingDelivery();
  browser.failSend = true;
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("delivery_unknown");
  expect(result.runs[1].sendRecoveries).toHaveLength(1);
  expect(result.runs[1].userMessageId).toBeUndefined();
  await expect(conversation.retry(t.id, t.currentRun)).rejects.toThrow(
    "RUN_NOT_PREPARED",
  );
  await expect(
    conversation.recoverSend(t.id, t.currentRun, options),
  ).rejects.toThrow("RECOVERY_REQUIRES_BLOCKED_DELIVERY");
  const observed = await conversation.resume(t.id, t.currentRun);
  const newId = observed.runs[1].userMessageId!;
  p.messages = p.messages.slice(0, 2);
  p.generating = false;
  await expect(conversation.resume(t.id, t.currentRun)).rejects.toThrow(
    "HISTORY_HYDRATING",
  );
  await expect(
    conversation.recoverSend(t.id, t.currentRun, {
      ...options,
      expectedUserMessageId: newId,
    }),
  ).rejects.toThrow("REJECTED_SEND_EVIDENCE_REQUIRED");
  expect(browser.sends).toBe(3);
});

test("legacy confirmed records without a send timestamp recover using creation time and persist only allowlisted evidence", async () => {
  const { state, conversation, t, options } = await missingDelivery();
  delete t.runs[1].submittedAt;
  state.write("task-" + t.id, t);
  const result = await conversation.recoverSend(t.id, t.currentRun, {
    ...options,
    evidence: [
      { ...options.evidence[0], unrelatedMetadata: "must not be persisted" },
    ],
  });
  expect(result.runs[1].state).toBe("waiting");
  expect(result.runs[1].sendRecoveries![0].evidence).toEqual(
    options.evidence[0],
  );
});

test("recovery rechecks the composer after the final target check", async () => {
  const { browser, conversation, t, p, options } = await missingDelivery();
  const original = browser.tabs.bind(browser);
  let lists = 0;
  browser.tabs = async (...args) => {
    if (args[0] === "list" && ++lists === 2)
      p.draft = "User changed the composer";
    return original(...args);
  };
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("waiting");
  expect(result.runs[1].error).toContain("RECOVERY_DRAFT_OR_SEND_CHANGED");
  expect(result.runs[1].sendRecoveries).toBeUndefined();
  expect(p.draft).toBe("User changed the composer");
  expect(browser.sends).toBe(2);
});

test("recovery anchors the completed user despite rendered code whitespace and Show more text", async () => {
  const { conversation, t, p, options } = await missingDelivery(
    "Architecture review\n\n```ts\n/*\n *   request's cost; the next request is then blocked.\n */\n```\n",
  );
  p.messages[0].text = `${t.runs[0].marker}\n\nArchitecture review\n\n\n\`\`\`ts\n/*\n * request's cost; the next request is then blocked.\n */\n\`\`\`\n\nShow more`;
  const recovered = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(recovered.runs[1].state).toBe("waiting");
  expect(recovered.runs[0]).toEqual(t.runs[0]);
});

for (const mismatch of [
  "missing-marker",
  "duplicate-marker",
  "repeated-marker",
  "changed-user-id",
  "corrupt-saved-marker",
]) {
  test(`completed-user recovery anchor rejects ${mismatch}`, async () => {
    const { conversation, state, browser, t, p, options } =
      await missingDelivery();
    if (mismatch === "missing-marker")
      p.messages[0].text = "Architecture review";
    if (mismatch === "duplicate-marker")
      p.messages.unshift({
        id: "unrelated",
        role: "user",
        text: t.runs[0].marker,
      });
    if (mismatch === "repeated-marker") p.messages[0].text += t.runs[0].marker;
    if (mismatch === "changed-user-id") p.messages[0].id = "unrelated";
    if (mismatch === "corrupt-saved-marker") {
      t.runs[0].marker = "";
      state.write("task-" + t.id, t);
    }
    await expect(
      conversation.recoverSend(t.id, t.currentRun, options),
    ).rejects.toThrow();
    expect(browser.sends).toBe(2);
    expect(p.draft).toBe("");
  });
}

for (const mode of [
  "observed",
  "observed-over-config",
  "history-fallback",
  "config-fallback",
  "default-fallback",
]) {
  test(`recovery retains its observed model and both verifications: ${mode}`, async () => {
    const { state, browser, t, options } = await missingDelivery();
    t.config.model = mode.includes("config") ? "5.6 Pro" : undefined;
    t.runs[1].observedModel = mode.startsWith("observed") ? "6 Pro" : undefined;
    if (mode === "default-fallback") delete t.runs[0].observedModel;
    state.write("task-" + t.id, t);
    const checks: Record<string, string>[] = [];
    const expected =
      mode === "default-fallback"
        ? ""
        : mode === "config-fallback"
          ? "5.6 Pro"
          : "6 Pro";
    const selected = expected || "7 Pro";
    const conversation = new Conversation(
      state,
      browser as any,
      async (_b, opts) => {
        checks.push(opts);
        if (opts.model !== (checks.length === 1 ? expected : selected))
          throw new Error(
            "Unexpected model selection; original model must be retained",
          );
        return { observedModel: selected };
      },
    );
    const result = await conversation.recoverSend(t.id, t.currentRun, options);
    expect(result.runs[1].state).toBe("waiting");
    expect(checks).toEqual([
      { url: t.url!, target: t.binding!.target, model: expected },
      {
        url: t.url!,
        target: t.binding!.target,
        model: selected,
        "verify-only": "true",
      },
    ]);
    expect(result.runs[1].observedModel).toBe(selected);
    expect(browser.sends).toBe(3);
  });
}

test("recovery retaining a model still refuses a failed final verification", async () => {
  const { state, browser, t, options } = await missingDelivery();
  const conversation = new Conversation(
    state,
    browser as any,
    async (_b, opts) => {
      if (opts["verify-only"] === "true")
        throw new Error("MODEL_UNVERIFIED: configured model did not persist");
      return { observedModel: "6 Pro" };
    },
  );
  const result = await conversation.recoverSend(t.id, t.currentRun, options);
  expect(result.runs[1].state).toBe("waiting");
  expect(result.runs[1].error).toContain(
    "MODEL_UNVERIFIED: configured model did not persist",
  );
  expect(result.runs[1].sendRecoveries).toBeUndefined();
  expect(browser.sends).toBe(2);
});
