import { sha } from "../../src/hash.ts";

/** Fixtures shared by the archive scenario suites: pure factories only, each test
 * file owns its own temp directory lifecycle. */
export const CHATGPT_URL = "https://chatgpt.com/g/g-p-1/proj/c/abc-123";
export const RENDERED = "结论 推荐 A";

export const taskDoc = (overrides: any = {}) =>
  ({
    version: 1,
    id: "review",
    url: CHATGPT_URL,
    config: {
      version: 1,
      workspace: "/home/mocha/project",
      cdp: "http://127.0.0.1:9222",
      projectName: "proj",
    },
    workspaceId: "w1",
    currentRun: "r1",
    attemptId: "a1",
    naming: { type: "DES", topic: "注册防枚举" },
    runs: [
      {
        id: "r1",
        requestId: "initial",
        prompt: "[M1]\n\n注册入口防枚举方案",
        promptHash: sha("[M1]\n\n注册入口防枚举方案"),
        marker: "[M1]",
        state: "complete",
        userMessageId: "u1",
        createdAt: "2026-09-20T01:00:00.000Z",
        lastObservedAt: "2026-09-20T01:05:00.000Z",
        reply: { id: "m1", role: "assistant", text: RENDERED, final: true },
        replyHash: sha(RENDERED),
        observedModel: "6 Pro",
        branch: ["u1", "m1"],
      },
    ],
    ...overrides,
  }) as any;
