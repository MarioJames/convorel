/**
 * A completed reply is archived as Markdown, not as rendered text. The page's own
 * "Copy response" control is what yields the source the model produced, so the capture
 * drives that control and takes what it hands to the clipboard.
 *
 * The clipboard methods are replaced only until the click has produced its payload,
 * then restored from inside the page, and the user's real clipboard is never written.
 */
export function copyMarkdownScript(messageId: string) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(messageId))
    throw new Error("INVALID_MESSAGE_ID");
  return `(async () => {
  const wanted = ${JSON.stringify(messageId)};
  // One budget for the whole capture: waiting for the clipboard write, reading each
  // payload and re-identifying the target all share it.
  const deadline = Date.now() + 4000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const timed = async (work, reason) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(reason)), remaining());
        }),
      ]);
    } catch (error) {
      return { failure: error && error.message === 'COPY_DEADLINE' ? reason : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const label = e => (e.getAttribute('aria-label') || e.textContent || '').trim();
  const find = () => Array.from(document.querySelectorAll('[data-message-author-role]'))
    .find(e => e.getAttribute('data-message-id') === wanted);
  // The turn's own action bar sits inside the message element and its label changes on
  // click, so identity is measured on the rendered body only. Length alone would accept
  // an equal-length rewrite, so the body is fingerprinted as well.
  const body = e => {
    if (!e) return null;
    const rendered = e.querySelector('.markdown');
    return (rendered || e).innerText;
  };
  const fingerprint = e => {
    const text = body(e);
    if (typeof text !== 'string') return null;
    let hash = 0x811c9dc5;
    for (let n = 0; n < text.length; n++) {
      hash ^= text.charCodeAt(n);
      hash = Math.imul(hash, 0x01000193);
    }
    return { length: text.length, hash: (hash >>> 0).toString(16) };
  };
  const unchanged = (a, b) => !!a && !!b && a.length === b.length && a.hash === b.hash;
  const message = find();
  if (!message) return { ok: false, reason: 'MESSAGE_NOT_RENDERED' };
  const before = fingerprint(message);
  const turn = message.closest('[data-testid^="conversation-turn-"]')
    || message.closest('[data-turn="assistant"]');
  if (!turn) return { ok: false, reason: 'TURN_NOT_FOUND' };
  const buttons = Array.from(turn.querySelectorAll('button[data-testid="copy-turn-action-button"]'))
    .filter(b => /^(Copy response|复制回复)$/.test(label(b)));
  if (buttons.length !== 1)
    return { ok: false, reason: buttons.length ? 'COPY_BUTTON_AMBIGUOUS' : 'COPY_BUTTON_MISSING' };
  const clipboard = navigator.clipboard;
  if (!clipboard) return { ok: false, reason: 'CLIPBOARD_UNAVAILABLE' };
  const own = { write: Object.hasOwn(clipboard, 'write'), writeText: Object.hasOwn(clipboard, 'writeText') };
  const original = { write: clipboard.write, writeText: clipboard.writeText };
  const pending = [];
  const restore = () => {
    for (const key of ['write', 'writeText']) {
      if (own[key]) clipboard[key] = original[key];
      else delete clipboard[key];
    }
  };
  try {
    clipboard.write = items => { pending.push({ kind: 'items', items }); return Promise.resolve(); };
    clipboard.writeText = text => { pending.push({ kind: 'text', text }); return Promise.resolve(); };
    buttons[0].click();
    while (!pending.length && remaining() > 1)
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining())));
  } finally {
    restore();
  }
  if (!pending.length) return { ok: false, reason: 'COPY_NOT_CAPTURED' };
  const readEntry = async entry => {
    if (entry.kind === 'text') return [entry.text];
    const found = [];
    for (const item of entry.items || [])
      for (const type of ['text/markdown', 'text/plain']) {
        if (!item.types || !item.types.includes(type)) continue;
        const text = await (await item.getType(type)).text();
        if (text && text.trim()) {
          found.push(text);
          // MIME types describe alternative representations of this item. Prefer
          // Markdown, but retain every item's body for attribution checks below.
          break;
        }
      }
    return found;
  };
  const candidates = [];
  for (const entry of pending) {
    const texts = await timed(() => readEntry(entry), 'COPY_PAYLOAD_TIMEOUT');
    if (texts && texts.failure) return { ok: false, reason: texts.failure };
    for (const text of texts)
      if (typeof text === 'string' && text.trim()) candidates.push(text);
  }
  if (!candidates.length) return { ok: false, reason: 'COPY_PAYLOAD_EMPTY' };
  const distinct = Array.from(new Set(candidates));
  // Several different bodies in this window cannot be attributed to one reply.
  if (distinct.length > 1)
    return { ok: false, reason: 'COPY_AMBIGUOUS', count: distinct.length };
  const after = fingerprint(find());
  // The page answer may change under the capture; never attribute it to this reply.
  if (!unchanged(before, after)) return { ok: false, reason: 'TARGET_CHANGED' };
  return { ok: true, text: distinct[0], length: distinct[0].length, mechanism: pending[0].kind };
})()`;
}
