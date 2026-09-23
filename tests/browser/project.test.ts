import { test, expect } from "bun:test";
import {
  assertNewConversationPage,
  verifyProjectComposer,
} from "../../src/browser/chatgpt/project.ts";
import { diagnosticCode } from "../../src/storage/diagnostics.ts";
const url = "https://chatgpt.com/g/g-p-1234-reviews/project";
const ready = {
  url,
  composerCount: 1,
  editable: true,
  messageCount: 0,
  projectName: "renamed",
};

test("project identity follows its ID, while readiness tolerates hydration", async () => {
  let reads = 0;
  await verifyProjectComposer(
    {
      run: async () => ({
        result:
          ++reads === 1
            ? { ...ready, composerCount: 0, editable: false }
            : ready,
      }),
    },
    url,
    { intervalMs: 1 },
  );
  expect(reads).toBe(2);
  expect(() =>
    assertNewConversationPage(
      {
        url: "https://chatgpt.com/g/g-p-1234-new-name/project",
        messages: [],
      } as any,
      url,
    ),
  ).not.toThrow();
});

test("project identity changes and existing messages fail without waiting", async () => {
  for (const result of [
    { ...ready, url: "https://chatgpt.com/g/g-p-other/project" },
    { ...ready, messageCount: 1 },
  ]) {
    let reads = 0;
    await expect(
      verifyProjectComposer(
        {
          run: async () => {
            reads++;
            return { result };
          },
        },
        url,
      ),
    ).rejects.toThrow(
      result.messageCount
        ? "UNEXPECTED_CONVERSATION_HISTORY"
        : "PROJECT_IDENTITY_CHANGED",
    );
    expect(reads).toBe(1);
  }
});

test("project readiness has a bounded wait and a specific diagnostic", async () => {
  let error: unknown;
  try {
    await verifyProjectComposer(
      {
        run: async () => ({
          result: { ...ready, composerCount: 0, editable: false },
        }),
      },
      url,
      { timeoutMs: 5, intervalMs: 1 },
    );
  } catch (e) {
    error = e;
  }
  expect(String(error)).toContain("composers=0");
  expect(diagnosticCode(error)).toBe("PROJECT_COMPOSER_NOT_READY");
});
