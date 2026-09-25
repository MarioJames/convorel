// Adapted from skill-foundry 19f0122 (Apache-2.0), standalone Browser adapter.
// Run explicitly: bun tests/integration/browser.integration.ts --chrome /path/to/installed/chrome
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, clearDraft, sendPrompt } from "../../src/browser/browser.ts";
import { command } from "../../src/command.ts";
import { classify } from "../../src/browser/chatgpt/page.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { type Task } from "../../src/conversation/types.ts";
import { State } from "../../src/storage/state.ts";
import { sha } from "../../src/hash.ts";
import { MODEL_SCRIPT } from "../../src/browser/chatgpt/model.ts";
import {
  MODEL_SELECT,
  MODEL_LATEST,
} from "../../src/browser/chatgpt/controls.ts";
import { organizationUiScript } from "../../src/browser/chatgpt/organize.ts";
import { projectComposerScript } from "../../src/browser/chatgpt/project.ts";
import { setRuntimePaths } from "../../src/paths.ts";
import { writePreference } from "../../src/config/preferences.ts";
import { copyMarkdownScript } from "../../src/browser/chatgpt/copy.ts";

const chromePath = process.argv[process.argv.indexOf("--chrome") + 1];
if (!process.argv.includes("--chrome") || !chromePath)
  throw new Error("Pass --chrome with an installed Chrome executable");
const root = realpathSync(mkdtempSync(join(tmpdir(), "review-browser-")));
const oldPaths = setRuntimePaths({ configDir: join(root, "preferences") });
writePreference("browser.actionIntervalMs", "1");
writePreference("browser.navigationWaitMs", "1");
let namespace = "";
let controller: Browser;
const previous = {
  config: process.env.AGENT_BROWSER_CONFIG,
  namespace: process.env.AGENT_BROWSER_NAMESPACE,
};
let stopSidebarServer: (() => void) | undefined;
// agent-browser marks each daemon it detaches with the namespace it serves.
function daemons() {
  if (process.platform === "darwin") {
    const output = execFileSync(
      "/bin/ps",
      ["-A", "-E", "-ww", "-o", "pid=,command="],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .filter((line) => line.includes(`AGENT_BROWSER_NAMESPACE=${namespace}`))
      .map((line) => line.trim().split(/\s+/, 1)[0]);
  }
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        return readFileSync(`/proc/${entry}/environ`, "utf8")
          .split("\0")
          .includes(`AGENT_BROWSER_NAMESPACE=${namespace}`);
      } catch {
        return false;
      }
    });
}
// A closed daemon still has to finish shutting its browser connection down.
async function settled() {
  for (let n = 0; n < 100 && daemons().length; n++) await Bun.sleep(100);
  return daemons();
}
writeFileSync(join(root, "config.json"), "{}");
process.env.AGENT_BROWSER_CONFIG = join(root, "config.json");
process.env.AGENT_BROWSER_NAMESPACE = namespace;
const chrome = Bun.spawn(
  [
    chromePath,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "profile")}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
let cdp: string | undefined;
try {
  const portFile = join(root, "profile", "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile) && i < 100; i++) {
    if (chrome.exitCode !== null)
      throw new Error(`Chrome exited: ${chrome.exitCode}`);
    await Bun.sleep(50);
  }
  cdp = readFileSync(portFile, "utf8").split("\n")[0];
  const list = async () =>
    (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()).filter(
      (p: any) => p.type === "page",
    ) as { id: string; url: string }[];
  const initial = await list();
  assert.equal(initial.length, 1);
  controller = new Browser(cdp, root);
  namespace = controller.namespace;
  const tabs = (...args: string[]) => controller.tabs(...args);
  await tabs("list");
  assert.equal((await list()).length, 1, "listing must not create a blank tab");
  const html =
    '<main><div data-message-author-role="user" data-message-id="u1">Review</div>' +
    '<div data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1">Done</div>' +
    '<button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></div><form onsubmit="event.preventDefault();window.sends=(window.sends||0)+1"><textarea id="prompt-textarea"></textarea>' +
    '<button id="composer-submit-button" data-testid="send-button" type="submit" aria-label="发送消息">发送</button></form></main>';
  const url = "data:text/html," + encodeURIComponent(html);
  const created = await tabs("new", url);
  assert.equal(
    (await list()).length,
    2,
    "one requested tab, no implicit extra tab",
  );
  const b = await controller.page(created.targetId);
  const page = await b.read();
  assert.equal(page.url, url);
  const sidebarServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        '<title>ChatGPT</title><aside><a data-sidebar-item href="/c/review-a"><span>Saved title</span><button>Options</button><svg><title>Icon</title></svg><span hidden>Hidden</span></a><a data-sidebar-item href="/c/other">Other title</a></aside>',
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  stopSidebarServer = () => sidebarServer.stop(true);
  const sidebarFixtureUrl = `http://127.0.0.1:${sidebarServer.port}/c/review-a`;
  const sidebarTab = await tabs("new", sidebarFixtureUrl);
  const sidebarPage = await controller.page(sidebarTab.targetId);
  assert.equal((await sidebarPage.read()).title, "ChatGPT");
  assert.equal(
    (await sidebarPage.read()).visibleConversationTitle,
    "Saved title",
  );
  await sidebarPage.run(
    "eval",
    `document.querySelector('a[data-sidebar-item]').setAttribute('href', '/c/wrong')`,
  );
  assert.equal((await sidebarPage.read()).visibleConversationTitle, null);
  await sidebarPage.run(
    "eval",
    `document.querySelector('a[data-sidebar-item]').setAttribute('href', '/c/review-a')`,
  );
  await sidebarPage.run(
    "eval",
    `document.querySelector('a[data-sidebar-item]').style.visibility = 'hidden'`,
  );
  assert.equal((await sidebarPage.read()).visibleConversationTitle, null);
  await sidebarPage.run(
    "eval",
    `document.querySelector('a[data-sidebar-item]').style.visibility = ''`,
  );
  await sidebarPage.run(
    "eval",
    `document.querySelector('aside').append(document.querySelector('a[data-sidebar-item]').cloneNode(true))`,
  );
  assert.equal((await sidebarPage.read()).visibleConversationTitle, null);
  assert.deepEqual((await sidebarPage.run("errors")).errors, []);
  await tabs("close", sidebarTab.targetId);
  stopSidebarServer();
  stopSidebarServer = undefined;
  const returnUrl =
    "data:text/html," + encodeURIComponent("<main>Temporary home</main>");
  await b.run("open", returnUrl);
  assert.equal((await b.read()).url, returnUrl);
  await b.run("open", url);
  assert.equal((await b.read()).url, url);
  assert.equal(
    (await list()).length,
    2,
    "returning on a pinned page keeps its target",
  );
  assert.equal(page.messages.at(-1)?.text, "Done");
  assert.equal(page.messages.at(-1)?.final, true);
  assert.equal(page.sendReady, true);
  await sendPrompt(b, page, async () => {});
  assert.equal(
    (await b.run("eval", "window.sends")).result,
    1,
    "the real structural locator submits a localized composer",
  );
  await b.run(
    "eval",
    `document.querySelector('#composer-submit-button').setAttribute('data-testid','stop-button')`,
  );
  const stopped = await b.read();
  assert.equal(
    stopped.sendReady,
    false,
    "the shared composer ID must not identify Stop as Send",
  );
  await assert.rejects(
    sendPrompt(b, stopped, async () => {}),
    /SEND_CONTROL_UNAVAILABLE/,
  );
  assert.equal((await b.run("eval", "window.sends")).result, 1);
  await b.run(
    "eval",
    `document.querySelector('#composer-submit-button').setAttribute('data-testid','send-button')`,
  );
  await b.run(
    "eval",
    `(() => {const e=document.createElement('div');e.id='closing-overlay';e.style.cssText='position:fixed;inset:0;z-index:9999';document.body.append(e);})()`,
  );
  assert.equal(
    (await b.read()).sendReady,
    false,
    "a closing popover overlay must block sending",
  );
  await b.run("eval", `document.querySelector('#closing-overlay').remove()`);
  assert.equal((await b.read()).sendReady, true);
  await b.run("fill", "#prompt-textarea", "restored textarea draft");
  await clearDraft(b, await b.read());
  assert.equal(
    (await b.read()).draft,
    "",
    "recovery supports textarea composers",
  );
  await (await controller.page(created.targetId)).read();
  assert.equal(
    (await list()).length,
    2,
    "binding and rebinding must not create blank tabs",
  );
  await b.run(
    "eval",
    `(() => {const old=document.querySelector('#prompt-textarea');const e=document.createElement('div');e.id='prompt-textarea';e.contentEditable='true';e.setAttribute('role','textbox');e.value='';e.innerHTML='<p>first line</p><p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p><p>third line</p>';old.replaceWith(e);})()`,
  );
  assert.equal(
    (await b.read()).draft,
    "first line\n\nthird line",
    "ProseMirror paragraphs preserve input line breaks, ignoring a synthetic empty value",
  );
  await b.run(
    "eval",
    `window.recoveryInputs = 0; document.querySelector('#prompt-textarea').addEventListener('input', () => window.recoveryInputs++)`,
  );
  await clearDraft(b, await b.read());
  assert.equal(
    (await b.read()).draft?.trim(),
    "",
    "recovered multiline draft is empty",
  );
  assert.equal(
    (await b.run("eval", "window.recoveryInputs")).result,
    1,
    "deletion emits editor input",
  );
  await b.run(
    "eval",
    `document.querySelector('#prompt-textarea').innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>'`,
  );
  await b.run("fill", "#prompt-textarea", "edited draft");
  assert.equal((await b.read()).draft, "edited draft");
  const restored = await b.read();
  await clearDraft(b, restored);
  assert.equal(
    (await b.read()).draft?.trim(),
    "",
    "authorized recovery clears contenteditable, not its value property",
  );
  await b.run("fill", "#prompt-textarea", "user edit");
  await assert.rejects(clearDraft(b, restored), /DRAFT_CHANGED/);
  assert.equal(
    (await b.read()).draft,
    "user edit",
    "a later edit survives stale recovery authorization",
  );
  await b.run(
    "eval",
    `document.querySelector('button').focus(); document.querySelector('#prompt-textarea').addEventListener('focus', e => {e.target.textContent = 'changed during focus'}, {once: true})`,
  );
  await assert.rejects(clearDraft(b, await b.read()), /DRAFT_CHANGED/);
  assert.equal(
    (await b.read()).draft,
    "changed during focus",
    "recheck after focus protects synchronous edits",
  );
  const pageErrors = await b.run("errors");
  assert.deepEqual(
    pageErrors.errors,
    [],
    "fixture must not produce browser page errors",
  );
  const localizedTab = await tabs(
    "new",
    new URL("../fixtures/localized-controls.html", import.meta.url).href,
  );
  const localizedPage = await controller.page(localizedTab.targetId);
  await localizedPage.run(
    "eval",
    `window.savedComposer = document.querySelector('#prompt-textarea').outerHTML; document.querySelector('#prompt-textarea').outerHTML = '<textarea id="prompt-textarea"></textarea>'`,
  );
  for (const attribute of ["disabled", "readonly", "aria-disabled"]) {
    await localizedPage.run(
      "eval",
      `document.querySelector('#prompt-textarea').setAttribute(${JSON.stringify(attribute)}, 'true')`,
    );
    assert.equal(
      (await localizedPage.run("eval", projectComposerScript())).result
        .editable,
      false,
      attribute + " composer must not be ready",
    );
    await localizedPage.run(
      "eval",
      `document.querySelector('#prompt-textarea').removeAttribute(${JSON.stringify(attribute)})`,
    );
  }
  assert.equal(
    (await localizedPage.run("eval", projectComposerScript())).result.editable,
    true,
  );
  await localizedPage.run(
    "eval",
    `document.querySelector('#prompt-textarea').outerHTML = window.savedComposer; delete window.savedComposer`,
  );
  for (const locale of ["zh-CN", "fr", "en"]) {
    await localizedPage.run(
      "eval",
      `window.setLocale(${JSON.stringify(locale)})`,
    );
    const localized = await localizedPage.read();
    assert.equal(localized.generating, true, locale + " stop identity");
    assert.equal(
      localized.messages.at(-1)?.final,
      true,
      locale + " copy identity",
    );
    assert.equal(localized.messages.at(-1)?.text, "Stable reply");
    const project = (await localizedPage.run("eval", projectComposerScript()))
      .result;
    assert.equal(project.projectName, "Agent reviews");
    assert.equal(project.composerCount, 1);
    assert.equal(project.editable, true);
    assert.equal(
      project.messageCount,
      2,
      "existing history cannot be a new project chat",
    );
    await localizedPage.run("click", "#model");
    const menu = (await localizedPage.run("eval", MODEL_SCRIPT)).result;
    assert.equal(menu.menuLabel, "6 Pro");
    assert.equal(menu.power.value, 4);
    assert.equal(menu.latest, null, "inert defaults cannot be clicked");
    await localizedPage.run("click", MODEL_SELECT);
    assert.equal(
      (await localizedPage.run("eval", MODEL_SCRIPT)).result.latest.checked,
      true,
    );
    await localizedPage.run("click", MODEL_LATEST);
    await localizedPage.run("press", "Escape");
    let organization = (
      await localizedPage.run("eval", organizationUiScript("review-a"))
    ).result;
    assert.ok(organization.options);
    await localizedPage.run("click", organization.options);
    organization = (
      await localizedPage.run("eval", organizationUiScript("review-a"))
    ).result;
    assert.ok(organization.rename, locale + " bound rename identity");
    await localizedPage.run("click", organization.rename);
    organization = (
      await localizedPage.run("eval", organizationUiScript("review-a"))
    ).result;
    assert.equal(organization.titleInput, 'input[name="title-editor"]');
    await localizedPage.run("press", "Escape");
    const copied = (await localizedPage.run("eval", copyMarkdownScript("a1")))
      .result;
    assert.equal(copied.ok, true, locale + " Markdown capture");
    assert.equal(copied.text, "**Stable reply**");
  }
  await localizedPage.run(
    "eval",
    `document.querySelector('[data-testid="stop-button"]').remove()`,
  );
  assert.equal((await localizedPage.read()).generating, false);
  await localizedPage.run(
    "eval",
    `const c=document.querySelector('[data-testid="copy-turn-action-button"]');c.removeAttribute('data-testid');c.setAttribute('aria-label','Copy response')`,
  );
  assert.equal(
    (await localizedPage.read()).messages.at(-1)?.final,
    false,
    "matching words cannot impersonate a copy action",
  );
  assert.equal(
    (await localizedPage.run("eval", copyMarkdownScript("a1"))).result.reason,
    "COPY_BUTTON_MISSING",
  );
  assert.deepEqual((await localizedPage.run("errors")).errors, []);
  await localizedPage.run("click", "#options");
  await localizedPage.run(
    "eval",
    `document.querySelector('#rename path').setAttribute('d','M0 0');document.querySelector('#rename span').textContent='Rename'`,
  );
  assert.equal(
    (await localizedPage.run("eval", organizationUiScript("review-a"))).result
      .rename,
    null,
    "unknown icon fails closed even with a matching label",
  );
  await localizedPage.run(
    "eval",
    `document.querySelector('aside').remove(); const header=document.createElement('button'); header.id='conversation-options-review-a'; header.dataset.testid='conversation-options-button'; header.textContent='Options'; document.body.appendChild(header)`,
  );
  assert.equal(
    (await localizedPage.run("eval", organizationUiScript("review-a"))).result
      .options,
    'button[data-testid="conversation-options-button"][id="conversation-options-review-a"]',
  );
  assert.equal(
    (
      await localizedPage.run(
        "eval",
        organizationUiScript("another-conversation"),
      )
    ).result.options,
    null,
    "header fallback must bind the exact conversation ID",
  );
  await tabs("close", localizedTab.targetId);
  // file: is a secure context for the real Clipboard API, unlike data: fixtures.
  const copyTab = await tabs(
    "new",
    new URL("../fixtures/copy-response.html", import.meta.url).href,
  );
  const copyPage = await controller.page(copyTab.targetId);
  await copyPage.run(
    "eval",
    "window.originalWrite = navigator.clipboard.write; window.originalWriteText = navigator.clipboard.writeText",
  );
  const copied = await copyPage.run("eval", copyMarkdownScript("copy-fixture"));
  assert.equal(copied.result.ok, true);
  assert.equal(copied.result.text, "## Reply\n\n**First answer**");
  await copyPage.run("eval", "window.captureMode = 'items'");
  const ambiguous = await copyPage.run(
    "eval",
    copyMarkdownScript("copy-fixture"),
  );
  assert.equal(
    ambiguous.result.reason,
    "COPY_AMBIGUOUS",
    "multiple clipboard items must not silently select the first answer",
  );
  await copyPage.run("eval", "window.captureMode = 'rewrite'");
  assert.equal(
    (await copyPage.run("eval", copyMarkdownScript("copy-fixture"))).result
      .reason,
    "TARGET_CHANGED",
  );
  assert.equal(
    (
      await copyPage.run(
        "eval",
        "navigator.clipboard.write === window.originalWrite && navigator.clipboard.writeText === window.originalWriteText",
      )
    ).result,
    true,
  );
  assert.deepEqual((await copyPage.run("errors")).errors, []);
  await tabs("close", copyTab.targetId);
  // Reduced from the captured failure: ordinary paragraph + Retry, without role=alert
  // or a guaranteed data-message-author-role wrapper on the failed response.
  const failureHtml = readFileSync(
    new URL("../fixtures/generation-error.html", import.meta.url),
    "utf8",
  );
  const failureUrl = "data:text/html," + encodeURIComponent(failureHtml);
  const failureTab = await tabs("new", failureUrl);
  assert.equal((await list()).length, 3);
  const failurePage = await controller.page(failureTab.targetId);
  const registeredUrl = "https://chatgpt.com/c/fixture";
  const outcome = async () => {
    const observed = await failurePage.read();
    return classify({ ...observed, url: registeredUrl }, registeredUrl, "u1");
  };
  assert.equal(
    (await outcome()).state,
    "blocked",
    "current failed response stops waiting",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').setAttribute('data-message-author-role', 'assistant'); document.querySelector('#failed-response').setAttribute('data-message-id', 'a1')`,
  );
  assert.equal(
    (await outcome()).state,
    "blocked",
    "failure inside an assistant message is also recognized",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').removeAttribute('data-message-author-role'); document.querySelector('#failed-response').removeAttribute('data-message-id'); document.querySelector('#failed-response').insertAdjacentHTML('beforebegin', '<article data-turn="assistant" id="failed-turn"><div data-message-author-role="assistant" data-message-id="a1">Partial response</div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></article>'); document.querySelector('#failed-turn').append(document.querySelector('#failed-response'))`,
  );
  assert.equal(
    (await outcome()).state,
    "blocked",
    "error sibling overrides a copyable partial response",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').setAttribute('role', 'alert')`,
  );
  await failurePage.run(
    "eval",
    `document.querySelector('main').insertAdjacentHTML('beforeend', '<button data-testid="stop-button" aria-label="Stop answering">Stop</button>')`,
  );
  assert.equal(
    (await outcome()).state,
    "waiting",
    "Retry residue cannot override active generation",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('[aria-label="Stop answering"]').remove(); document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a2">Recovered</div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></div>')`,
  );
  assert.equal(
    (await outcome()).state,
    "complete",
    "newer successful response supersedes the failed attempt",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('[data-message-id="a2"]').parentElement.remove(); document.querySelector('[data-message-id="u1"]').before(document.querySelector('#failed-turn'))`,
  );
  assert.equal(
    (await outcome()).state,
    "waiting",
    "historical failed response cannot block a later request",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('[data-message-id="u1"]').after(document.querySelector('#failed-response')); document.querySelector('#failed-response').hidden = true`,
  );
  assert.equal(
    (await outcome()).state,
    "waiting",
    "hidden failure is not a current UI error",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').hidden = false; document.querySelector('#failed-response button').remove()`,
  );
  // Without an error alert or Retry control, matching prose alone is not failure evidence.
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').removeAttribute('role')`,
  );
  assert.equal(
    (await outcome()).state,
    "waiting",
    "quoted error text alone is not a generation failure",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').insertAdjacentHTML('beforeend', '<button>Retry</button>')`,
  );
  await failurePage.run(
    "eval",
    `document.querySelector('#failed-response').hidden = false; document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="u2">Later request</div>')`,
  );
  assert.equal(
    (await outcome()).state,
    "superseded",
    "later user turns retain precedence",
  );
  assert.equal(
    (
      await failurePage.run(
        "eval",
        "(window.retries || 0) + (window.sends || 0)",
      )
    ).result,
    0,
    "observation never retries or resends",
  );
  assert.deepEqual((await failurePage.run("errors")).errors, []);
  await tabs("close", failureTab.targetId);
  await tabs("close", created.targetId);
  await assert.rejects(
    b.read(),
    /tab_gone|closed/i,
    "closed pinned target must not fall back to the user tab",
  );
  await assert.rejects(
    controller.page(created.targetId),
    /not found|no tab|closed|tab_gone/i,
  );
  assert.deepEqual(
    (await list()).map((p) => p.id),
    initial.map((p) => p.id),
  );
  // Exercise followup restoration with real CDP targets and DOM interaction.
  // Only the saved ChatGPT URL/model are substituted; fixtures stay offline.
  const followupUrl = "https://chatgpt.com/c/restored-fixture";
  const followupHtml = html.replace(
    "window.sends=(window.sends||0)+1",
    "window.sends=(window.sends||0)+1;const m=document.createElement('div');m.dataset.messageAuthorRole='user';m.dataset.messageId='u2';m.textContent=document.querySelector('textarea').value;document.querySelector('main').append(m);document.querySelector('textarea').value=''",
  );
  const fixtureUrl = "data:text/html," + encodeURIComponent(followupHtml);
  const claimedTab = await tabs("new", fixtureUrl);
  const claimedPage = await controller.page(claimedTab.targetId);
  await claimedPage.run("fill", "#prompt-textarea", "Other task's draft");
  const claimedBefore = await claimedPage.read();
  const fixtureState = new State(join(root, "followup-state"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const epoch = await controller.epoch();
  const completed: Task = {
    version: 1,
    id: "continued",
    config: { version: 1, workspace, cdp, model: "6 Pro" },
    workspaceId: "fixture",
    url: followupUrl,
    binding: { target: "closed-target", epoch, owned: true, closed: true },
    currentRun: "completed-run",
    attemptId: "completed-attempt",
    runs: [
      {
        id: "completed-run",
        requestId: "initial",
        inputHash: sha("Review"),
        prompt: "Review",
        promptHash: sha("Review"),
        marker: "initial-marker",
        state: "complete",
        userMessageId: "u1",
        reply: { id: "a1", role: "assistant", text: "Done", final: true },
        replyHash: sha("Done"),
        branch: ["u1", "a1"],
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const occupant: Task = {
    ...structuredClone(completed),
    id: "occupant",
    url: "https://chatgpt.com/c/other-fixture",
    binding: { target: claimedTab.targetId, epoch, owned: true },
  };
  fixtureState.write("task-continued", completed);
  fixtureState.write("task-occupant", occupant);
  const adapter = {
    epoch: () => controller.epoch(),
    tabs: async (...args: string[]) => {
      if (args[0] === "new") {
        assert.equal(args[1], followupUrl);
        return tabs("new", fixtureUrl);
      }
      assert.equal(args[0], "list", "restoration must not close any target");
      const result = await tabs(...args);
      return {
        ...result,
        tabs: result.tabs.map((t: any) => ({
          ...t,
          url: t.url === fixtureUrl ? followupUrl : t.url,
        })),
      };
    },
    page: async (target: string) => {
      assert.notEqual(
        target,
        claimedTab.targetId,
        "never bind the occupied page",
      );
      const page = await controller.page(target);
      return {
        ...page,
        read: async () => ({ ...(await page.read()), url: followupUrl }),
      };
    },
    release: () => controller.release(),
    withSessionScope: (fn: () => Promise<any>) =>
      controller.withSessionScope(fn),
  };
  const conversation = new Conversation(
    fixtureState,
    adapter as unknown as Browser,
    async () => ({ observedModel: "6 Pro" }),
  );
  const restoredTask = await startConversation(
    conversation,
    "continued",
    "Follow-up",
    "next",
    true,
  );
  assert.equal(restoredTask.runs.length, 2);
  assert.equal(restoredTask.runs[1]!.state, "waiting");
  assert.equal(restoredTask.runs[0]!.id, "completed-run");
  assert.equal(restoredTask.binding!.owned, true);
  assert.equal((await list()).length, initial.length + 2);
  const restoredTaskPage = await controller.page(restoredTask.binding!.target);
  assert.equal((await restoredTaskPage.run("eval", "window.sends")).result, 1);
  await startConversation(conversation, "continued", "Follow-up", "next", true);
  assert.equal((await restoredTaskPage.run("eval", "window.sends")).result, 1);
  assert.deepEqual(await claimedPage.read(), claimedBefore);
  assert.deepEqual(fixtureState.read("task-occupant"), occupant);
  assert.deepEqual((await restoredTaskPage.run("errors")).errors, []);
  assert.deepEqual((await claimedPage.run("errors")).errors, []);
  await tabs("close", restoredTask.binding!.target);
  await tabs("close", claimedTab.targetId);
  assert.deepEqual(
    (await list()).map((p) => p.id),
    initial.map((p) => p.id),
  );
  assert.ok(
    daemons().length > 0,
    "the operations above must have started daemons",
  );
  await controller.release();
  assert.deepEqual(
    await settled(),
    [],
    "release must stop every daemon this process started",
  );
  assert.deepEqual(
    (await list()).map((p) => p.id),
    initial.map((p) => p.id),
    "releasing a session must not touch the user's tabs",
  );
  assert.equal(
    (await (await controller.page(initial[0].id)).read()).url,
    "about:blank",
    "a released session rebinds its tab on the next command",
  );
  await controller.release();
  assert.deepEqual(await settled(), [], "release is repeatable");
  let releaseFirst!: () => void;
  let firstReady!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const ready = new Promise<void>((resolve) => (firstReady = resolve));
  const firstOperation = controller.withSessionScope(async () => {
    const page = await controller.page(initial[0].id);
    await page.read();
    firstReady();
    await firstGate;
    assert.equal((await page.read()).url, "about:blank");
  });
  await ready;
  await controller.withSessionScope(async () => {
    const page = await controller.page(initial[0].id);
    assert.equal((await page.read()).url, "about:blank");
  });
  for (let n = 0; n < 20 && daemons().length > 1; n++) await Bun.sleep(50);
  assert.equal(daemons().length, 1, "later operation releases only its daemon");
  releaseFirst();
  await firstOperation;
  assert.deepEqual(await settled(), [], "both operation daemons are released");
  console.log(
    JSON.stringify({
      passed: true,
      initialTabs: 1,
      peakTabs: 3,
      remainingTabs: 1,
      sidebarFixtureUrl,
      pageErrors: pageErrors.errors,
      checks: [
        "list",
        "create",
        "read",
        "exact visible conversation sidebar title, independent of document title",
        "navigate owned pinned tab and return",
        "rebind",
        "close",
        "daemon release",
        "concurrent operation session isolation",
        "pin protection",
        "missing target",
        "composer paragraph extraction",
        "authorized draft clearing and input event",
        "stale authorization and focus race protection",
        "localized structural submit",
        "Chinese, French and English project/model/copy/stop DOM contracts",
        "stop button exclusion",
        "send obstruction",
        "Markdown copy, clipboard ambiguity, target rewrite and clipboard restoration",
        "current and historical generation errors",
        "generation recovery without resend",
        "completed followup restores without touching another task's target",
      ],
      cdp,
    }),
  );
} finally {
  try {
    stopSidebarServer?.();
    // This namespace and browser belong only to this test. Never use close --all on shared sessions.
    await command([
      "agent-browser",
      "--namespace",
      namespace,
      "close",
      "--all",
      "--json",
    ]);
  } finally {
    if (chrome.exitCode === null) chrome.kill();
    await chrome.exited;
    if (cdp) {
      const reachable = await fetch(
        `http://127.0.0.1:${cdp}/json/version`,
      ).then(
        () => true,
        () => false,
      );
      assert.equal(reachable, false, "test Chrome must be released");
    }
    if (previous.config === undefined) delete process.env.AGENT_BROWSER_CONFIG;
    else process.env.AGENT_BROWSER_CONFIG = previous.config;
    if (previous.namespace === undefined)
      delete process.env.AGENT_BROWSER_NAMESPACE;
    else process.env.AGENT_BROWSER_NAMESPACE = previous.namespace;
    setRuntimePaths(oldPaths);
    rmSync(root, { recursive: true, force: true });
  }
}

async function startConversation(
  conversation: Conversation,
  ...args: Parameters<Conversation["create"]>
) {
  const task = await conversation.create(...args);
  return conversation.start(task.id, task.currentRun, args[4]);
}
