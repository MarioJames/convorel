import { expect, test } from "bun:test";
import { MODEL_SCRIPT } from "../../src/browser/chatgpt/model.ts";
import {
  COMPOSER_SELECTOR,
  MODEL_LATEST,
  MODEL_POWER,
  MODEL_SELECT,
} from "../../src/browser/chatgpt/controls.ts";

// Minimal external DOM surface for MODEL_SCRIPT, based on the captured public
// attributes. This exercises extraction, not a browser or actual Pro recovery.
function domFixture() {
  const element = (text: string, attrs: Record<string, string> = {}) => {
    const queries = new Map<string, any[]>();
    const e: any = {
      innerText: text,
      textContent: text,
      id: attrs.id || "",
      parentElement: null,
      children: [],
      visible: true,
      getAttribute: (key: string) => attrs[key] ?? null,
      hasAttribute: (key: string) => key in attrs,
      setAttribute: (key: string, value: string) => {
        attrs[key] = value;
      },
      getClientRects: () => (e.visible ? [{}] : []),
      closest: () => null,
      contains: (child: any) => e.children.includes(child),
      matches: () => false,
      querySelectorAll: (selector: string) => queries.get(selector) || [],
      querySelector: (selector: string) => queries.get(selector)?.[0] || null,
      queries,
    };
    return e;
  };
  const form = element(""),
    composer = element("");
  composer.closest = (selector: string) => (selector === "form" ? form : null);
  const trigger = element("Extra High", {
    id: "model",
    "aria-haspopup": "menu",
    "aria-expanded": "true",
    "data-codex-intelligence-trigger": "true",
  });
  form.queries.set('button[aria-haspopup="menu"]', [trigger]);
  const menu = element("", { "aria-labelledby": "model" });
  const header = element("", {
    "data-explicit-model": "false",
    "data-effort-header": "true",
  });
  const select = element("Extra High", { "aria-label": "Select model" });
  select.queries.set('[data-effort-only="true"]', [element("Extra High")]);
  const power = element("", { "aria-describedby": "power-status power-help" });
  const slider = element("", {
    role: "slider",
    "aria-hidden": "true",
    "aria-valuemin": "0",
    "aria-valuemax": "3",
    "aria-valuenow": "3",
  });
  power.queries.set('[role="slider"]', [slider]);
  const family = element("GPT-6", { "aria-checked": "true" });
  const older = element("GPT-5.6 Sol", { "aria-checked": "false" });
  const pro = element("Pro", {
    "aria-checked": "false",
    "aria-disabled": "true",
  });
  const showAdvanced = (advanced = true) => {
    select.visible = power.visible = !advanced;
    family.visible = older.visible = pro.visible = advanced;
  };
  showAdvanced(false);
  menu.children = [select, power, family, older, pro];
  for (const child of menu.children) child.parentElement = menu;
  menu.queries.set(MODEL_SELECT, [select]);
  menu.queries.set(MODEL_POWER, [power]);
  menu.queries.set(MODEL_LATEST, [family]); // Old positional locator would misidentify this as Latest.
  menu.queries.set('[role="menuitemradio"]', [family, older, pro]);
  menu.queries.set("[data-explicit-model]", [header]);
  const ids = new Map<string, any>([
    ["power-status", element("Extra High, 4 of 4.")],
    ["power-help", element("Use Left and Right arrow keys to adjust power")],
    [
      "pro-tooltip",
      element("Limit reached. Try again after Oct 20, 2026.", {
        role: "tooltip",
      }),
    ],
  ]);
  const unrelated = element("", { "aria-labelledby": "other" });
  const document = {
    title: "ChatGPT",
    activeElement: null,
    getElementById: (id: string) => ids.get(id) || null,
    querySelectorAll: (selector: string) =>
      selector === COMPOSER_SELECTOR
        ? [composer]
        : selector === '[role="menu"]'
          ? [unrelated, menu]
          : selector === "button"
            ? [trigger]
            : [],
  };
  const read = () =>
    new Function(
      "document",
      "location",
      "getComputedStyle",
      "CSS",
      `return ${MODEL_SCRIPT}`,
    )(
      document,
      { href: "https://chatgpt.com/", hostname: "chatgpt.com" },
      () => ({ visibility: "visible" }),
      { escape: (s: string) => s },
    );
  return { read, showAdvanced, pro, family, older, menu, header, document };
}

test("model DOM binds family and hidden slider to the composer menu without assuming first means Latest", () => {
  const f = domFixture();
  expect(f.read()).toMatchObject({
    family: null,
    latest: null,
    effortOnly: true,
    power: {
      value: 3,
      min: 0,
      max: 3,
      description:
        "Extra High, 4 of 4. Use Left and Right arrow keys to adjust power",
    },
  });
  f.showAdvanced();
  expect(f.read()).toMatchObject({
    family: "GPT-6",
    power: null,
    latest: null,
    pro: { disabled: true, description: "" },
  });
  f.family.setAttribute("aria-label", "Latest");
  expect(f.read().latest).toMatchObject({ checked: true, disabled: false });
  f.older.setAttribute("aria-checked", "true");
  expect(f.read().family).toBeNull();
});

test("model DOM reads limit text only after disabled Pro explicitly references its tooltip", () => {
  const f = domFixture();
  f.showAdvanced();
  expect(f.read().pro.description).toBe("");
  f.pro.setAttribute("aria-describedby", "missing-tooltip");
  expect(f.read().pro.description).toBe("");
  f.pro.setAttribute("aria-describedby", "pro-tooltip");
  expect(f.read().pro).toMatchObject({
    description: "Limit reached. Try again after Oct 20, 2026.",
    selector: '[role="menu"][aria-labelledby="model"] > :nth-child(5)',
  });
});

test("model DOM reports the unpinned rolling default of the 2026-10-20 menu without a Latest option", () => {
  const f = domFixture();
  f.showAdvanced();
  expect(f.read()).toMatchObject({
    explicitModel: false,
    family: "GPT-6",
    latest: null,
    modelOptions: true,
  });
  f.showAdvanced(false);
  expect(f.read()).toMatchObject({ explicitModel: false, effortOnly: true });
});

test("model DOM never reports an unpinned model unless every marker says so", () => {
  const f = domFixture();
  f.header.setAttribute("data-explicit-model", "true");
  expect(f.read().explicitModel).toBe(true);
  f.header.setAttribute("data-explicit-model", "maybe");
  expect(f.read().explicitModel).toBeNull();
  f.menu.queries.delete("[data-explicit-model]");
  expect(f.read().explicitModel).toBeNull();
});
