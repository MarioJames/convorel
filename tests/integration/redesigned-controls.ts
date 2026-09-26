import { strict as assert } from "node:assert";
import { Browser, clearDraft, sendPrompt } from "../../src/browser/browser.ts";
import { ensureModel, MODEL_SCRIPT } from "../../src/browser/chatgpt/model.ts";
import { organizationUiScript } from "../../src/browser/chatgpt/organize.ts";
import { copyMarkdownScript } from "../../src/browser/chatgpt/copy.ts";
import { projectComposerScript } from "../../src/browser/chatgpt/project.ts";
import { COMPOSER_SELECTOR } from "../../src/browser/chatgpt/controls.ts";

export async function redesignedControls(browser: Browser) {
  const tab = await browser.tabs(
    "new",
    new URL("../fixtures/redesigned-chat.html", import.meta.url).href,
  );
  try {
    const page = await browser.page(tab.targetId);
    await page.run(
      "eval",
      `document.querySelector('#send').setAttribute('aria-label','Send'); document.querySelector('#send path').remove(); document.querySelector('#answer-copy').setAttribute('aria-label','Copy'); document.querySelector('#answer-copy path').remove(); const other=document.createElement('button'); other.textContent='Send'; other.onclick=()=>window.wrongSend=true; document.body.append(other)`,
    );
    const observed = await page.read();
    assert.equal(observed.hasComposer, true);
    assert.equal(observed.draft?.trim(), "");
    assert.deepEqual(
      observed.messages.map((m) => [m.id, m.role, m.final]),
      [
        ["u1", "user", false],
        ["reasoning", "assistant", false],
        ["a1", "assistant", true],
      ],
    );
    assert.equal(
      (await page.run("eval", projectComposerScript())).result.messageCount,
      3,
    );
    const copy = (await page.run("eval", copyMarkdownScript("a1"))).result;
    assert.equal(copy.text, "**Stable reply**");
    assert.equal(
      (await page.run("eval", copyMarkdownScript("u1"))).result.ok,
      false,
    );
    await page.run("eval", "document.querySelector('#answer-copy').remove()");
    assert.equal(
      (await page.read()).messages.at(-1)?.final,
      false,
      "user/code Copy cannot complete a response",
    );
    assert.equal(
      (await page.run("eval", copyMarkdownScript("a1"))).result.reason,
      "COPY_BUTTON_MISSING",
    );

    await page.runControl(
      "fill",
      { scope: "main form", role: "textbox", fallback: COMPOSER_SELECTOR },
      "Line one\nLine two",
    );
    const draft = await page.read();
    assert.equal(draft.draft, "Line one\nLine two");
    await clearDraft(page, draft);
    assert.equal((await page.read()).draft?.trim(), "");
    await sendPrompt(page, await page.read(), async () => {});
    assert.equal((await page.run("eval", "window.sends")).result, 1);
    assert.notEqual((await page.run("eval", "window.wrongSend")).result, true);
    await page.run(
      "eval",
      `document.querySelector('#send').type='button'; document.querySelector('#send').setAttribute('aria-label','Stop')`,
    );
    assert.equal((await page.read()).generating, true);
    assert.equal((await page.read()).sendReady, false);
    assert.equal(
      (await page.run("eval", MODEL_SCRIPT)).result.generating,
      true,
    );
    await page.run(
      "eval",
      `document.querySelector('#send').type='submit'; document.querySelector('#send').setAttribute('aria-label','Send')`,
    );

    // Only the external location is substituted; real DOM reads and UI actions run.
    const modelPage = {
      session: page.session,
      runControl: (
        action: Parameters<typeof page.runControl>[0],
        target: Parameters<typeof page.runControl>[1],
        value?: string,
        beforeDispatch?: () => Promise<void>,
      ) =>
        page.runControl(
          action,
          { ...target, url: observed.url },
          value,
          beforeDispatch,
        ),
      run: async (...args: string[]) => {
        const result = await page.run(...args);
        if (args[0] === "eval" && args[1] === MODEL_SCRIPT)
          result.result.url = "https://chatgpt.com/c/redesigned";
        return result;
      },
    };
    const opts = {
      url: "https://chatgpt.com/c/redesigned",
      target: tab.targetId,
    };
    assert.equal((await ensureModel(modelPage, opts)).observedModel, "6 Pro");
    // Executes the actual nested pacing path used immediately before Send.
    await sendPrompt(page, await page.read(), async () => {
      assert.equal(
        (
          await ensureModel(modelPage, {
            ...opts,
            model: "6 Pro",
            "verify-only": "true",
          })
        ).observedModel,
        "6 Pro",
      );
    });
    await page.run(
      "eval",
      "document.querySelector('#select').textContent='5.6 Pro'",
    );
    await assert.rejects(
      ensureModel(modelPage, {
        ...opts,
        model: "6 Pro",
        "verify-only": "true",
      }),
      /MODEL_UNVERIFIED/,
    );
    assert.equal(
      (await page.run("eval", MODEL_SCRIPT)).result.control.expanded,
      false,
    );

    let ui = (await page.run("eval", organizationUiScript("redesigned")))
      .result;
    assert.equal(ui.options, "#chat-actions");
    await page.run("click", ui.options);
    await page.run(
      "eval",
      "document.querySelector('#rename [style]').removeAttribute('style')",
    );
    ui = (await page.run("eval", organizationUiScript("redesigned"))).result;
    assert.equal(ui.rename, null);
    assert.equal(ui.renameName, "Rename");
    await page.runControl("click", {
      scope: ui.menu,
      role: "menuitem",
      names: ["Rename"],
    });
    ui = (await page.run("eval", organizationUiScript("redesigned"))).result;
    assert.ok(ui.titleInput);
    await page.runControl(
      "fill",
      { scope: '[role="dialog"] form', role: "textbox" },
      "0926｜FIX｜页面验证",
    );
    await page.run("press", "Enter");
    assert.equal(
      (
        await page.run(
          "eval",
          "document.querySelector('[data-thread-title]').textContent",
        )
      ).result,
      "0926｜FIX｜页面验证",
    );
    assert.equal(
      (await page.run("eval", organizationUiScript("missing"))).result.options,
      null,
    );
    assert.deepEqual((await page.run("errors")).errors, []);
  } finally {
    await browser.tabs("close", tab.targetId);
  }
}
