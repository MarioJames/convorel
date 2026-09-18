// Adapted from skill-foundry 19f0122 (Apache-2.0), standalone Browser adapter.
// Run explicitly: bun tests/browser.integration.ts --chrome /path/to/installed/chrome
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, clearDraft, sendPrompt } from "../src/browser.ts";
import { command } from "../src/command.ts";
import { classify } from "../src/chatgpt/page.ts";
import { Conversation, type Task } from "../src/conversation.ts";
import { State } from "../src/state.ts";
import { sha } from "../src/workspace.ts";

const chromePath = process.argv[process.argv.indexOf("--chrome") + 1];
if (!process.argv.includes("--chrome") || !chromePath)
  throw new Error("Pass --chrome with an installed Chrome executable");
const root = mkdtempSync(join(tmpdir(), "review-browser-"));
let namespace = "";
let controller: Browser;
const previous = {
  config: process.env.AGENT_BROWSER_CONFIG,
  namespace: process.env.AGENT_BROWSER_NAMESPACE,
};
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
    '<button aria-label="Copy response">Copy</button></div><form onsubmit="event.preventDefault();window.sends=(window.sends||0)+1"><textarea id="prompt-textarea"></textarea>' +
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
  assert.equal(page.messages.at(-1)?.text, "Done");
  assert.equal(page.messages.at(-1)?.final, true);
  assert.equal(page.sendReady, true);
  await sendPrompt(b, page);
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
  await assert.rejects(sendPrompt(b, stopped), /SEND_CONTROL_UNAVAILABLE/);
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
  // Reduced from the captured failure: ordinary paragraph + Retry, without role=alert
  // or a guaranteed data-message-author-role wrapper on the failed response.
  const failureHtml = readFileSync(
    new URL("./fixtures/generation-error.html", import.meta.url),
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
    `document.querySelector('#failed-response').removeAttribute('data-message-author-role'); document.querySelector('#failed-response').removeAttribute('data-message-id'); document.querySelector('#failed-response').insertAdjacentHTML('beforebegin', '<article data-turn="assistant" id="failed-turn"><div data-message-author-role="assistant" data-message-id="a1">Partial response</div><button aria-label="Copy response">Copy</button></article>'); document.querySelector('#failed-turn').append(document.querySelector('#failed-response'))`,
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
    `document.querySelector('main').insertAdjacentHTML('beforeend', '<button aria-label="Stop answering">Stop</button>')`,
  );
  assert.equal(
    (await outcome()).state,
    "waiting",
    "Retry residue cannot override active generation",
  );
  await failurePage.run(
    "eval",
    `document.querySelector('[aria-label="Stop answering"]').remove(); document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a2">Recovered</div><button aria-label="Copy response">Copy</button></div>')`,
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
  };
  const conversation = new Conversation(
    fixtureState,
    adapter as unknown as Browser,
    async () => ({ observedModel: "6 Pro" }),
  );
  const restoredTask = await conversation.start(
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
  await conversation.start("continued", "Follow-up", "next", true);
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
  console.log(
    JSON.stringify({
      passed: true,
      initialTabs: 1,
      peakTabs: 3,
      remainingTabs: 1,
      pageErrors: pageErrors.errors,
      checks: [
        "list",
        "create",
        "read",
        "rebind",
        "close",
        "pin protection",
        "missing target",
        "composer paragraph extraction",
        "authorized draft clearing and input event",
        "stale authorization and focus race protection",
        "localized structural submit",
        "stop button exclusion",
        "send obstruction",
        "current and historical generation errors",
        "generation recovery without resend",
        "completed followup restores without touching another task's target",
      ],
      cdp,
    }),
  );
} finally {
  try {
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
    rmSync(root, { recursive: true, force: true });
  }
}
