import { projectId } from "./organize.ts";
import type { PageState } from "./page.ts";

// The project's own composer is its New chat entry; the sidebar New chat opens a normal chat.
export function projectComposerScript() {
  return `(() => {
    const e = document.querySelector('main #prompt-textarea');
    return e && e.getClientRects().length ? {
      label: e.getAttribute('aria-label') || e.getAttribute('placeholder') || '',
    } : null;
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
  projectId(projectUrl);
  const { result } = await b.run("eval", projectComposerScript());
  const label = result?.label?.trim();
  if (
    ![
      `New chat in ${projectName}`,
      `在 ${projectName} 中新建聊天`,
      `在 ${projectName} 中新建对话`,
    ].includes(label)
  )
    throw new Error("PROJECT_COMPOSER_UNVERIFIED");
}
