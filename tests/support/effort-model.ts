import {
  MODEL_LATEST,
  MODEL_POWER,
  MODEL_SELECT,
} from "../../src/browser/chatgpt/controls.ts";
import type { ModelState } from "../../src/browser/chatgpt/model.ts";

// External UI states based on live-model-dom-contract.json. No production model
// selection or identity logic is substituted by this fixture.
export function effortModelFixture(
  initial: {
    family?: string | null;
    latest?: boolean;
    latestDisabled?: boolean;
    latestChecked?: boolean;
    ignoreLatest?: boolean;
    proDisabled?: boolean;
    reason?: string;
    hoverReason?: string;
    max?: number;
    value?: number;
    endpoint?: string;
    driftFamily?: string;
    driftOnReopen?: number;
    dropPowerOnFinalClose?: boolean;
    driftUrl?: boolean;
  } = {},
) {
  let expanded = false,
    advanced = false,
    focused = false,
    hovered = false;
  let family = initial.family === undefined ? "GPT-6" : initial.family;
  let value = initial.value ?? initial.max ?? 4;
  const max = initial.max ?? 4;
  let latestChecked = initial.latestChecked ?? true;
  let url = "https://chatgpt.com/";
  let opens = 0;
  let closes = 0;
  const mutations: string[][] = [];
  const effort = () => (value === max ? (initial.endpoint ?? "Pro") : "High");
  const state = (): ModelState => ({
    url,
    blocked: null,
    generating: false,
    hasComposer: true,
    control: {
      selector: "#model",
      label: effort(),
      disabled: false,
      expanded,
      compact: true,
    },
    menuLabel: expanded && !advanced ? effort() : null,
    menuScope: '[role="menu"][aria-labelledby="model"]',
    effortOnly: true,
    modelOptions: expanded && advanced,
    family: expanded && advanced ? family : null,
    pro:
      expanded && advanced
        ? {
            selector: "#pro",
            disabled: initial.proDisabled ?? false,
            description:
              (hovered ? initial.hoverReason : undefined) ??
              initial.reason ??
              "",
          }
        : null,
    latest:
      expanded && advanced && initial.latest
        ? {
            checked: latestChecked,
            disabled: initial.latestDisabled ?? false,
          }
        : null,
    power:
      expanded && !advanced
        ? {
            min: 0,
            max,
            value,
            disabled: false,
            focused,
            description: `${effort()}, ${value + 1} of ${max + 1}. Use Left and Right arrow keys to adjust power`,
          }
        : null,
  });
  return {
    session: "effort-only-fixture",
    mutations,
    state,
    selectedFamily: () => family,
    run: async (...args: string[]) => {
      if (args[0] === "eval") return { result: state() };
      mutations.push(args);
      if (args[0] === "click" && args[1] === "#model") {
        expanded = true;
        advanced = false;
        if (++opens >= (initial.driftOnReopen ?? Infinity)) family = "GPT-7";
      } else if (args[0] === "click" && args[1] === MODEL_SELECT)
        advanced = true;
      else if (args[0] === "click" && args[1] === MODEL_LATEST) {
        if (initial.latestDisabled)
          throw new Error("Disabled Latest was clicked");
        if (!initial.ignoreLatest) {
          latestChecked = true;
          family = "GPT-6";
        }
        advanced = false;
      } else if (args[0] === "hover" && args[1] === "#pro") {
        hovered = true;
        if (initial.driftUrl) url = "https://chatgpt.com/c/unrelated";
      } else if (args[0] === "focus" && args[1] === MODEL_POWER) focused = true;
      else if (args[0] === "press" && args[1] === "ArrowRight") {
        if (!focused) throw new Error("Power not focused");
        value = Math.min(max, value + 1);
        if (initial.driftFamily) family = initial.driftFamily;
      } else if (args[0] === "press" && args[1] === "Escape") {
        expanded = advanced = focused = false;
        if (++closes > 1 && initial.dropPowerOnFinalClose) value = max - 1;
      } else throw new Error("Unexpected UI action: " + args.join(" "));
      return {};
    },
  };
}
