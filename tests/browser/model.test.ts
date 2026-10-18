// Reused from skill-foundry 19f0122 (Apache-2.0).
import { describe, expect, test } from "bun:test";
import {
  MODEL_SELECT,
  MODEL_POWER,
  MODEL_LATEST,
} from "../../src/browser/chatgpt/controls.ts";
import {
  ensureModel,
  type ModelState,
} from "../../src/browser/chatgpt/model.ts";
import { effortModelFixture } from "../support/effort-model.ts";

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
    compact?: boolean;
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
      ? `${version} ${initial.maxLabel ?? "Pro"}`.trim()
      : `${version} ${["Light", "Standard", "High", "Extra High"][effort]}`;
  const state = (): ModelState => ({
    url,
    blocked: null,
    generating: initial.generating ?? false,
    hasComposer: true,
    control: {
      selector: "#model",
      label: expanded
        ? "Thinking effort"
        : initial.compact
          ? (initial.maxLabel ?? "Pro")
          : label(),
      compact: initial.compact,
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
  test("effort-only UI proves the selected family and Pro Power independently", async () => {
    const b = effortModelFixture({ latest: true, value: 2 });
    const selected = await ensureModel(b, opts);
    expect(selected).toMatchObject({
      observedModel: "6 Pro",
      expectedModel: "latest-pro",
      evidence: { family: "GPT-6", power: 4, latest: true },
    });
    b.mutations.length = 0;
    expect(
      await ensureModel(b, {
        ...opts,
        model: "GPT-6 Pro",
        "verify-only": "true",
      }),
    ).toMatchObject({ observedModel: "6 Pro", changed: false });
    expect(
      b.mutations.some((a) =>
        ["focus", "ArrowRight"].some((x) => a.includes(x)),
      ),
    ).toBe(false);
  });
  test("effort-only explicit identity does not require or invent a Latest marker", async () => {
    expect(
      await ensureModel(effortModelFixture(), { ...opts, model: "6 Pro" }),
    ).toMatchObject({
      observedModel: "6 Pro",
      evidence: { family: "GPT-6", latest: false },
    });
  });
  test("effort-only default rechecks a named Latest selection before accepting its family", async () => {
    const b = effortModelFixture({
      latest: true,
      latestChecked: false,
      family: "GPT-5.6 Sol",
    });
    expect(await ensureModel(b, opts)).toMatchObject({
      observedModel: "6 Pro",
      changed: true,
      evidence: { family: "GPT-6", latest: true },
    });
    const ignored = effortModelFixture({
      latest: true,
      latestChecked: false,
      ignoreLatest: true,
    });
    await expect(ensureModel(ignored, opts)).rejects.toThrow(
      "Latest selection did not persist",
    );
    expect(ignored.mutations.filter((a) => a[1] === MODEL_LATEST)).toHaveLength(
      1,
    );
  });
  test("effort-only first GPT-6 radio is insufficient to prove the rolling default", async () => {
    const b = effortModelFixture();
    await expect(ensureModel(b, opts)).rejects.toThrow(
      /MODEL_UNVERIFIED:.*Latest/,
    );
    expect(
      b.mutations.some((a) => a[1] === MODEL_LATEST || a[1] === "ArrowRight"),
    ).toBe(false);
  });
  for (const family of ["GPT-7", "Unrecognized", null]) {
    test(`effort-only Pro cannot substitute for a requested full family: ${family}`, async () => {
      await expect(
        ensureModel(effortModelFixture({ family }), {
          ...opts,
          model: "6 Pro",
        }),
      ).rejects.toThrow(/MODEL_UNVERIFIED|expected model 6 Pro/);
    });
  }
  test("effort-only family drift while increasing Power is rejected", async () => {
    await expect(
      ensureModel(effortModelFixture({ value: 2, driftFamily: "GPT-7" }), {
        ...opts,
        model: "6 Pro",
      }),
    ).rejects.toThrow(/MODEL_UNVERIFIED|expected model 6 Pro/);
  });
  for (const verifyOnly of [false, true]) {
    test(`effort-only rejects a changed family after returning to unchanged Pro Power: verify-only=${verifyOnly}`, async () => {
      const b = effortModelFixture({ driftOnReopen: verifyOnly ? 2 : 3 });
      const verification = ensureModel(b, {
        ...opts,
        model: "6 Pro",
        ...(verifyOnly ? { "verify-only": "true" } : {}),
      });
      if (verifyOnly)
        await expect(verification).rejects.toThrow(
          /MODEL_UNVERIFIED|expected model 6 Pro/,
        );
      else {
        // A final inspection can avoid reopening Power altogether. If it
        // succeeds, the fixture's actual family must still match the result.
        let result;
        try {
          result = await verification;
        } catch (error) {
          expect(String(error)).toMatch(
            /MODEL_UNVERIFIED|expected model 6 Pro/,
          );
        }
        if (result) {
          expect(b.selectedFamily()).toBe("GPT-6");
          expect(result.observedModel).toBe("6 Pro");
        }
      }
      expect(
        b.mutations.filter(
          (a) => a[0] === "click" && [MODEL_LATEST, "#pro"].includes(a[1]!),
        ),
      ).toEqual([]);
      expect(
        b.mutations.some((a) => a[0] === "focus" || a[1] === "ArrowRight"),
      ).toBe(false);
    });
  }
  test("effort-only four-level UI reports only the disabled Pro's associated limit date", async () => {
    const b = effortModelFixture({
      max: 3,
      endpoint: "Extra High",
      proDisabled: true,
      hoverReason: "Limit reached. Try again after Oct 20, 2026.",
    });
    await expect(ensureModel(b, opts)).rejects.toThrow(
      "MODEL_UNAVAILABLE: Pro disabled; Limit reached. Try again after Oct 20, 2026.",
    );
    expect(b.mutations).toContainEqual(["hover", "#pro"]);
    expect(
      b.mutations.filter(
        (a) =>
          a[0] === "focus" ||
          a[0] === "fill" ||
          a[1] === "ArrowRight" ||
          (a[0] === "click" && a[1] === "#pro"),
      ),
    ).toEqual([]);
  });
  test("effort-only disabled Pro without a bound reason never guesses quota", async () => {
    const b = effortModelFixture({
      max: 3,
      endpoint: "Extra High",
      proDisabled: true,
    });
    let error: unknown;
    try {
      await ensureModel(b, opts);
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("MODEL_UNAVAILABLE: Pro disabled");
    expect(String(error)).not.toMatch(/limit reached|quota|Oct 20/i);
  });
  test("effort-only maximum Extra High without disabled reason reports unavailable Power", async () => {
    await expect(
      ensureModel(
        effortModelFixture({ max: 3, endpoint: "Extra High", latest: true }),
        opts,
      ),
    ).rejects.toThrow(/MODEL_UNAVAILABLE:.*Extra High/);
  });
  test("effort-only hover still rechecks the page binding before reading its reason", async () => {
    const b = effortModelFixture({ proDisabled: true, driftUrl: true });
    await expect(ensureModel(b, opts)).rejects.toThrow("URL changed");
  });
  test("effort-only verify-only refuses a lowered effort when the final family menu closes", async () => {
    await expect(
      ensureModel(effortModelFixture({ dropPowerOnFinalClose: true }), {
        ...opts,
        model: "6 Pro",
        "verify-only": "true",
      }),
    ).rejects.toThrow("MODEL_UNVERIFIED");
  });
  test("effort-only Latest disabled is never selected", async () => {
    const b = effortModelFixture({ latest: true, latestDisabled: true });
    await expect(ensureModel(b, opts)).rejects.toThrow(
      "Latest model option disabled",
    );
    expect(b.mutations.some((a) => a[1] === MODEL_LATEST)).toBe(false);
  });
  test("compact Pro resolves Latest and reads back the full identity for the final check", async () => {
    const b = fixture({ version: "5.6", effort: 4, compact: true });
    const selected = await ensureModel(b, opts);
    expect(selected).toMatchObject({
      before: "Pro",
      expectedModel: "latest-pro",
      observedModel: "6 Pro",
      evidence: { latest: true, power: 4, menuLabel: "6 Pro" },
    });
    expect(b.state().control).toMatchObject({ label: "Pro", expanded: false });
    b.mutations.length = 0;
    expect(
      await ensureModel(b, {
        ...opts,
        model: selected.observedModel,
        "verify-only": "true",
      }),
    ).toMatchObject({ observedModel: "6 Pro", changed: false });
    expect(b.mutations).toEqual([
      ["click", "#model"],
      ["press", "Escape"],
    ]);
  });
  test("a compact Pro label cannot hide a different full model identity", async () => {
    const b = fixture({
      version: "7",
      latestVersion: "7",
      effort: 4,
      compact: true,
    });
    await expect(
      ensureModel(b, { ...opts, model: "6 Pro", "verify-only": "true" }),
    ).rejects.toThrow("MODEL_UNVERIFIED");
    expect(b.mutations).toEqual([
      ["click", "#model"],
      ["press", "Escape"],
    ]);
    await expect(ensureModel(b, { ...opts, model: "6 Pro" })).rejects.toThrow(
      "expected model 6 Pro",
    );
  });
  test("Latest and maximum Power cannot certify a bare Pro menu identity", async () => {
    await expect(
      ensureModel(
        fixture({ version: "", latestVersion: "", effort: 4, compact: true }),
        opts,
      ),
    ).rejects.toThrow("Pro");
  });
  test("read-only confirmation requires a full identity even when the closed label is Pro", async () => {
    const b = fixture({ version: "", effort: 4 });
    await expect(
      ensureModel(b, { ...opts, model: "Pro", "verify-only": "true" }),
    ).rejects.toThrow("MODEL_UNVERIFIED");
    expect(b.mutations).toHaveLength(0);
  });
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
  test("an already selected Latest Pro is confirmed without selecting it again", async () => {
    const b = fixture({ version: "6", effort: 4 });
    expect(await ensureModel(b, opts)).toMatchObject({
      observedModel: "6 Pro",
      changed: false,
      evidence: { latest: true },
    });
    expect(b.mutations).toEqual([
      ["click", "#model"],
      ["click", MODEL_SELECT],
      ["click", MODEL_LATEST],
      ["press", "Escape"],
    ]);
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
