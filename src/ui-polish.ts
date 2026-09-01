const STYLE_ID = 'auto-codez-ui-polish';
const RECOVERY_ID = 'ac-ai-recovery';
const APP_SETTINGS_ID = 'ac-app-settings';
const APP_SETTINGS_MODAL_ID = 'ac-app-settings-modal';

type IconName = 'message-circle' | 'message-circle-plus' | 'folder' | 'blocks' | 'git-branch' | 'square-terminal' | 'key-round' | 'plus' | 'sparkles' | 'settings' | 'user-round' | 'code-2' | 'pencil' | 'trash-2' | 'chevron-down' | 'chevron-up' | 'info' | 'x' | 'send';

const ICON_PATHS: Record<IconName, string[]> = {
  'message-circle': ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  'message-circle-plus': ['M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719', 'M8 12h8', 'M12 8v8'],
  folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
  blocks: ['M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2', 'M14 2h8v8h-8z'],
  'git-branch': ['M6 3v12', 'M18 9V3', 'M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M18 3a3 3 0 1 0 0 6 3 3 0 0 0-6Z', 'M6 15c0-3 3-6 9-6'],
  'square-terminal': ['m7 11 3 3-3 3', 'm13 17 4 0', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  'key-round': ['M15.5 7.5 19 4', 'M17 6l2 2', 'M11 14a5 5 0 1 1-1-7.9A5 5 0 0 1 11 14Z', 'M16 8l-5 5'],
  plus: ['M5 12h14', 'M12 5v14'],
  sparkles: ['m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z', 'M5 3v4', 'M19 17v4', 'M3 5h4', 'M17 19h4'],
  settings: ['M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6'],
  'user-round': ['M20 21a8 8 0 0 0-16 0', 'M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
  'code-2': ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16'],
  pencil: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
  'trash-2': ['M3 6h18', 'M8 6V4h8v2', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M10 11v6', 'M14 11v6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  info: ['M12 16v-4', 'M12 8h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13'],
};

function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ac-lucide-icon');
  svg.dataset.acLucideIcon = name;
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .chat-item{position:relative;padding-right:64px!important}
    .chat-settings,.chat-delete{width:26px!important;height:26px!important;position:absolute;top:50%;transform:translateY(-50%);margin:0!important;border:0!important;border-radius:7px!important;background:transparent!important;font-size:0!important;opacity:0!important}
    .chat-settings{right:34px;color:#aeb7c4!important}.chat-delete{right:7px;color:#c76f78!important}
    .chat-item:hover .chat-settings,.chat-item:hover .chat-delete,.chat-settings:focus-visible,.chat-delete:focus-visible{opacity:1!important}
    .message.streaming .message-label{display:flex;align-items:center;gap:7px}.message.streaming .message-label:before{content:"";width:6px;height:6px;border-radius:50%;background:#aeb9c8;box-shadow:0 0 0 4px #aeb9c812;animation:ac-pulse 1.2s ease-in-out infinite}
    .composer-hint.ac-busy{opacity:.35}.chat-header{position:relative}.chat-header h1{max-width:min(48vw,520px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.header-actions{align-items:center}
    .empty-panel{margin:8px 2px;padding:18px 12px!important;border:1px solid #1b212b;border-radius:10px;background:#0f1319;color:#6d7785!important}.empty-panel:empty{display:none}
    .plugin-card{transition:border-color .16s,background .16s,transform .16s}.plugin-card:hover{border-color:#303845;background:linear-gradient(145deg,#131820,#0f1319);transform:translateY(-1px)}
    .ac-lucide-icon{display:block;width:18px;height:18px;min-width:18px;min-height:18px;flex:0 0 18px;overflow:visible;color:currentColor;stroke:currentColor;fill:none;stroke-width:2;pointer-events:none}
    .ac-lucide-icon path,.ac-lucide-icon circle,.ac-lucide-icon line,.ac-lucide-icon polyline,.ac-lucide-icon polygon,.ac-lucide-icon rect{vector-effect:non-scaling-stroke}
    .rail-button{display:inline-flex!important;align-items:center!important;justify-content:center!important;color:inherit!important}
    .rail-button:before,.rail-button:after,.chat-settings:before,.chat-settings:after,.chat-delete:before,.chat-delete:after,.gear:before,.gear:after,.new-chat-icon:before,.new-chat-icon:after,.new-folder-icon:before,.new-folder-icon:after,.project-folder-icon:before,.project-folder-icon:after,.plugin-card-icon:before,.plugin-card-icon:after,.attach-button:before,.attach-button:after,.send-button:before,.send-button:after,.intelligence-brain:before,.intelligence-brain:after,.provider-chevron:before,.provider-chevron:after,.intelligence-chevron:before,.intelligence-chevron:after,.modal-close:before,.modal-close:after,.info-button:before,.info-button:after,.info-card-icon:before,.info-card-icon:after,.brand-mark:before,.brand-mark:after,.top-action[data-action="settings"]:before,.top-action[data-action="settings"]:after{content:none!important;display:none!important;background:none!important;mask:none!important;-webkit-mask:none!important}
    .rail-button .ac-lucide-icon{width:17px;height:17px;min-width:17px;min-height:17px;flex-basis:17px}
    .new-chat-icon,.new-folder-icon,.project-folder-icon,.plugin-card-icon,.git-icon,.terminal-icon,.attach-button,.send-button,.intelligence-brain,.provider-chevron,.intelligence-chevron,.info-button,.info-card-icon,.modal-close,.chat-settings,.chat-delete,.gear,.brand-mark{display:inline-flex!important;align-items:center!important;justify-content:center!important;position:relative!important;background:none!important;-webkit-mask:none!important;mask:none!important}
    .new-chat-icon .ac-lucide-icon,.new-folder-icon .ac-lucide-icon,.project-folder-icon .ac-lucide-icon,.plugin-card-icon .ac-lucide-icon,.git-icon .ac-lucide-icon,.terminal-icon .ac-lucide-icon,.attach-button .ac-lucide-icon,.send-button .ac-lucide-icon,.intelligence-brain .ac-lucide-icon,.provider-chevron .ac-lucide-icon,.intelligence-chevron .ac-lucide-icon,.info-button .ac-lucide-icon,.info-card-icon .ac-lucide-icon,.modal-close .ac-lucide-icon,.chat-settings .ac-lucide-icon,.chat-delete .ac-lucide-icon,.gear .ac-lucide-icon,.brand-mark .ac-lucide-icon{width:16px;height:16px;min-width:16px;min-height:16px;flex:0 0 16px}
    .attach-button .ac-lucide-icon,.send-button .ac-lucide-icon{width:18px;height:18px;min-width:18px;min-height:18px;flex-basis:18px}
    .intelligence-brain .ac-lucide-icon{width:16px;height:16px;min-width:16px;min-height:16px;flex-basis:16px}
    .provider-chevron,.intelligence-chevron{width:16px!important;height:16px!important;min-width:16px!important;min-height:16px!important;flex:0 0 16px!important;transform:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;border:0!important}
    .provider-chevron .ac-lucide-icon,.intelligence-chevron .ac-lucide-icon{width:14px!important;height:14px!important;min-width:14px!important;min-height:14px!important;flex:0 0 14px!important}
    .intelligence-button.open .intelligence-chevron{transform:none!important}
    .api-key-rail-button{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:38px!important;height:38px!important;border:0!important;background:transparent!important;position:relative!important;color:#626c7b!important}
    .api-key-rail-button:hover{background:#151a22!important;color:#dce3ec!important}
    .api-key-rail-button .ac-lucide-icon{width:17px!important;height:17px!important;min-width:17px!important;min-height:17px!important;flex:0 0 17px!important}
    .send-button{display:inline-flex!important;align-items:center!important;justify-content:center!important;visibility:visible!important;width:36px!important;height:36px!important;min-width:36px!important;min-height:36px!important;color:#dfe6ef!important}
    .send-button .ac-lucide-icon{opacity:1!important;visibility:visible!important}
    .send-button:disabled{opacity:.42!important}
    .brand-mark{width:25px!important;height:25px!important;border:0!important;box-shadow:none!important;border-radius:7px!important;background:transparent!important;color:#e8edf3!important}
    .brand-mark .ac-lucide-icon{width:19px;height:19px;min-width:19px;min-height:19px;flex-basis:19px}
    .git-icon{width:17px!important;height:17px!important;border:0!important;border-radius:0!important;color:inherit!important;opacity:.9!important}
    .topbar-actions>[data-action="new-chat"],.topbar-actions>[data-action="ai-settings"]{display:none!important}
    #${APP_SETTINGS_ID}{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;border-radius:9px;color:#aeb7c4;background:transparent;cursor:pointer}
    #${APP_SETTINGS_ID}:hover{color:#eef2f6;background:#171d26}#${APP_SETTINGS_ID} .ac-lucide-icon{width:17px;height:17px;min-width:17px;min-height:17px;flex-basis:17px}
    .chat-title-row .gear{display:none!important}
    #${APP_SETTINGS_MODAL_ID}{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.52);padding:24px}
    #${APP_SETTINGS_MODAL_ID}[hidden]{display:none}.ac-app-settings-dialog{width:min(560px,100%);border:1px solid #2a313d;border-radius:14px;background:#10151c;color:#e8edf3;box-shadow:0 24px 70px rgba(0,0,0,.45);overflow:hidden}
    .ac-app-settings-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #202731}.ac-app-settings-head h2{margin:0;font-size:16px;font-weight:650}
    .ac-app-settings-close{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#8f9aaa;font-size:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
    .ac-app-settings-close:hover{background:#1a2029;color:#eef2f6}.ac-app-settings-body{padding:20px;color:#98a3b2;font-size:13px;line-height:1.55}
    .ac-app-settings-section{padding:12px 0;border-top:1px solid #202731}.ac-app-settings-section:first-child{border-top:0;padding-top:0}.ac-app-settings-section strong{display:block;color:#dce2e9;margin-bottom:4px}
    @keyframes ac-pulse{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}@media(prefers-reduced-motion:reduce){.message.streaming .message-label:before{animation:none}}
  `;
  document.head.appendChild(style);
}

function openApiKeyManager(): void { document.querySelector<HTMLButtonElement>('.api-key-rail-button')?.click(); }

function openAppSettings(): void {
  let modal=document.getElementById(APP_SETTINGS_MODAL_ID);
  if(!modal){
    modal=document.createElement('div');
    modal.id=APP_SETTINGS_MODAL_ID;
    modal.hidden=true;
    modal.innerHTML='<div class="ac-app-settings-dialog" role="dialog" aria-modal="true"><div class="ac-app-settings-head"><h2>Configurações do aplicativo</h2><button class="ac-app-settings-close" type="button" aria-label="Fechar"></button></div><div class="ac-app-settings-body"><div class="ac-app-settings-section"><strong>Auto CodeZ</strong><span>As configurações gerais do aplicativo ficarão concentradas neste painel.</span></div><div class="ac-app-settings-section"><strong>Próximas configurações</strong><span>Aparência, comportamento, editor, notificações e outras preferências serão adicionadas aqui.</span></div></div></div>';
    document.body.appendChild(modal);
    const closeButton=modal.querySelector<HTMLButtonElement>('.ac-app-settings-close');
    closeButton?.appendChild(icon('x',16));
    modal.addEventListener('click',(event)=>{if(event.target===modal||(event.target as HTMLElement).closest('.ac-app-settings-close')) modal!.hidden=true;});
  }
  modal.hidden=false;
}

function ensureAppSettingsButton(): void {
  const actions=document.querySelector<HTMLElement>('.topbar-actions');
  if(!actions||document.getElementById(APP_SETTINGS_ID))return;
  const button=document.createElement('button');
  button.id=APP_SETTINGS_ID;
  button.type='button';
  button.title='Configurações do aplicativo';
  button.setAttribute('aria-label','Configurações do aplicativo');
  button.appendChild(icon('settings',17));
  button.addEventListener('click',openAppSettings);
  actions.appendChild(button);
}

function replaceIcon(element: Element,name: IconName,size=18): void {
  const target=element as HTMLElement;
  const existing=target.querySelector<SVGSVGElement>(':scope > .ac-lucide-icon');
  if(existing?.dataset.acLucideIcon===name)return;
  target.querySelectorAll(':scope > *').forEach(child=>child.remove());
  target.appendChild(icon(name,size));
}

function syncLucideIcons(): void {
  document.querySelectorAll<HTMLElement>('.rail-button').forEach(button=>{
    const panel=button.getAttribute('data-panel');
    const action=button.getAttribute('data-action');
    let name: IconName | undefined;
    if(panel==='plugins') name='blocks';
    else if(panel==='projects') name='folder';
    else if(panel==='chats') name='message-circle';
    else if(action==='profile') name='user-round';
    else if(button.classList.contains('terminal-rail-button')) name='square-terminal';
    if(name) replaceIcon(button,name,17);
  });
  document.querySelectorAll<HTMLElement>('.api-key-rail-button').forEach(button=>replaceIcon(button,'key-round',17));
  document.querySelectorAll<HTMLElement>('.new-chat-icon').forEach(element=>replaceIcon(element,'message-circle-plus'));
  document.querySelectorAll<HTMLElement>('.new-folder-icon,.project-folder-icon').forEach(element=>replaceIcon(element,'folder',16));
  document.querySelectorAll<HTMLElement>('.plugin-card-icon').forEach(element=>replaceIcon(element,'blocks',17));
  document.querySelectorAll<HTMLElement>('.attach-button').forEach(element=>replaceIcon(element,'plus',18));
  document.querySelectorAll<HTMLElement>('.send-button').forEach(element=>replaceIcon(element,'send',18));
  document.querySelectorAll<HTMLElement>('.intelligence-brain').forEach(element=>replaceIcon(element,'sparkles',16));
  document.querySelectorAll<HTMLElement>('.git-icon').forEach(element=>replaceIcon(element,'git-branch',17));
  document.querySelectorAll<HTMLElement>('.terminal-icon').forEach(element=>replaceIcon(element,'square-terminal',17));
  document.querySelectorAll<HTMLElement>('.chat-settings').forEach(element=>replaceIcon(element,'pencil',16));
  document.querySelectorAll<HTMLElement>('.chat-delete').forEach(element=>replaceIcon(element,'trash-2',16));
  document.querySelectorAll<HTMLElement>('.provider-chevron').forEach(element=>replaceIcon(element,'chevron-down',12));
  document.querySelectorAll<HTMLElement>('.intelligence-chevron').forEach(element=>{
    const open=element.closest('.intelligence-button')?.classList.contains('open') ?? false;
    replaceIcon(element,open?'chevron-up':'chevron-down',12);
  });
  document.querySelectorAll<HTMLElement>('.modal-close,.ac-app-settings-close').forEach(element=>replaceIcon(element,'x',16));
  document.querySelectorAll<HTMLElement>('.info-button,.info-card-icon').forEach(element=>replaceIcon(element,'info',16));
  document.querySelectorAll<HTMLElement>('.brand-mark').forEach(element=>replaceIcon(element,'code-2',19));
}

function removeDuplicateChatGear(): void { document.querySelectorAll<HTMLElement>('.chat-title-row .gear').forEach(element=>element.remove()); }

function removeReasoningProfileFromChatSettings(): void {
  const modalRoot=document.querySelector<HTMLElement>('#modal-root');
  if(!modalRoot)return;
  for(const element of Array.from(modalRoot.querySelectorAll<HTMLElement>('label,.field,.form-field,.setting-row,.setting-field,.modal-field,.modal-row'))){
    const text=element.textContent?.trim().toLowerCase()??'';
    if(text.includes('perfil de raciocínio')||text.includes('perfil de raciocinio'))element.remove();
  }
}

function syncAiRecovery(): void {
  const header=document.querySelector<HTMLElement>('.chat-header');
  if(!header)return;
  const providerText=header.querySelector<HTMLElement>('.provider-chip')?.textContent?.trim().toLowerCase()??'';
  const isUnconfigured=providerText.includes('ia não configurada');
  let recovery=header.querySelector<HTMLButtonElement>(`#${RECOVERY_ID}`);
  if(!isUnconfigured){recovery?.remove();return;}
  if(!recovery){
    recovery=document.createElement('button');
    recovery.id=RECOVERY_ID;
    recovery.className='ac-ai-recovery';
    recovery.type='button';
    recovery.textContent='Configurar IA';
    recovery.title='Adicionar ou selecionar uma API key';
    recovery.addEventListener('click',openApiKeyManager);
    header.querySelector('.header-actions')?.prepend(recovery);
  }
}

function syncErrorState(): void {
  const activity=document.querySelector<HTMLElement>('#messages .activity-card');
  if(!activity)return;
  activity.classList.toggle('ac-error-state',Boolean(activity.querySelector('.activity-line.error')));
}

function initialize(): void {
  installStyle();
  ensureAppSettingsButton();
  syncLucideIcons();
  syncAiRecovery();
  syncErrorState();
  removeDuplicateChatGear();
  removeReasoningProfileFromChatSettings();
  const header=document.querySelector<HTMLElement>('.chat-header');
  if(header)new MutationObserver(()=>{syncAiRecovery();removeDuplicateChatGear();syncLucideIcons();}).observe(header,{childList:true,subtree:true,characterData:true});
  const messages=document.querySelector<HTMLElement>('#messages');
  if(messages)new MutationObserver(syncErrorState).observe(messages,{childList:true,subtree:true});
  const modalRoot=document.querySelector<HTMLElement>('#modal-root');
  if(modalRoot)new MutationObserver(()=>{removeReasoningProfileFromChatSettings();syncLucideIcons();}).observe(modalRoot,{childList:true,subtree:true,characterData:true});
  new MutationObserver(()=>{ensureAppSettingsButton();syncLucideIcons();}).observe(document.body,{childList:true,subtree:true});
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true}); else initialize();