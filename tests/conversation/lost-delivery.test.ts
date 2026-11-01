import { expect, test } from "bun:test";
import { conversationStatus } from "../../src/conversation/status.ts";
import { conversationHarness } from "../support/conversation.ts";

const { start, missingDelivery } = conversationHarness();

/** The server-rendered conversation a full load embeds in its scripts. */
function serverDocument(browser: any, target: string) {
  const p = browser.pages.get(target);
  return JSON.stringify({
    conversation_id: "test-conversation",
    mapping: p.messages.map((m: any) => ({ id: m.id, parts: [m.text] })),
  });
}

/** Answers the in-page script count read from the document loaded by the last reload. */
function observeDocument(
  browser: any,
  render = (b: any, t: string) => serverDocument(b, t),
) {
  let rendered = "";
  const original = browser.page.bind(browser);
  browser.page = async (target: string) => {
    const b = await original(target);
    return {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "eval" && args[1].includes("document.scripts")) {
          const needles = JSON.parse(
            args[1].match(/const needles = (\{.*\});/)![1],
          );
          return {
            result: Object.fromEntries(
              Object.entries(needles).map(([k, v]) => [
                k,
                rendered.split(v as string).length - 1,
              ]),
            ),
          };
        }
        const out = await b.run(...args);
        if (args[0] === "reload") rendered = render(browser, target);
        return out;
      },
    };
  };
}

async function lostDelivery(ageMs = 11 * 60_000) {
  const ctx = await missingDelivery();
  const t = ctx.conversation.get(ctx.t.id);
  t.runs.at(-1)!.submittedAt = new Date(Date.now() - ageMs).toISOString();
  ctx.state.write("task-" + t.id, t);
  const options = {
    expectedUserMessageId: ctx.options.expectedUserMessageId,
    expectedUrl: ctx.options.expectedUrl,
  };
  return { ...ctx, t: ctx.conversation.get(t.id), options };
}

test("a submitted message the server never stored settles as lost and the same conversation accepts a new followup", async () => {
  const { conversation, browser, t, options } = await lostDelivery();
  observeDocument(browser);
  const sends = browser.sends;
  const lost = await conversation.markLost(t.id, t.currentRun, options);
  const r = lost.runs.at(-1)!;
  expect(r.state).toBe("lost");
  expect(r.userMessageId).toBeUndefined();
  expect(r.lost).toMatchObject({
    priorUserMessageId: options.expectedUserMessageId,
    anchorReply: t.runs[0].reply!.id,
  });
  expect(r.observationError).toBeUndefined();
  expect(conversationStatus(lost)).toMatchObject({
    delivery: "lost",
    phase: "delivery_lost",
    nextAction: "followup",
  });
  expect(browser.sends).toBe(sends);
  const resumed = await conversation.resume(t.id, t.currentRun);
  expect(resumed.runs.at(-1)!.state).toBe("lost");

  const next = await start(conversation, t.id, "Short review", "short", true);
  expect(browser.sends).toBe(sends + 1);
  expect(next.runs).toHaveLength(3);
  expect(next.runs[1].state).toBe("lost");
  expect(next.runs[2].state).toBe("waiting");
  browser.complete();
  const done = await conversation.resume(t.id, next.currentRun);
  expect(done.runs[2].state).toBe("complete");
});

for (const [scenario, code] of Object.entries({
  "too-early": "LOST_TOO_EARLY",
  "wrong-user": "EXPECTED_USER_MESSAGE_MISMATCH",
  "wrong-url": "EXPECTED_URL_MISMATCH",
  "not-hydrating": "LOST_REQUIRES_UNMOUNTED_DELIVERY",
  "server-has-user": "SUBMITTED_MESSAGE_PRESENT",
  "server-has-marker": "SUBMITTED_MESSAGE_PRESENT",
  "server-without-anchor": "CONVERSATION_HISTORY_UNAVAILABLE",
  "page-has-marker": "SUBMITTED_MESSAGE_PRESENT",
  "target-navigated": "LOST_TARGET_CHANGED",
})) {
  test(`lost settlement refuses ${scenario} and keeps the saved delivery`, async () => {
    const { state, conversation, browser, t, p, options } = await lostDelivery(
      scenario === "too-early" ? 60_000 : undefined,
    );
    const userId = options.expectedUserMessageId;
    const marker = t.runs.at(-1)!.marker;
    observeDocument(browser, (b, target) => {
      const rendered = serverDocument(b, target);
      if (scenario === "server-has-user") return rendered + userId;
      if (scenario === "server-has-marker") return rendered + marker;
      if (scenario === "server-without-anchor")
        return rendered.replaceAll(t.runs[0].reply!.id, "");
      return rendered;
    });
    const opts = { ...options };
    if (scenario === "wrong-user") opts.expectedUserMessageId = "other";
    if (scenario === "wrong-url") opts.expectedUrl = "https://chatgpt.com/c/x";
    if (scenario === "not-hydrating") {
      const saved = conversation.get(t.id);
      saved.runs.at(-1)!.observationError = undefined;
      state.write("task-" + t.id, saved);
    }
    if (scenario === "page-has-marker")
      p.messages.push({ id: "late", role: "user", text: marker, final: true });
    if (scenario === "target-navigated") {
      const target = browser.targets.find(
        (x) => x.targetId === t.binding!.target,
      );
      target.url = p.url = "https://chatgpt.com/c/elsewhere";
    }
    const before = conversation.get(t.id);
    await expect(
      conversation.markLost(t.id, t.currentRun, opts),
    ).rejects.toThrow(code);
    expect(conversation.get(t.id).runs).toEqual(before.runs);
    await expect(
      start(conversation, t.id, "Short review", "short", true),
    ).rejects.toThrow("PRIOR_RUN_NOT_COMPLETE");
  }, 15_000);
}
