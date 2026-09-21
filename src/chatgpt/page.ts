// Adapted from MarioJames/skill-foundry 19f0122 (Apache-2.0); modified for standalone use.
export interface Message {
  id: string;
  role: string;
  text: string;
  final: boolean;
  model?: string;
  error?: string;
  // Page-produced Markdown held until the archive commits it. Verification stays on `text`.
  markdown?: string;
  markdownError?: string;
}
export interface PageState {
  url: string;
  title: string;
  messages: Message[];
  generating: boolean;
  blocked: string | null;
  hasComposer: boolean;
  draft?: string;
  attachments?: boolean;
  sendReady?: boolean;
}
export type Outcome = {
  state: "waiting" | "complete" | "blocked" | "superseded";
  reason?: string;
  reply?: Message;
};

export function conversationId(url: string): string {
  const u = new URL(url);
  if (u.origin !== "https://chatgpt.com")
    throw new Error("Expected a ChatGPT conversation URL");
  const match = u.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9-]+)$/);
  if (!match)
    throw new Error("Expected a persisted conversation URL, not a draft");
  return match[1];
}
export function classify(
  page: PageState,
  url: string,
  userId: string,
): Outcome {
  if (page.blocked) return { state: "blocked", reason: page.blocked };
  try {
    if (conversationId(page.url) !== conversationId(url))
      return { state: "blocked", reason: "Conversation changed" };
  } catch {
    return { state: "blocked", reason: "Not on the registered conversation" };
  }
  const index = page.messages.findIndex(
    (m) => m.role === "user" && m.id === userId,
  );
  if (index < 0)
    return {
      state: "blocked",
      reason: "Submitted user message is absent; inspect the page",
    };
  const after = page.messages.slice(index + 1);
  if (after.some((m) => m.role === "user"))
    return { state: "superseded", reason: "A later user message is present" };
  const reply = after.filter((m) => m.role === "assistant").at(-1);
  if (!page.generating && reply?.error)
    return { state: "blocked", reason: reply.error };
  if (!page.generating && reply?.final && reply.text.trim())
    return { state: "complete", reply };
  // A recognized submitted turn can temporarily lose its composer during thinking.
  // Absence alone never proves completion or failure; the caller bounds waiting.
  return { state: "waiting" };
}
// Verified against the live composer. The submit ID alone also identifies other composer actions.
export const SEND_SELECTOR =
  'form:has(#prompt-textarea) button[data-testid="send-button"][type="submit"]';
export const PAGE_SCRIPT = `(() => {
  const main = document.querySelector('main');
  const visible = e => !!e && e.getClientRects().length > 0;
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const label = e => (e.getAttribute('aria-label') || e.textContent || '').trim();
  const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
  const failures = new Map();
  const failurePanels = [];
  // Generation errors can be plain paragraphs outside the assistant message body.
  // Scope them to their DOM position; scanning the whole page would poison later turns.
  for (const retry of buttons.filter(e => /^(Retry|重试)$/.test(label(e)))) {
    if (!main?.contains(retry)) continue;
    let panel = retry.parentElement;
    while (panel && panel !== main && !panel.querySelector('[data-message-author-role="user"], #prompt-textarea')) {
      if (/something went wrong while generating the response/i.test(panel.innerText)) {
        if (panel.closest('[data-turn="user"], [data-message-author-role="user"]')) break;
        const message = panel.closest('[data-message-author-role="assistant"]')
          || Array.from(panel.querySelectorAll('[data-message-author-role="assistant"]')).at(-1);
        const node = message || panel;
        failures.set(node, "Response generation failed; inspect the original reply's Retry control");
        failurePanels.push(panel);
        if (!messageNodes.includes(node)) messageNodes.push(node);
        break;
      }
      panel = panel.parentElement;
    }
  }
  messageNodes.sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const messages = messageNodes.map(e => {
    const turn = e.closest('[data-turn="assistant"], [data-testid^="conversation-turn-"]');
    const actions = turn ? Array.from(turn.querySelectorAll('button')) : [];
    return { id: e.getAttribute('data-message-id') || '', role: e.getAttribute('data-message-author-role') || 'assistant',
      text: e.innerText,
      error: failures.get(e),
      model: e.getAttribute('data-message-model-slug') || undefined,
      final: actions.some(b => /^(Copy response|复制回复)$/.test(label(b))) };
  });
  const challenge = /^(Just a moment|Security Verification)/i.test(document.title)
    || Array.from(document.querySelectorAll('iframe')).some(e => /cloudflare security challenge/i.test(e.title));
  const login = location.hostname === 'auth.openai.com' || buttons.some(e => /^(Log in|登录)$/.test(label(e)));
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter(e => visible(e)
    && !failurePanels.some(panel => panel.contains(e) || e.contains(panel))).map(e => e.innerText).join(' ');
  const error = /something went wrong|unable to load conversation|出了点问题|无法加载对话/i.test(alerts);
  const composer = document.querySelector('#prompt-textarea');
  const sends = Array.from(document.querySelectorAll(${JSON.stringify(SEND_SELECTOR)})).filter(visible);
  const send = sends.length === 1 ? sends[0] : undefined;
  const rect = send?.getBoundingClientRect();
  const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const sendReady = !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'
    && !!hit && (hit === send || send.contains(hit));
  // ProseMirror renders every input line as a paragraph. innerText inserts extra blank lines.
  const draft = composer?.tagName === 'TEXTAREA' ? composer.value : (composer && Array.from(composer.childNodes).every(e => e.nodeType === 1 && e.nodeName === 'P')
    ? Array.from(composer.children).map(e => Array.from(e.childNodes).filter(n => !(n.nodeType === 1 && n.classList?.contains('ProseMirror-trailingBreak'))).map(n => n.nodeName === 'BR' ? '\\n' : n.textContent).join('')).join('\\n')
    : composer?.innerText || '');
  return { url:location.href, title:document.title, messages,
    generating:buttons.some(e => /^(Stop answering|Stop generating|停止回答|停止生成)$/.test(label(e))),
    draft, sendReady,
    attachments: Array.from(document.querySelectorAll('button')).some(e => visible(e) && /remove (file|attachment)|移除附件|删除附件/i.test(label(e))),
    hasComposer:!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea'),
    blocked:challenge ? 'Human verification required' : login ? 'Login required' : error ? 'Conversation UI reported an error' : null };
})()`;
