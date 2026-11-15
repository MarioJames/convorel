switch(args.action) {
 case 'ready': { const e=composer(); if(disabled(e) || !(e.isContentEditable || e.tagName==='TEXTAREA')) throw new Error('composer: not editable'); return {url:location.href,id:currentID(),messages:messageNodesFor().length}; }
 case 'identity': return {url:location.href,id:currentID(),messages:messageNodesFor().map(e=>({id:messageId(e),role:messageRole(e)}))};
 case 'focus': { const e=composer(); if(disabled(e))throw new Error('composer: disabled'); if(draft()!=='')throw new Error('composer: existing draft'); e.focus(); return true; }
 case 'draft': return draft();
 case 'send': if(draft()!==args.prompt)throw new Error('composer: draft changed before click');return coords(send());
 case 'model': return {expanded:model().getAttribute('aria-expanded')==='true',label:[controlLabel(model()),model().innerText,model().getAttribute('data-model-id'),model().getAttribute('data-value')].join('|'),...coords(model())};
 case 'modelState': {
  const menu=modelMenu(), s=slider();
  for(const key of ['aria-valuemin','aria-valuemax','aria-valuenow']){const value=s.getAttribute(key);if(value===null||value.trim()===''||!Number.isInteger(Number(value)))throw new Error('effort-slider: invalid '+key)}
  const radios=all('[role="menuitemradio"]',menu), selected=radios.filter(e=>e.getAttribute('aria-checked')==='true' && controlLabel(e)!=='Pro');
  if(selected.length>1) throw new Error('model family: ambiguous');
  const values=Array.from(menu.querySelectorAll('[data-explicit-model]')).map(e=>e.getAttribute('data-explicit-model'));
  const latest=radios.filter(e=>['Latest','最新','Le plus récent'].includes(controlLabel(e)));
  if(latest.length>1) throw new Error('Latest: ambiguous');
  const family=selected.length===1 ? controlLabel(selected[0]) : '';
  const desc=[s.getAttribute('aria-valuetext'),s.getAttribute('aria-description'),...(s.getAttribute('aria-describedby')||s.closest('[aria-describedby]')?.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent)].filter(Boolean).join(' ');
  const r=s.getBoundingClientRect();
  return {min:Number(s.getAttribute('aria-valuemin')), max:Number(s.getAttribute('aria-valuemax')), value:Number(s.getAttribute('aria-valuenow')), description:desc, family, latest:latest.length===1?latest[0].getAttribute('aria-checked')==='true':values.length>0&&values.every(v=>v==='false'), disabled:disabled(s)||disabled(s.parentElement), x:r.x,y:r.y,width:r.width,height:r.height};
 }
 case 'familyState': {
  const menu=modelMenu(), radios=all('[role="menuitemradio"]',menu), selected=radios.filter(e=>e.getAttribute('aria-checked')==='true' && controlLabel(e)!=='Pro');
  const family=controlLabel(unique(selected,'model family'));
  const defaults=radios.filter(e=>['Latest','最新','Le plus récent'].includes(controlLabel(e)));
  if(defaults.length>1)throw new Error('Latest: ambiguous');
  const values=Array.from(menu.querySelectorAll('[data-explicit-model]')).map(e=>e.getAttribute('data-explicit-model'));
  return {family,latest:defaults.length===1?defaults[0].getAttribute('aria-checked')==='true':values.length>0&&values.every(v=>v==='false')};
 }
 case 'modelFamily': {
  const menu=modelMenu(), toggles=all('[data-model-picker-view-toggle="true"], [data-testid="composer-intelligence-picker-content"] [role="menuitem"][aria-expanded]',menu);
  if(toggles.length) return coords(unique(toggles,'model family toggle'));
  // Current advanced menus return to Power by selecting the already selected
  // family. Never guess another model or select a positional fallback.
  return coords(unique(all('[role="menuitemradio"][aria-checked="true"]',menu).filter(e=>controlLabel(e)!=='Pro'),'selected model family'));
 }
 case 'latest': return coords(unique(all('[role="menuitemradio"]',modelMenu()).filter(e=>['Latest','最新','Le plus récent'].includes(controlLabel(e))),'Latest'));
 case 'sliderFocus': {const s=slider(); if(disabled(s)||disabled(s.parentElement))throw new Error('effort-slider: disabled'); const target=s.closest('[role="menuitem"][tabindex]')||s; target.focus(); return true;}
 case 'snapshot': {
  const messages=messageNodesFor(); const generating=all('button').some(e=>e.matches('[data-testid="stop-button"], form[data-chatgpt-composer] button:has(svg path[d^="M4.5 5.75C4.5 5.05964"])') || ['Stop','Stop generating','Stop answering','停止','停止生成','中止','Arrêter'].includes(controlLabel(e)));
  const attachments=all('button').some(e=>/remove (file|attachment)|移除附件|删除附件/i.test(controlLabel(e)));
  return {url:location.href,conversationId:currentID(),generating,attachments,messages:messages.map(e=>({id:messageId(e),role:messageRole(e),text:messageText(e),model:e.getAttribute('data-message-model-slug')||'',final:messageRole(e)==='assistant'&&!generating&&messageCopies(e).filter(visible).length===1}))};
 }
 case 'options': return coords(options());
 case 'rename': return coords(rename());
 case 'titleFocus': { const e=titleInput(); e.focus(); e.select(); return true; }
 case 'titleValue': return titleInput().value;
 case 'titleSave': { const e=titleInput(); const f=e.closest('form'); if(f) { f.requestSubmit(); return true; } throw new Error('rename: save form missing'); }
 case 'sidebarTitle': return sidebarEntry().textContent.trim();
 case 'selfCheck': {
  const check=fn=>{try{fn();return {ok:true,count:1}}catch(e){const m=e.message.match(/got (\d+)/);return {ok:false,count:m?Number(m[1]):0,detail:e.message}}};
  return {composer:check(composer),send:check(send),modelMenu:check(model),effortSlider:check(()=>{const s=slider();if(Number(s.getAttribute('aria-valuemax'))-Number(s.getAttribute('aria-valuemin'))!==4)throw new Error('effort-slider: expected five positions')}),rename:check(rename)};
 }
 default: throw new Error('Unknown page action');
}
