const visible = e => !!e && e.getClientRects().length > 0
  && !e.closest('[aria-hidden="true"], [inert]') && getComputedStyle(e).visibility !== 'hidden';
const all = (selector, scope=document) => Array.from(scope.querySelectorAll(selector)).filter(visible);
const unique = (items, name) => { if(items.length !== 1) throw new Error(name+': expected one visible control, got '+items.length); return items[0]; };
const disabled = e => e.matches(':disabled,[readonly],[aria-disabled="true"]') || !!e.querySelector('[aria-disabled="true"],[data-locked="true"]');
const composer = () => unique(all('form[data-chatgpt-composer] [data-composer-markdown][role="textbox"], #prompt-textarea'), 'composer');
const form = () => { const f=composer().closest('form'); if(!f) throw new Error('composer: form missing'); return f; };
const controlLabel = e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g,' ').trim();
const send = () => unique(all('button',form()).filter(e => e.matches('[data-testid="send-button"], [type="submit"]:has(svg path[d^="M9.33467 16.6663"])') || ['Send','Send message','发送','发送消息','Envoyer','Envoyer le message'].includes(controlLabel(e))), 'send');
const model = () => unique(all('button[aria-haspopup="menu"]', form()).filter(e => e.getAttribute('data-testid')!=='composer-plus-btn' && e.getAttribute('data-composer-navigation-target')!=='add-context'), 'model-menu');
const modelMenu = () => {const m=model(); if(!m.id) throw new Error('model-menu: missing bound id'); return unique(all('[role="menu"]').filter(e=>e.getAttribute('aria-labelledby')===m.id),'model-menu content');};
const slider = () => {
 const menu=modelMenu(), controls=all('[data-reasoning-slider="true"]',menu);
 if(controls.length) {
  const control=unique(controls,'effort-slider control');
  // The live Power control hides its ARIA thumb from accessibility while
  // exposing the keyboard menuitem. Read only that visible control's thumb.
  return unique(Array.from(control.querySelectorAll('[role="slider"]')).filter(e=>e.getClientRects().length>0 && visible(e.parentElement)),'effort-slider');
 }
 return unique(all('[role="slider"]',menu),'effort-slider');
};
const coords = e => { if(disabled(e)) throw new Error(controlLabel(e)+': disabled'); e.scrollIntoView({block:'center',behavior:'instant'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit || (hit!==e&&!e.contains(hit)))throw new Error(controlLabel(e)+': control is covered');return {x,y}; };
// innerText adds layout-only blank lines between paragraphs and after Chrome's
// terminal empty div. Serialize editor line boundaries without trimming the
// prompt's real leading/trailing whitespace or collapsing blank paragraphs.
const editableText = root => {
 const block = n => n.nodeType===Node.ELEMENT_NODE && /^(DIV|P|LI|PRE|BLOCKQUOTE)$/.test(n.tagName);
 const read = node => {
  if(node.nodeType===Node.TEXT_NODE)return node.nodeValue;
  if(node.nodeType!==Node.ELEMENT_NODE)return '';
  if(node.tagName==='BR')return node.classList.contains('ProseMirror-trailingBreak')?'':'\n';
  const children=Array.from(node.childNodes);
  if(children.length===1 && children[0].nodeName==='BR')return '';
  let text='';
  children.forEach((child,i)=>{if(i>0&&(block(child)||block(children[i-1])))text+='\n';text+=read(child)});
  return text;
 };
 return read(root);
};
const draft = () => { const e=composer(); return 'value' in e ? e.value : editableText(e); };
const attachments = () => all('button').some(e=>/remove (file|attachment)|移除附件|删除附件/i.test(controlLabel(e)));
const currentID = () => { const m=location.pathname.match(/\/c\/([^/]+)/); return m ? decodeURIComponent(m[1]) : ''; };
const sidebarEntry = () => {
 const id=currentID(); if(!id) throw new Error('rename: conversation identity missing');
 const links=all('a[href]').filter(e=>{if((e.getAttribute('href')||'').startsWith('#'))return false;try{return new URL(e.href).pathname.endsWith('/c/'+encodeURIComponent(id)) || new URL(e.href).pathname.endsWith('/c/'+id)}catch{return false}});
 return unique(links,'conversation sidebar entry');
};
const options = () => {
 const id=currentID(); if(!id) throw new Error('rename: conversation identity missing');
 const direct=all('button[data-conversation-options-trigger],button[data-testid="conversation-options-button"]').filter(e=>e.getAttribute('data-conversation-options-trigger')===id || e.id==='conversation-options-'+id); if(direct.length) return unique(direct,'rename options');
 const link=sidebarEntry();
 const root=link.closest('[data-conversation-id]') || link.closest('[role="group"]') || link.closest('[data-sidebar-item]') || link.parentElement;
 const named=all('button',root).filter(e=>controlLabel(e)==='Chat actions');
 if(named.length)return unique(named,'rename options');
 return unique(all('button',root).filter(e=>e.matches('[aria-haspopup="menu"], [data-testid="conversation-options-button"]')),'rename options');
};
const renameMenu = () => { const o=options(); return unique(all('[role="menu"]').filter(e=>o.id && e.getAttribute('aria-labelledby')===o.id),'rename menu'); };
const rename = () => unique(all('[role="menuitem"]',renameMenu()).filter(e=>['Rename','Rename chat','重命名','重命名聊天','Renommer'].includes(controlLabel(e)) || e.querySelector('path[d^="M11.6258 3.30375"]') || Array.from(e.querySelectorAll('[style]')).some(n=>(n.getAttribute('style')||'').includes('M11.7313%204.20472'))),'rename');
const titleInput = () => unique(all('input[name="title-editor"], [role="dialog"][aria-modal="true"] form input:not([type]), [role="dialog"] input[type="text"]'),'rename input');
const blocked = () => { if(/^(Just a moment|Security Verification)/i.test(document.title) || all('iframe').some(e=>/cloudflare security challenge/i.test(e.title))) throw new Error('Human verification required'); if(location.hostname==='auth.openai.com' || all('button').some(e=>/^(Log in|登录)$/.test(controlLabel(e)))) throw new Error('Login required'); };
blocked();
