import { projectId } from "./organize.ts";
import type { PageState } from "./page.ts";

// The project's own composer is its New chat entry; the sidebar New chat opens a normal chat.
export function projectComposerScript() {
  return `(() => {
    const visible = e => e.getClientRects().length > 0 && !e.closest('[aria-hidden="true"], [inert]');
    const composers = Array.from(document.querySelectorAll('main form #prompt-textarea')).filter(visible);
    const headings = Array.from(document.querySelectorAll('main h1')).filter(visible);
    return {
      url: location.href,
      composerCount: composers.length,
      editable: composers.length === 1 && (composers[0].isContentEditable || composers[0].tagName === 'TEXTAREA'),
      projectName: headings.length === 1 ? headings[0].textContent.trim() : null,
    };
  })()`;
}
export function assertNewConversationPage(
  page: PageState,
  projectUrl?: string,
) {
  if (page.url !== (projectUrl || "https://chatgpt.com/"))
    throw new Error("NEW_CONVERSATION_LOCATION_CHANGED");
  if (page.messages.length) throw new Error("UNEXPECTED_CONVERSATION_HISTORY");
}
export async function verifyProjectComposer(
  b: { run: (...args: string[]) => Promise<any> },
  projectUrl: string,
  projectName: string,
) {
  const expected = projectId(projectUrl);
  const { result } = await b.run("eval", projectComposerScript());
  let observed: string | undefined;
  try {
    observed = projectId(result?.url);
  } catch {}
  if (
    observed !== expected ||
    result?.composerCount !== 1 ||
    !result.editable ||
    result.projectName !== projectName.trim()
  )
    throw new Error("PROJECT_COMPOSER_UNVERIFIED");
}
