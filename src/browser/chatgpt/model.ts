import { COMPOSER_DOM, CONTROL_NAME_DOM } from "./dom.ts";
import type { RunControl } from "../semantic.ts";
// Adapted from MarioJames/skill-foundry 19f0122 (Apache-2.0); modified for standalone use.
import { required } from "../../command.ts";
import {
  MODEL_SELECT,
  MODEL_POWER,
  MODEL_LATEST,
  MODEL_PICKER,
  STOP_SELECTOR,
  STOP_NAMES,
  MODEL_NAMES,
  LATEST_NAMES,
} from "./controls.ts";

interface Control {
  selector: string;
  label: string;
  disabled: boolean;
  expanded: boolean;
  compact?: boolean;
}
interface Power {
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  description: string;
  focused: boolean;
}
export interface ModelState {
  url: string;
  blocked: string | null;
  generating: boolean;
  hasComposer: boolean;
  control: Control | null;
  menuLabel: string | null;
  menuScope?: string | null;
  power: Power | null;
  latest: { checked: boolean; disabled: boolean } | null;
}
interface Browser {
  runControl?: RunControl;
  session: string;
  run: (...args: string[]) => Promise<any>;
}
const POWER = MODEL_POWER;
const SELECT = MODEL_SELECT;

// Read only UI state. Never expose prompts, account data, tokens or request headers.
export const MODEL_SCRIPT = `(() => {
  const visible = e => !!e && e.getClientRects().length > 0
    && !e.closest('[aria-hidden="true"], [inert]') && getComputedStyle(e).visibility !== 'hidden';
  const label = e => (e?.innerText || '').replace(/\\s+/g, ' ').trim();
  const disabled = e => !!e && (e.disabled || e.getAttribute('aria-disabled') === 'true'
    || !!e.querySelector('[aria-disabled="true"], [data-locked="true"]'));
  const numeric = (e, key) => {
    const value = e.getAttribute(key);
    return value === null || value.trim() === '' ? null : Number(value);
  };
  ${COMPOSER_DOM}
  ${CONTROL_NAME_DOM}
  const form = composer?.closest('form');
  const controls = Array.from(form?.querySelectorAll('button[aria-haspopup="menu"]') || [])
    .filter(e => visible(e) && e.getAttribute('data-testid') !== 'composer-plus-btn' && e.getAttribute('data-composer-navigation-target') !== 'add-context');
  const control = controls.length === 1 && controls[0].id ? controls[0] : null;
  const menus = Array.from(document.querySelectorAll('[role="menu"]'))
    .filter(e => visible(e) && control && e.getAttribute('aria-labelledby') === control.id);
  const menu = menus.length === 1 ? menus[0] : null;
  const select = menu && Array.from(menu.querySelectorAll(${JSON.stringify(SELECT)})).find(visible);
  const power = menu && Array.from(menu.querySelectorAll(${JSON.stringify(POWER)})).find(visible);
  const slider = power?.querySelector('[role="slider"]');
  const defaults = menu && Array.from(menu.querySelectorAll(${JSON.stringify(MODEL_LATEST)})).filter(visible);
  const latest = defaults?.length === 1 ? defaults[0] : null;
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const buttonLabel = e => e.getAttribute('aria-label') || label(e);
  const login = location.hostname === 'auth.openai.com' || buttons.some(e => /^(Log in|登录)$/.test(buttonLabel(e)));
  const challenge = /^(Just a moment|Security Verification)/i.test(document.title)
    || Array.from(document.querySelectorAll('iframe')).some(e => /cloudflare security challenge/i.test(e.title));
  return { url: location.href, blocked: challenge ? 'Human verification required' : login ? 'Login required' : null,
    generating: buttons.some(e => e.matches(${JSON.stringify(STOP_SELECTOR)}) || (form?.contains(e) && ${JSON.stringify(STOP_NAMES)}.includes(controlName(e)))),
    hasComposer: visible(composer),
    control: control ? { selector: '#' + CSS.escape(control.id), label: label(control),
      disabled: disabled(control), compact: control.hasAttribute('data-codex-intelligence-trigger'), expanded: control.getAttribute('aria-expanded') === 'true' } : null,
    menuLabel: select ? label(select) : null,
    menuScope: menu ? '[role="menu"][aria-labelledby=' + JSON.stringify(control.id) + ']' : null,
    power: slider ? { value: numeric(slider, 'aria-valuenow'), min: numeric(slider, 'aria-valuemin'),
      max: numeric(slider, 'aria-valuemax'), disabled: disabled(power),
      focused: document.activeElement === power,
      description: (power.getAttribute('aria-describedby') || '').split(/\\s+/).map(id => label(document.getElementById(id))).join(' ') } : null,
    latest: latest ? { checked: latest.getAttribute('aria-checked') === 'true', disabled: disabled(latest) } : null };
})()`;

export function modelUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password)
    throw new Error("Expected a ChatGPT URL");
  url.hash = "";
  return url.href;
}

export async function ensureModel(b: Browser, opts: Record<string, string>) {
  const expectedUrl = modelUrl(required(opts, "url"));
  const expectedModel = opts.model?.trim() || undefined;
  const read = async (loading = false): Promise<ModelState> => {
    const state: ModelState = (await b.run("eval", MODEL_SCRIPT)).result;
    if (!state || typeof state.url !== "string")
      throw new Error("Unrecognized model UI response");
    if (modelUrl(state.url) !== expectedUrl)
      throw new Error("Page URL changed; refusing model interaction");
    if (state.blocked) throw new Error(state.blocked);
    if (state.generating)
      throw new Error("Response is generating; refusing model interaction");
    if (
      !loading &&
      (!state.hasComposer || !state.control || state.control.disabled)
    )
      throw new Error("Model control unavailable or ambiguous");
    return state;
  };
  // Recheck the bound page before every action, including keyboard actions.
  const act = async (...args: string[]) => {
    const current = await read();
    if (b.runControl && (args[0] === "click" || args[0] === "focus")) {
      const trigger = args[1] === current.control!.selector;
      const names = trigger
        ? MODEL_NAMES
        : args[1] === MODEL_LATEST
          ? LATEST_NAMES
          : args[1] === SELECT
            ? [
                ...MODEL_NAMES,
                ...(current.menuLabel ? [current.menuLabel] : []),
              ]
            : ["Power", "能力", "Puissance"];
      await b.runControl(args[0], {
        scope: trigger ? "main form" : current.menuScope || MODEL_PICKER,
        role: trigger
          ? "button"
          : args[1] === MODEL_LATEST
            ? "menuitemradio"
            : "menuitem",
        names,
        fallback: args[1],
        url: current.url,
      });
      return;
    }
    await b.run(...args);
  };
  const wait = async (
    accept: (state: ModelState) => boolean,
    reason: string,
  ) => {
    for (let i = 0; i < 12; i++) {
      const state = await read();
      if (accept(state)) return state;
      await Bun.sleep(100);
    }
    throw new Error(reason);
  };
  let state = await read(true);
  for (
    let n = 0;
    (!state.hasComposer || !state.control || state.control.disabled) && n < 20;
    n++
  ) {
    await Bun.sleep(250);
    state = await read(true);
  }
  if (!state.hasComposer || !state.control || state.control.disabled)
    throw new Error("Model control unavailable or ambiguous");
  const before = state.control!.label;
  if (
    opts["verify-only"] === "true" ||
    (expectedModel && !/\bPro$/i.test(expectedModel))
  ) {
    if (!expectedModel)
      throw new Error("MODEL_UNVERIFIED: exact observed model required");
    // The redesigned closed trigger shows effort only (e.g. Pro). Inspect its
    // bound menu for the full model identity without selecting a different model.
    if (state.control!.compact && !state.control!.expanded) {
      await act("click", state.control!.selector);
      state = await wait(
        (s) => s.menuLabel !== null && !!s.power,
        "Model verification menu unavailable",
      );
      const matches =
        state.menuLabel === expectedModel &&
        (!/\bPro$/i.test(expectedModel) ||
          (!!state.power &&
            !state.power.disabled &&
            Number.isFinite(state.power.max) &&
            state.power.max > state.power.min &&
            state.power.value === state.power.max &&
            /\bPro\b/i.test(state.power.description)));
      await act("press", "Escape");
      state = await wait(
        (s) => !s.control!.expanded,
        "Model verification menu did not close",
      );
      if (!matches)
        throw new Error(
          "MODEL_UNVERIFIED: select the configured model in this tab",
        );
      return {
        verified: true,
        expectedModel,
        observedModel: expectedModel,
        before,
        changed: false,
        url: state.url,
        target: required(opts, "target"),
        session: b.session,
        verifiedAt: new Date().toISOString(),
      };
    }
    if (state.control!.expanded || before !== expectedModel)
      throw new Error(
        "MODEL_UNVERIFIED: select the configured model in this tab",
      );
    const confirmed = await read();
    if (
      confirmed.control!.expanded ||
      confirmed.control!.label !== expectedModel
    )
      throw new Error("MODEL_UNVERIFIED: configured model did not persist");
    return {
      verified: true,
      expectedModel,
      observedModel: expectedModel,
      before,
      changed: false,
      url: confirmed.url,
      target: required(opts, "target"),
      session: b.session,
      verifiedAt: new Date().toISOString(),
    };
  }
  let changed = false;
  if (state.control!.expanded) {
    await act("press", "Escape");
    state = await wait((s) => !s.control!.expanded, "Model menu did not close");
  }
  await act("click", state.control!.selector);
  state = await wait(
    (s) => !!s.power && s.menuLabel !== null,
    "Power menu unavailable",
  );
  let latestVerified = false;
  if (!expectedModel || state.menuLabel !== expectedModel) {
    await act("click", SELECT);
    state = await wait((s) => !!s.latest, "Latest model option unavailable");
    if (state.latest!.disabled) throw new Error("Latest model option disabled");
    changed = !state.latest!.checked;
    await act("click", MODEL_LATEST);
    state = await wait(
      (s) => !!s.power && s.menuLabel !== null,
      "Power menu unavailable after model selection",
    );
    // Verify the model family, even when an older Pro has an identical effort label.
    await act("click", SELECT);
    state = await wait((s) => !!s.latest, "Latest model option unavailable");
    if (!state.latest!.checked || state.latest!.disabled)
      throw new Error("Latest selection did not persist");
    latestVerified = true;
    await act("click", MODEL_LATEST);
    state = await wait(
      (s) => !!s.power && s.menuLabel !== null,
      "Power menu unavailable after Latest verification",
    );
  }
  const min = state.power?.min,
    max = state.power?.max;
  for (let step = 0; step < 32; step++) {
    const power = state.power;
    if (
      !power ||
      power.disabled ||
      !Number.isFinite(power.min) ||
      !Number.isFinite(power.max) ||
      power.min !== min ||
      power.max !== max ||
      power.max <= power.min ||
      !Number.isFinite(power.value) ||
      power.value < power.min ||
      power.value > power.max
    )
      throw new Error("Pro power control unavailable or changed");
    if (power.value === power.max) break;
    await act("focus", POWER);
    state = await read();
    if (!state.power?.focused)
      throw new Error("Power control did not receive keyboard focus");
    const previous = state.power.value;
    await act("press", "ArrowRight");
    changed = true;
    state = await wait(
      (s) => !!s.power && s.power.value > previous,
      "Power selection did not advance",
    );
  }
  if (
    (expectedModel && state.menuLabel !== expectedModel) ||
    !state.menuLabel ||
    !/\bPro$/i.test(state.menuLabel) ||
    !state.power ||
    state.power.disabled ||
    state.power.min !== min ||
    state.power.max !== max ||
    state.power.value !== max ||
    !/\bPro\b/i.test(state.power.description)
  )
    throw new Error(
      `Pro selection did not match expected model ${expectedModel || "Latest Pro"}`,
    );
  const selectedModel = state.menuLabel;
  const evidence = {
    menuLabel: state.menuLabel,
    power: state.power.value,
    maximum: state.power.max,
    latest: latestVerified,
    description: state.power.description,
  };
  const confirmedLabel = (s: ModelState) =>
    s.control!.label === selectedModel ||
    (s.control!.compact === true && s.control!.label === "Pro");
  await act("press", "Escape");
  state = await wait(
    (s) => !s.control!.expanded && confirmedLabel(s),
    "Closed model control did not confirm selected Pro",
  );
  // A second read prevents a transient label from being treated as final confirmation.
  state = await read();
  if (state.control!.expanded || !confirmedLabel(state))
    throw new Error("Model selection did not persist");
  return {
    verified: true,
    expectedModel: expectedModel || "latest-pro",
    observedModel: selectedModel,
    before,
    changed,
    url: state.url,
    target: required(opts, "target"),
    session: b.session,
    verifiedAt: new Date().toISOString(),
    evidence,
  };
}
