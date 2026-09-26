import { expect, test } from "bun:test";
import { controlRef } from "../../src/browser/semantic.ts";

test("scoped semantic lookup excludes refs from the rest of the page and deduplicates repeated tree entries", () => {
  const snapshot = {
    origin: "https://chatgpt.com/c/one",
    snapshot: '- button "Send" [ref=e2]\n- button "Send" [ref=e2]',
    refs: {
      e1: { role: "button", name: "Send" },
      e2: { role: "button", name: "Send" },
    },
  };
  const target = {
    scope: "main form",
    role: "button",
    names: ["Send"],
    url: snapshot.origin,
    fallback: "#old-send",
  };
  expect(controlRef(snapshot, target)).toBe("@e2");
  expect(() =>
    controlRef(
      {
        ...snapshot,
        snapshot: '- button "Send" [ref=e1]\n- button "Send" [ref=e2]',
      },
      target,
    ),
  ).toThrow("CONTROL_AMBIGUOUS");
  expect(() =>
    controlRef({ ...snapshot, origin: "https://chatgpt.com/c/other" }, target),
  ).toThrow("CONTROL_PAGE_CHANGED");
  expect(controlRef({ ...snapshot, snapshot: "" }, target)).toBe("#old-send");
  expect(() => controlRef({}, target)).toThrow("CONTROL_SNAPSHOT_UNRECOGNIZED");
  expect(() =>
    controlRef({ ...snapshot, snapshot: "" }, { ...target, fallback: null }),
  ).toThrow("CONTROL_NOT_FOUND");
});
