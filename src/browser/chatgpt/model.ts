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
  latest: { checked: boolean; disabled: boolean; selector?: string } | null;
  effortOnly?: boolean;
  modelOptions?: boolean;
  family?: string | null;
  pro?: { selector: string; disabled: boolean; description: string } | null;
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
  const menuScope = menu ? '[role="menu"][aria-labelledby=' + JSON.stringify(control.id) + ']' : null;
  const selector = e => {
    const path = [];
    for (let n = e; n && n !== menu; n = n.parentElement) {
      if (!n.parentElement) return null;
      path.unshift(':nth-child(' + (Array.from(n.parentElement.children).indexOf(n) + 1) + ')');
    }
    return menuScope + ' > ' + path.join(' > ');
  };
  const select = menu && Array.from(menu.querySelectorAll(${JSON.stringify(SELECT)})).find(visible);
  const power = menu && Array.from(menu.querySelectorAll(${JSON.stringify(POWER)})).find(visible);
  const slider = power?.querySelector('[role="slider"]');
  const radios = Array.from(menu?.querySelectorAll('[role="menuitemradio"]') || []).filter(visible);
  const defaults = radios.filter(e => ${JSON.stringify(LATEST_NAMES)}.includes(controlName(e)));
  const latest = defaults?.length === 1 ? defaults[0] : null;
  const selected = radios.filter(e => e.getAttribute('aria-checked') === 'true' && label(e) !== 'Pro');
  const pros = radios.filter(e => label(e) === 'Pro');
  const pro = pros.length === 1 ? pros[0] : null;
  const description = e => [e?.getAttribute('aria-description'), e?.getAttribute('title'),
    ...(e?.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean)
      .map(id => label(document.getElementById(id)))].filter(Boolean).join(' ').slice(0, 400);
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
    menuScope,
    effortOnly: !!select?.querySelector('[data-effort-only="true"]'),
    modelOptions: radios.length > 0,
    family: selected.length === 1 ? label(selected[0]) : null,
    pro: pro ? { selector: selector(pro), disabled: disabled(pro), description: description(pro) } : null,
    power: slider ? { value: numeric(slider, 'aria-valuenow'), min: numeric(slider, 'aria-valuemin'),
      max: numeric(slider, 'aria-valuemax'), disabled: disabled(power),
      focused: document.activeElement === power,
      description: (power.getAttribute('aria-describedby') || '').split(/\\s+/).map(id => label(document.getElementById(id))).join(' ') } : null,
    latest: latest ? { checked: latest.getAttribute('aria-checked') === 'true', disabled: disabled(latest), selector: selector(latest) } : null };
})()`;

const effortOnly = (state: ModelState) =>
  state.effortOnly ||
  /^(Light|Standard|High|Extra High|Pro)$/i.test(state.menuLabel || "");
// Normalize only the observed GPT-numeric family spelling. Unknown names remain
// unverified rather than treating an arbitrary Pro suffix as a model identity.
const familyIdentity = (family: string | null | undefined) => {
  const match = /^GPT-(\d+(?:\.\d+)?)( Sol)?$/.exec(family || "");
  return match ? `${match[1]}${match[2] || ""} Pro` : null;
};
const expectedIdentity = (value: string) =>
  value.replace(/^GPT-(?=\d+(?:\.\d+)?(?: Sol)? Pro$)/, "");
const proPower = (state: ModelState) =>
  !!state.power &&
  !state.power.disabled &&
  Number.isFinite(state.power.min) &&
  Number.isFinite(state.power.max) &&
  state.power.max > state.power.min &&
  state.power.value === state.power.max &&
  /^Pro\b/i.test(state.power.description) &&
  /^Pro$/i.test(state.menuLabel || "");

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
    if (
      args[0] === "hover" &&
      (!current.pro?.disabled || current.pro.selector !== args[1])
    )
      throw new Error("MODEL_UNVERIFIED: disabled Pro control changed");
    const fallback =
      args[1] === MODEL_LATEST ? current.latest?.selector || args[1] : args[1];
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
        fallback,
        url: current.url,
      });
      return;
    }
    await b.run(
      args[0]!,
      ...(args.length > 1 ? [fallback!, ...args.slice(2)] : []),
    );
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
  const inspectFamily = async (
    simple: ModelState,
    selectLatest: boolean,
    returnToPower = true,
  ) => {
    let current = simple;
    for (let attempt = 0; attempt < 2; attempt++) {
      await act("click", SELECT);
      current = await wait(
        (s) => s.modelOptions === true,
        "MODEL_UNVERIFIED: Pro model family menu unavailable",
      );
      if (current.pro?.disabled) {
        const selector = current.pro.selector;
        if (!current.pro.description && selector) {
          await act("hover", selector);
          for (let n = 0; n < 12; n++) {
            current = await read();
            if (!current.pro?.disabled || current.pro.selector !== selector)
              throw new Error("MODEL_UNVERIFIED: disabled Pro control changed");
            if (current.pro.description) break;
            await Bun.sleep(100);
          }
        }
        throw new Error(
          `MODEL_UNAVAILABLE: Pro disabled; ${current.pro!.description || "associated reason unavailable"}`,
        );
      }
      if (selectLatest) {
        if (!current.latest)
          throw new Error(
            "MODEL_UNVERIFIED: Latest identity unavailable; no rolling-default evidence",
          );
        if (current.latest.disabled)
          throw new Error("Latest model option disabled");
        if (!current.latest.checked) {
          if (attempt) throw new Error("Latest selection did not persist");
          await act("click", MODEL_LATEST);
          current = await wait(
            (s) => !!s.power && s.menuLabel !== null,
            "Power menu unavailable after Latest selection",
          );
          continue;
        }
      }
      const family = current.family;
      if (!familyIdentity(family))
        throw new Error(
          "MODEL_UNVERIFIED: selected model family unavailable or ambiguous",
        );
      const latest = !!current.latest?.checked && !current.latest.disabled;
      if (!returnToPower)
        return {
          state: current,
          family: family!,
          latest,
          changed: attempt > 0,
        };
      // Reopening the bound trigger returns to its simple view. Never select a
      // different family merely to get back to Power, including verify-only.
      await act("press", "Escape");
      current = await wait(
        (s) => !s.control!.expanded,
        "Model family menu did not close",
      );
      await act("click", current.control!.selector);
      current = await wait(
        (s) => !!s.power && s.menuLabel !== null,
        "Power menu unavailable after family verification",
      );
      return { state: current, family: family!, latest, changed: attempt > 0 };
    }
    throw new Error("Latest selection did not persist");
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
    if (
      !expectedModel ||
      /^(Light|Standard|High|Extra High|Pro)$/i.test(expectedModel)
    )
      throw new Error("MODEL_UNVERIFIED: exact observed model required");
    // The redesigned closed trigger shows effort only (e.g. Pro). Inspect its
    // bound menu for the full model identity without selecting a different model.
    if (state.control!.compact && !state.control!.expanded) {
      await act("click", state.control!.selector);
      state = await wait(
        (s) => s.menuLabel !== null && !!s.power,
        "Model verification menu unavailable",
      );
      if (effortOnly(state)) {
        const inspected = await inspectFamily(state, false);
        state = inspected.state;
        const observedModel = familyIdentity(inspected.family)!;
        const available = proPower(state);
        const evidence = {
          family: inspected.family,
          power: state.power!.value,
          maximum: state.power!.max,
          description: state.power!.description,
          latest: false,
        };
        // Power belongs to the simple view. Read the family again afterwards
        // and close from that final view; reopening Power could change family.
        const confirmed = await inspectFamily(state, false, false);
        state = confirmed.state;
        await act("press", "Escape");
        state = await wait(
          (s) => !s.control!.expanded,
          "Model verification menu did not close",
        );
        if (
          confirmed.family !== inspected.family ||
          observedModel !== expectedIdentity(expectedModel)
        )
          throw new Error(
            "MODEL_UNVERIFIED: select the configured model in this tab",
          );
        if (!available)
          throw new Error(
            `MODEL_UNAVAILABLE: Pro power unavailable; ${evidence.description}`,
          );
        if (
          state.control!.label !== "Pro" &&
          state.control!.label !== observedModel
        )
          throw new Error("MODEL_UNVERIFIED: Pro Power did not persist");
        return {
          verified: true,
          expectedModel,
          observedModel,
          before,
          changed: false,
          url: state.url,
          target: required(opts, "target"),
          session: b.session,
          verifiedAt: new Date().toISOString(),
          evidence,
        };
      }
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
  let family: string | null = null;
  if (effortOnly(state)) {
    const inspected = await inspectFamily(state, !expectedModel);
    state = inspected.state;
    family = inspected.family;
    latestVerified = !expectedModel && inspected.latest;
    changed = inspected.changed;
    if (
      expectedModel &&
      familyIdentity(family) !== expectedIdentity(expectedModel)
    )
      throw new Error(
        `Pro selection did not match expected model ${expectedModel}`,
      );
  } else if (!expectedModel || state.menuLabel !== expectedModel) {
    await act("click", SELECT);
    state = await wait((s) => !!s.latest, "Latest model option unavailable");
    if (state.latest!.disabled) throw new Error("Latest model option disabled");
    changed = !state.latest!.checked;
    if (changed) {
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
    }
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
      throw new Error(
        "MODEL_UNAVAILABLE: Pro power control unavailable or changed",
      );
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
    !state.power ||
    state.power.disabled ||
    state.power.min !== min ||
    state.power.max !== max ||
    state.power.value !== max ||
    !/^Pro\b/i.test(state.power.description) ||
    (family && !proPower(state))
  )
    throw new Error(
      `MODEL_UNAVAILABLE: Pro power unavailable; ${state.power?.description || "associated reason unavailable"}`,
    );
  const selectedPower = state.power!;
  const selectedMenuLabel = state.menuLabel;
  if (family) {
    const inspected = await inspectFamily(state, false, false);
    state = inspected.state;
    if (inspected.family !== family)
      throw new Error(
        "MODEL_UNVERIFIED: model family changed after Power verification",
      );
    if (latestVerified && !inspected.latest)
      throw new Error("MODEL_UNVERIFIED: Latest selection did not persist");
  }
  const selectedModel = family ? familyIdentity(family)! : selectedMenuLabel;
  if (
    !selectedModel ||
    /^Pro$/i.test(selectedModel) ||
    !/\bPro$/i.test(selectedModel) ||
    (expectedModel &&
      selectedModel !==
        (family ? expectedIdentity(expectedModel) : expectedModel))
  )
    throw new Error(
      `Pro selection did not match expected model ${expectedModel || "Latest Pro"}`,
    );
  const evidence = {
    menuLabel: selectedMenuLabel,
    power: selectedPower.value,
    maximum: selectedPower.max,
    latest: latestVerified,
    description: selectedPower.description,
    ...(family ? { family } : {}),
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
