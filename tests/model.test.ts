// Reused from skill-foundry 19f0122 (Apache-2.0).
import { describe, expect, test } from "bun:test";
import {
  MODEL_SELECT,
  MODEL_POWER,
  MODEL_LATEST,
} from "../src/chatgpt/controls.ts";
import { ensureModel, type ModelState } from "../src/chatgpt/model.ts";

const opts = { url: "https://chatgpt.com/", target: "TASK-TAB" };
// Simulate only the external browser UI. The production selection algorithm runs unchanged.
function fixture(
  initial: {
    version?: string;
    effort?: number;
    disabled?: boolean;
    url?: string;
    generating?: boolean;
    latestVersion?: string;
    ignoreKeys?: boolean;
    closeFallback?: boolean;
    driftAfterOpen?: boolean;
    maxPower?: number;
    maxLabel?: string;
    latestDisabled?: boolean;
    ignoreLatest?: boolean;
    controlDelay?: number;
    minPower?: number | null;
  } = {},
) {
  let version = initial.version ?? "5.6";
  let effort = initial.effort ?? 1;
  let expanded = false,
    models = false,
    focused = false;
  let url = initial.url ?? opts.url;
  const mutations: string[][] = [];
  let reads = 0;
  const max = initial.maxPower ?? 4;
  const label = () =>
    effort === max
      ? `${version} ${initial.maxLabel ?? "Pro"}`
      : `${version} ${["Light", "Standard", "High", "Extra High"][effort]}`;
  const state = (): ModelState => ({
    url,
    blocked: null,
    generating: initial.generating ?? false,
    hasComposer: true,
    control: {
      selector: "#model",
      label: expanded ? "Thinking effort" : label(),
      disabled: false,
      expanded,
    },
    menuLabel: expanded && !models ? label() : null,
    power:
      expanded && !models
        ? {
            value: effort,
            min: (initial.minPower === undefined
              ? 0
              : initial.minPower) as number,
            max,
            disabled: initial.disabled ?? false,
            focused,
            description:
              effort === max
                ? `${initial.maxLabel ?? "Pro"}, ${max + 1} of ${max + 1}. Use Left and Right arrow keys to adjust power.`
                : "Intermediate power.",
          }
        : null,
    latest:
      expanded && models
        ? {
            checked: version === (initial.latestVersion ?? "6"),
            disabled: initial.latestDisabled ?? false,
          }
        : null,
  });
  return {
    mutations,
    state,
    session: "test-session",
    run: async (...args: string[]) => {
      if (args[0] === "eval") {
        const observed = state();
        if (++reads <= (initial.controlDelay ?? 0)) observed.control = null;
        return { result: observed };
      }
      mutations.push(args);
      if (args[0] === "click" && args[1] === "#model") {
        expanded = true;
        if (initial.driftAfterOpen)
          url = "https://chatgpt.com/c/other-requirement";
      } else if (args[0] === "click" && args[1] === MODEL_SELECT) models = true;
      else if (args[0] === "click" && args[1] === MODEL_LATEST) {
        if (!initial.ignoreLatest) version = initial.latestVersion ?? "6";
        models = false;
      } else if (args[0] === "focus" && args[1] === MODEL_POWER) focused = true;
      else if (args[0] === "press" && args[1] === "ArrowRight") {
        if (!focused) throw new Error("Keyboard action escaped Power");
        if (!initial.ignoreKeys) effort = Math.min(max, effort + 1);
      } else if (args[0] === "press" && args[1] === "Escape") {
        expanded = false;
        models = false;
        focused = false;
        if (initial.closeFallback) version = "5.6";
      } else throw new Error("Unexpected browser mutation: " + args.join(" "));
      return {};
    },
  };
}

describe("pre-send Pro selection", () => {
  test("read-only pre-send confirmation rejects a changed model without selecting a fallback", async () => {
    const b = fixture({ version: "7", effort: 4 });
    await expect(
      ensureModel(b, { ...opts, model: "6 Pro", "verify-only": "true" }),
    ).rejects.toThrow("MODEL_UNVERIFIED");
    expect(b.mutations).toHaveLength(0);
  });
  test("missing slider attributes fail while a valid nonzero minimum is supported", async () => {
    await expect(
      ensureModel(fixture({ minPower: null }), opts),
    ).rejects.toThrow("unavailable");
    expect(
      await ensureModel(fixture({ minPower: 2, effort: 2 }), opts),
    ).toMatchObject({ observedModel: "6 Pro" });
  });
  test("waits for the model control to hydrate before interacting with a new page", async () => {
    expect(await ensureModel(fixture({ controlDelay: 2 }), opts)).toMatchObject(
      {
        verified: true,
        observedModel: "6 Pro",
      },
    );
  });
  test("switches an older model and low power, then confirms the closed control", async () => {
    const b = fixture();
    const result = await ensureModel(b, opts);
    expect(result).toMatchObject({
      verified: true,
      before: "5.6 Standard",
      observedModel: "6 Pro",
      changed: true,
      target: "TASK-TAB",
      evidence: { menuLabel: "6 Pro", power: 4 },
    });
    expect(b.state().control).toMatchObject({
      label: "6 Pro",
      expanded: false,
    });
    expect(b.mutations.filter((a) => a.includes("ArrowRight"))).toHaveLength(3);
  });
  test("verifies an already correct model without changing its model or power", async () => {
    const b = fixture({ version: "6", effort: 4 });
    expect(await ensureModel(b, { ...opts, model: "6 Pro" })).toMatchObject({
      verified: true,
      changed: false,
      observedModel: "6 Pro",
    });
    expect(b.mutations).toEqual([
      ["click", "#model"],
      ["press", "Escape"],
    ]);
  });
  test("refuses a disabled Pro control instead of claiming success from the label", async () => {
    await expect(
      ensureModel(fixture({ version: "6", effort: 4, disabled: true }), opts),
    ).rejects.toThrow("unavailable");
  });
  test("does not act on the wrong URL or a generating conversation", async () => {
    for (const initial of [
      { url: "https://chatgpt.com/c/unrelated" },
      { generating: true },
    ]) {
      const b = fixture(initial);
      await expect(ensureModel(b, opts)).rejects.toThrow();
      expect(b.mutations).toHaveLength(0);
    }
  });
  test("stops interacting if the page changes during selection", async () => {
    const b = fixture({ driftAfterOpen: true });
    await expect(ensureModel(b, opts)).rejects.toThrow("URL changed");
    expect(b.mutations).toEqual([["click", "#model"]]);
  });
  test("default selects the actual Latest Pro even after its version and slider range change", async () => {
    const b = fixture({
      version: "6",
      effort: 4,
      latestVersion: "7",
      maxPower: 6,
    });
    expect(await ensureModel(b, opts)).toMatchObject({
      verified: true,
      observedModel: "7 Pro",
      expectedModel: "latest-pro",
      evidence: { power: 6, latest: true },
    });
  });
  test("maximum effort without a Pro label is not a valid default", async () => {
    await expect(
      ensureModel(fixture({ maxLabel: "Ultra" }), opts),
    ).rejects.toThrow("Pro");
  });
  test("a disabled or ignored Latest selection cannot fall back to an older Pro", async () => {
    for (const initial of [{ latestDisabled: true }, { ignoreLatest: true }])
      await expect(
        ensureModel(fixture({ version: "5.6", effort: 4, ...initial }), opts),
      ).rejects.toThrow("Latest");
  });
  test("does not equate Latest and maximum effort with the requested version", async () => {
    await expect(
      ensureModel(fixture({ latestVersion: "7" }), { ...opts, model: "6 Pro" }),
    ).rejects.toThrow("expected model 6 Pro");
  });
  test("bounds retries when keyboard selection has no effect", async () => {
    const b = fixture({ version: "6", effort: 3, ignoreKeys: true });
    await expect(ensureModel(b, opts)).rejects.toThrow("did not advance");
    expect(b.mutations.filter((a) => a.includes("ArrowRight"))).toHaveLength(1);
  });
  test("requires the closed control to retain the selected model", async () => {
    await expect(
      ensureModel(fixture({ closeFallback: true }), opts),
    ).rejects.toThrow("did not confirm");
  });
  test("an explicit different model requires selection instead of silent fallback", async () => {
    const b = fixture();
    await expect(
      ensureModel(b, { ...opts, model: "Custom visible model" }),
    ).rejects.toThrow("MODEL_UNVERIFIED");
    await expect(
      ensureModel(b, { ...opts, url: "https://example.com/" }),
    ).rejects.toThrow("ChatGPT URL");
    expect(b.mutations).toHaveLength(0);
  });
});
