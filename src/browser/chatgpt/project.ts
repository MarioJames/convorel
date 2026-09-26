import { COMPOSER_DOM, MESSAGE_DOM } from "./dom.ts";
import { projectId } from "./organize.ts";
import type { PageState } from "./page.ts";

// The project's own composer is its New chat entry; the sidebar New chat opens a normal chat.
export function projectComposerScript() {
  return `(() => {
    const visible = e => e.getClientRects().length > 0 && !e.closest('[aria-hidden="true"], [inert]');
    ${COMPOSER_DOM}
    ${MESSAGE_DOM}
    const headings = Array.from(document.querySelectorAll('main h1')).filter(visible);
    return {
      url: location.href,
      composerCount: composers.length,
      editable: composers.length === 1 && !composers[0].matches(':disabled, [readonly], [aria-disabled="true"]') && (composers[0].isContentEditable || composers[0].tagName === 'TEXTAREA'),
      messageCount: messageNodesFor().length,
      projectName: headings.length === 1 ? headings[0].textContent.trim() : null,
    };
  })()`;
}
export function assertNewConversationPage(
  page: PageState,
  projectUrl?: string,
) {
  let expectedLocation = page.url === "https://chatgpt.com/";
  if (projectUrl) {
    try {
      expectedLocation = projectId(page.url) === projectId(projectUrl);
    } catch {
      expectedLocation = false;
    }
  }
  if (!expectedLocation) throw new Error("NEW_CONVERSATION_LOCATION_CHANGED");
  if (page.messages.length) throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
}
export async function verifyProjectComposer(
  b: { run: (...args: string[]) => Promise<any> },
  projectUrl: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const expected = projectId(projectUrl);
  // Polling budget; each transport observation has its own bounded timeout.
  // Do not race and abandon a still-running browser command at this deadline.
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    const { result } = await b.run("eval", projectComposerScript());
    let observed: string | undefined;
    try {
      observed = projectId(result?.url);
    } catch {}
    if (observed !== expected) throw new Error("PROJECT_IDENTITY_CHANGED");
    if (!Number.isSafeInteger(result.messageCount) || result.messageCount < 0)
      throw new Error("PROJECT_COMPOSER_UNRECOGNIZED");
    if (result.messageCount) throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
    if (result.composerCount === 1 && result.editable === true) return;
    if (result.composerCount > 1) throw new Error("PROJECT_COMPOSER_AMBIGUOUS");
    if (Date.now() >= deadline)
      throw new Error(
        `PROJECT_COMPOSER_NOT_READY: composers=${result.composerCount} editable=${result.editable === true}`,
      );
    await Bun.sleep(
      Math.min(options.intervalMs ?? 250, Math.max(1, deadline - Date.now())),
    );
  }
}
