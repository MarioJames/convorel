import { COMPOSER_SELECTOR, COPY_SELECTOR, COPY_NAMES } from "./controls.ts";

export const CONTROL_NAME_DOM = `
  const controlName = e => (e.getAttribute('aria-label') ||
    (e.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
    || e.textContent || '').replace(/\\s+/g, ' ').trim();
`;

/** Shared DOM identities for observation, draft editing and Markdown attribution. */
export const MESSAGE_DOM = `
  ${CONTROL_NAME_DOM}
  const messageNodesFor = () => {
    const nodes = Array.from(document.querySelectorAll(
      '[data-message-author-role], [data-user-message-bubble], [data-chatgpt-selection-message-id]'
    )).filter(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
      && !e.closest('[aria-hidden="true"], [inert]') && (
        e.hasAttribute('data-message-author-role') ||
        e.hasAttribute('data-user-message-bubble') ||
        !!e.querySelector('[data-markdown-text-style="assistant-message"]')
      ));
    const identities = new Map();
    return nodes.filter(e => {
      const id = messageId(e);
      if (!id) return true;
      const prior = identities.get(id);
      if (!prior) {
        identities.set(id, e);
        return true;
      }
      if (messageRole(prior) !== messageRole(e)
        || messageContent(prior) !== messageContent(e)
        || prior.getAttribute('data-message-model-slug') !== e.getAttribute('data-message-model-slug'))
        throw new Error('MESSAGE_ID_CONFLICT');
      // Keep one exact representation. Never merge completion/copy controls
      // from different roots or discard unidentified later user messages.
      return false;
    });
  };
  const messageRole = e => e.getAttribute('data-message-author-role')
    || (e.hasAttribute('data-user-message-bubble') ? 'user' : 'assistant');
  const messageId = e => {
    const id = e.getAttribute('data-message-id') || e.getAttribute('data-chatgpt-selection-message-id');
    if (id) return id;
    const ids = [...new Set((e.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids') || '').split(/\\s+/).filter(Boolean))];
    return ids.length === 1 ? ids[0] : '';
  };
  const messageBody = e => e.querySelector('[data-markdown-text-style="assistant-message"], .markdown')
    || e.querySelector('[data-search-result-target]') || e;
  const codeActions = '[data-markdown-copy="code-block"] [data-markdown-copy="exclude"] button, '
    + '[data-markdown-copy="code-block"] [data-markdown-copy="exclude"] [role="button"]';
  const messageContent = e => {
    const body = messageBody(e).cloneNode(true);
    body.querySelectorAll(codeActions).forEach(control => control.remove());
    return body.textContent;
  };
  const messageText = e => {
    const body = messageBody(e);
    // ChatGPT lazily adds Run/Copy actions inside code-block toolbars. Preserve
    // the rendered language label and whitespace, but exclude those controls.
    // A detached clone loses innerText layout semantics. Mask only these UI
    // nodes synchronously and restore exact styles before returning or repaint.
    const controls = Array.from(body.querySelectorAll(codeActions));
    const styles = controls.map(control => [control, control.getAttribute('style')]);
    try {
      for (const [control] of styles) control.setAttribute('style', 'display:none!important');
      return body.innerText;
    } finally {
      for (const [control, style] of styles) {
        if (style === null) control.removeAttribute('style');
        else control.setAttribute('style', style);
      }
    }
  };
  const messageTurn = e => e.closest('[data-turn-key]')
    || e.closest('[data-turn="assistant"], [data-testid^="conversation-turn-"]');
  const messageCopies = e => {
    if (messageRole(e) !== 'assistant') return [];
    const turn = messageTurn(e);
    if (!turn) return [];
    const fallback = Array.from(turn.querySelectorAll(${JSON.stringify(COPY_SELECTOR)}));
    if (!turn.hasAttribute('data-turn-key')) return fallback;
    // New turns contain both roles. The response action bar follows the last assistant
    // body, outside search units; user and code-block Copy controls cannot finish a reply.
    const assistants = messageNodesFor().filter(n => messageRole(n) === 'assistant' && messageTurn(n) === turn);
    if (assistants.at(-1) !== e) return [];
    const belongs = b => !b.closest('[data-chatgpt-search-unit-key]')
      && !!(e.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const semantic = Array.from(turn.querySelectorAll('.turn-action-controls button')).filter(b => belongs(b)
      && ${JSON.stringify(COPY_NAMES)}.includes(controlName(b)));
    return semantic.length ? semantic : fallback.filter(belongs);
  };
`;

export const COMPOSER_DOM = `
  const composers = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)}))
    .filter(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
      && !e.closest('[aria-hidden="true"], [inert]'));
  const composer = composers.length === 1 ? composers[0] : null;
`;
