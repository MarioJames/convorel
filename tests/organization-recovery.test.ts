import { test, expect } from "bun:test";
import { organizationRecovery } from "../src/organization-recovery.ts";
import type { Task } from "../src/conversation.ts";
const task = (organization: any) =>
  ({
    url: "https://chatgpt.com/c/example",
    naming: { type: "FIX", topic: "恢复" },
    organization,
  }) as Task;
test("sidebar delay before editing is retryable even with rename progress", () => {
  expect(
    organizationRecovery(
      task({
        phase: "locating",
        rename: { verified: false },
        attempts: 1,
        error:
          "Error: Target conversation not visible in sidebar; open its project/history before retrying",
      }),
    )?.state,
  ).toBe("retry_pending");
});
test("unknown save is verification-only while editing and legacy writes are not replayed", () => {
  expect(
    organizationRecovery(
      task({
        phase: "save_pending",
        attempts: 1,
        error: "Error: Connection lost after title save",
      }),
    )?.state,
  ).toBe("retry_pending");
  for (const phase of [undefined, "editing"])
    expect(
      organizationRecovery(
        task({
          phase,
          rename: {},
          attempts: 1,
          error: "Conversation UI reported an error",
        }),
      )?.state,
    ).toBe("needs_attention");
  expect(
    organizationRecovery(
      task({
        phase: "verifying",
        attempts: 2,
        error:
          "Error: ORGANIZATION_SAVE_UNCONFIRMED: inspect the original title edit; no automatic resubmit",
      }),
    )?.state,
  ).toBe("needs_attention");
});
