// Reused from skill-foundry 19f0122 (Apache-2.0).
import { describe, expect, test } from "bun:test";
import {
  conversationTitle,
  metadataFromResponse,
  organizeConversation,
  projectId,
  type OrganizationPreferences,
} from "../../src/browser/chatgpt/organize.ts";

const url = "https://chatgpt.com/c/review-a";
const preferences: OrganizationPreferences = {
  projectName: "Agent reviews",
  projectUrl: "https://chatgpt.com/g/g-p-example-agent-reviews/project",
  timezone: "Asia/Shanghai",
  language: "en",
};
const body = () => ({
  conversation_id: "review-a",
  title: "Automatic title",
  create_time: Date.parse("2026-09-15T17:00:00Z") / 1000,
  update_time: Date.parse("2026-10-01T00:00:00Z") / 1000,
  gizmo_id: null as string | null,
  is_archived: false,
  is_starred: null as boolean | null,
  pinned_time: null,
});
function fixture(
  options: {
    wrongUrl?: boolean;
    blocked?: string;
    generating?: boolean;
    ignoreRename?: boolean;
    rejectRename?: boolean;
    changePinned?: boolean;
    metadataFallback?: boolean;
    initialProject?: string;
  } = {},
) {
  let saved = { ...body(), gizmo_id: options.initialProject ?? null },
    pending = "",
    menu = "",
    editing = false,
    sequence = 0,
    reloads = 0,
    focused = "";
  let fallbackPending = false;
  const requests: any[] = [],
    snapshots = new Map<string, any>(),
    mutations: string[][] = [];
  requests.push({
    requestId: "initial",
    method: "GET",
    status: 200,
    url: "https://chatgpt.com/backend-api/conversations/review-a",
  });
  snapshots.set("initial", { ...saved });
  const savedRequest = (action: string, status = 200) =>
    requests.push({
      requestId: "save" + ++sequence,
      method: "POST",
      status,
      url: `https://chatgpt.com/backend-api/conversation/id/review-a/${action}`,
    });
  return {
    mutations,
    saved: () => saved,
    reloads: () => reloads,
    session: "organize-test",
    read: async () => ({
      url: options.wrongUrl ? "https://chatgpt.com/c/other" : url,
      generating: options.generating ?? false,
      blocked: options.blocked ?? null,
      hasComposer: true,
    }),
    run: async (...args: string[]) => {
      if (args[0] === "network" && args[1] === "requests") {
        const latest = requests.at(-1);
        if (fallbackPending && latest?.status === 403) {
          const requestId = "fallback" + ++sequence;
          requests.push({
            requestId,
            method: "GET",
            status: 200,
            url: "https://chatgpt.com/backend-api/conversation/review-a",
          });
          snapshots.set(requestId, { ...saved });
          fallbackPending = false;
        }
        const observed = [...requests];
        if (options.metadataFallback && latest?.status === 403)
          fallbackPending = true;
        return { requests: observed };
      }
      if (args[0] === "network" && args[1] === "request")
        return {
          status: 200,
          responseBody: JSON.stringify(snapshots.get(args[2])),
        };
      if (args[0] === "eval")
        return {
          result: {
            options: "#options",
            expand: null,
            titleInput: editing ? "#title" : null,
            rename: menu === "options" ? "#rename" : null,
          },
        };
      if (args[0] === "reload") {
        reloads++;
        sequence++;
        const requestId = "r" + sequence;
        requests.push({
          requestId,
          method: "GET",
          status: 200,
          url: "https://chatgpt.com/backend-api/conversations/review-a?num_turns=10",
        });
        snapshots.set(requestId, { ...saved });
        if (options.metadataFallback) {
          requests.at(-1).status = 403;
          fallbackPending = false;
        }
        return {};
      }
      mutations.push(args);
      if (args[0] === "focus") focused = args[1];
      else if (
        args[0] === "press" &&
        args[1] === "Enter" &&
        focused === "#options" &&
        !editing
      )
        menu = "options";
      else if (args[0] === "click" && args[1] === "#rename") {
        editing = true;
        menu = "";
      } else if (args[0] === "fill") {
        pending = args[2];
        focused = "#title";
      } else if (args[0] === "press" && args[1] === "Enter") {
        if (!options.ignoreRename && !options.rejectRename)
          saved.title = pending;
        if (options.changePinned) saved.is_starred = true;
        editing = false;
        savedRequest("rename", options.rejectRename ? 403 : 200);
      } else throw new Error("Unexpected mutation: " + args.join(" "));
      return {};
    },
  };
}

describe("conversation organization", () => {
  test("rejects a project mismatch before changing the title", async () => {
    const b = fixture();
    await expect(
      organizeConversation(b, url, preferences, "FEA", "Topic"),
    ).rejects.toThrow("Project membership does not match");
    expect(b.mutations).toHaveLength(0);
  });
  test("without a configured project only renames and preserves existing placement", async () => {
    for (const initialProject of [undefined, "g-p-user-project"]) {
      const b = fixture({ initialProject });
      const naming = { timezone: "Asia/Shanghai", language: "en" as const };
      expect(
        await organizeConversation(b, url, naming, "FEA", "内置审查技能"),
      ).toMatchObject({
        verified: true,
        title: "0916｜FEA｜内置审查技能",
        projectId: initialProject ?? null,
      });
      expect(b.saved()).toMatchObject({
        gizmo_id: initialProject ?? null,
        is_archived: false,
      });
      expect(b.mutations.some((args) => args.includes("Move to project"))).toBe(
        false,
      );
    }
  });
  test("partial project preferences fail before UI changes", async () => {
    const b = fixture();
    await expect(
      organizeConversation(
        b,
        url,
        { ...preferences, projectName: undefined },
        "FEA",
        "Topic",
      ),
    ).rejects.toThrow("Project");
    expect(b.mutations).toHaveLength(0);
  });
  test("uses actual creation time in the configured timezone and language", () => {
    const meta = metadataFromResponse(
      { status: 200, responseBody: JSON.stringify(body()) },
      "review-a",
    );
    expect(
      conversationTitle(meta.createdAt, "FIX", "迁移衔接", preferences),
    ).toBe("0916｜FIX｜迁移衔接");
    expect(
      conversationTitle(meta.createdAt, "FIX", "迁移衔接", {
        ...preferences,
        timezone: "UTC",
        language: "zh",
      }),
    ).toBe("0915｜修复｜迁移衔接");
    expect(projectId(preferences.projectUrl!)).toBe("g-p-example");
  });
  test("does not replace missing creation metadata with update time or another conversation", () => {
    for (const patch of [
      { create_time: undefined },
      { conversation_id: "other" },
      { create_time: "2026-09-15" },
    ]) {
      expect(() =>
        metadataFromResponse(
          { status: 200, responseBody: { ...body(), ...patch } },
          "review-a",
        ),
      ).toThrow("metadata");
    }
  });
  test("renames the exact project conversation, verifies persisted metadata, then reruns without mutations", async () => {
    const b = fixture({ initialProject: "g-p-example" });
    expect(
      await organizeConversation(b, url, preferences, "FIX", "迁移衔接"),
    ).toMatchObject({
      verified: true,
      changed: true,
      title: "0916｜FIX｜迁移衔接",
      projectId: "g-p-example",
      conversationCreatedAt: "2026-09-15T17:00:00.000Z",
    });
    const count = b.mutations.length;
    const reloadCount = b.reloads();
    expect(
      await organizeConversation(b, url, preferences, "FIX", "迁移衔接"),
    ).toMatchObject({ verified: true, changed: false });
    expect(b.mutations.length).toBe(count);
    expect(b.reloads()).toBe(reloadCount);
    expect(b.saved()).toMatchObject({
      is_archived: false,
      is_starred: null,
      pinned_time: null,
    });
  });
  test("waits for the UI metadata fallback after a rejected endpoint without reloading again", async () => {
    expect(
      await organizeConversation(
        fixture({ metadataFallback: true, initialProject: "g-p-example" }),
        url,
        preferences,
        "FIX",
        "Topic",
      ),
    ).toMatchObject({ verified: true, projectId: "g-p-example" });
  });
  test("refuses navigation drift and active generation before mutation", async () => {
    for (const opts of [{ wrongUrl: true }, { generating: true }]) {
      const b = fixture(opts);
      await expect(
        organizeConversation(b, url, preferences, "FIX", "Topic"),
      ).rejects.toThrow();
      expect(b.mutations).toHaveLength(0);
    }
  });
  test("renames during generation using a separate metadata observer", async () => {
    const b = fixture({ generating: true, initialProject: "g-p-example" });
    const observer = {
      ...b,
      read: async () => ({ ...(await b.read()), generating: false }),
    };
    const active = {
      ...b,
      run: async (...args: string[]) => {
        if (args[0] === "reload")
          throw new Error("Generation must not be reloaded");
        return b.run(...args);
      },
    };
    expect(
      await organizeConversation(
        active,
        url,
        preferences,
        "OPT",
        "创建路径",
        undefined,
        observer,
      ),
    ).toMatchObject({ verified: true, title: "0916｜OPT｜创建路径" });
    expect((await b.read()).generating).toBe(true);
  });
  test("fails when a clicked rename was not persisted", async () => {
    await expect(
      organizeConversation(
        fixture({ ignoreRename: true, initialProject: "g-p-example" }),
        url,
        preferences,
        "FIX",
        "Topic",
      ),
    ).rejects.toThrow("title did not persist");
  });
  test("reports a rejected save and does not attempt to move the conversation", async () => {
    const b = fixture({ rejectRename: true, initialProject: "g-p-example" });
    await expect(
      organizeConversation(b, url, preferences, "FIX", "Topic"),
    ).rejects.toThrow("Title save rejected (HTTP 403)");
    expect(b.saved().gizmo_id).toBe("g-p-example");
    expect(b.saved().title).toBe("Automatic title");
  });
  test("detects unrelated archive or pin changes", async () => {
    await expect(
      organizeConversation(
        fixture({ changePinned: true, initialProject: "g-p-example" }),
        url,
        preferences,
        "FIX",
        "Topic",
      ),
    ).rejects.toThrow("Unrelated");
  });
  test("rejects invalid naming input before changing the conversation", async () => {
    const b = fixture();
    await expect(
      organizeConversation(b, url, preferences, "UNKNOWN", "Topic"),
    ).rejects.toThrow("title type");
    expect(b.mutations).toHaveLength(0);
  });
});

test("naming persists the write boundary and recovers a lost save acknowledgement by reading only", async () => {
  const b = fixture({ initialProject: "g-p-example" });
  const original = b.run;
  let submit = false;
  const progress: any[] = [];
  const interrupted = {
    ...b,
    run: async (...args: string[]) => {
      const result = await original(...args);
      if (args[0] === "fill") submit = true;
      else if (submit && args[0] === "press" && args[1] === "Enter")
        throw new Error("Connection lost after title save");
      return result;
    },
  };
  await expect(
    organizeConversation(
      interrupted,
      url,
      preferences,
      "FIX",
      "Recovery",
      (p) => progress.push(structuredClone(p)),
    ),
  ).rejects.toThrow("Connection lost");
  const checkpoint = progress.at(-1);
  expect(checkpoint.phase).toBe("save_pending");
  expect(checkpoint.baseline.title).toBe("Automatic title");
  const mutations = b.mutations.length;
  const verified = await organizeConversation(
    b,
    url,
    preferences,
    "FIX",
    "Recovery",
    undefined,
    undefined,
    { verificationOnly: true, baseline: checkpoint.baseline },
  );
  expect(verified.verified).toBe(true);
  expect(b.mutations.length).toBe(mutations);
});

test("verification-only naming never resubmits an unconfirmed title", async () => {
  const b = fixture({ initialProject: "g-p-example" });
  await expect(
    organizeConversation(
      b,
      url,
      preferences,
      "FIX",
      "Recovery",
      undefined,
      undefined,
      {
        verificationOnly: true,
        baseline: {
          id: "review-a",
          title: "Automatic title",
          createdAt: new Date(body().create_time * 1000).toISOString(),
          projectId: "g-p-example",
          archived: false,
          starred: null,
          pinnedTime: null,
        },
      },
    ),
  ).rejects.toThrow("ORGANIZATION_SAVE_UNCONFIRMED");
  expect(b.mutations).toHaveLength(0);
});

test.each([
  "Conversation UI reported an error",
  "Login required",
  "Human verification required",
])(
  "title organization isolates generic render alert from access blocks: %s",
  async (blocked) => {
    const b = fixture({ blocked });
    if (blocked === "Conversation UI reported an error") {
      expect(
        (
          await organizeConversation(
            b as any,
            url,
            { timezone: "Asia/Shanghai", language: "en" },
            "FIX",
            "命名",
            undefined,
            b as any,
          )
        ).verified,
      ).toBe(true);
    } else {
      await expect(
        organizeConversation(
          b as any,
          url,
          { timezone: "Asia/Shanghai", language: "en" },
          "FIX",
          "命名",
          undefined,
          b as any,
        ),
      ).rejects.toThrow(blocked);
      expect(b.mutations).toHaveLength(0);
    }
  },
);
