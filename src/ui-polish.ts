const STYLE_ID = 'auto-codez-ui-polish';
const RECOVERY_ID = 'ac-ai-recovery';
const APP_SETTINGS_ID = 'ac-app-settings';
const APP_SETTINGS_MODAL_ID = 'ac-app-settings-modal';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .chat-item { position:relative; padding-right:64px !important; }
    .chat-settings,.chat-delete { width:26px !important; height:26px !important; position:absolute; top:50%; transform:translateY(-50%); margin:0 !important; border:0 !important; border-radius:7px !important; background:transparent !important; font-size:0 !important; opacity:0 !important; transition:opacity .14s,background .14s,color .14s !important; }
    .chat-settings { right:34px; color:#aeb7c4 !important; }
    .chat-delete { right:7px; color:#c76f78 !important; }
    .chat-item:hover .chat-settings,.chat-item:hover .chat-delete,.chat-settings:focus-visible,.chat-delete:focus-visible { opacity:1 !important; }
    .chat-settings:before,.chat-delete:before { content:""; position:absolute; inset:6px; background:currentColor; mask-position:center; mask-size:contain; mask-repeat:no-repeat; }
    .chat-settings:before { mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 17.3V20h2.7l9.9-9.9-2.7-2.7-9.9 9.9Zm14.7-8.6a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.3 1.3 2.7 2.7 1.3-1.3Z'/%3E%3C/svg%3E"); }
    .chat-delete:before { mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M6 7h12l-.7 13H6.7L6 7Zm3-3h6l1 2H8l1-2Zm-5 2h16v2H4V6Zm5 4h2v7H9v-7Zm4 0h2v7h-2v-7Z'/%3E%3C/svg%3E"); }
    .message.streaming .message-label { display:flex; align-items:center; gap:7px; }
    .message.streaming .message-label:before { content:""; width:6px; height:6px; border-radius:50%; background:#aeb9c8; box-shadow:0 0 0 4px #aeb9c812; animation:ac-pulse 1.2s ease-in-out infinite; }
    .composer-hint.ac-busy { opacity:.35; }
    .chat-header { position:relative; }
    .chat-header h1 { max-width:min(48vw,520px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .header-actions { align-items:center; }
    .empty-panel { margin:8px 2px; padding:18px 12px !important; border:1px solid #1b212b; border-radius:10px; background:#0f1319; color:#6d7785 !important; }
    .empty-panel:empty { display:none; }
    .plugin-card { transition:border-color .16s,background .16s,transform .16s; }
    .plugin-card:hover { border-color:#303845; background:linear-gradient(145deg,#131820,#0f1319); transform:translateY(-1px); }

    /* Real Lucide geometry. These override the older hand-drawn Git and brand icons. */
    .git-icon { width:17px !important; height:17px !important; position:relative !important; border:0 !important; border-radius:0 !important; background:currentColor !important; opacity:.9 !important; -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 6a9 9 0 0 0-9 9V3'/%3E%3Ccircle cx='18' cy='6' r='3'/%3E%3Ccircle cx='6' cy='18' r='3'/%3E%3C/svg%3E") center/contain no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 6a9 9 0 0 0-9 9V3'/%3E%3Ccircle cx='18' cy='6' r='3'/%3E%3Ccircle cx='6' cy='18' r='3'/%3E%3C/svg%3E") center/contain no-repeat !important; }
    .git-icon:before,.git-icon:after { display:none !important; }

    .brand-mark { border:0 !important; border-radius:7px !important; background:#e8edf3 !important; box-shadow:none !important; -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m18 16 4-4-4-4'/%3E%3Cpath d='m6 8-4 4 4 4'/%3E%3Cpath d='m14.5 4-5 16'/%3E%3C/svg%3E") center/19px 19px no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m18 16 4-4-4-4'/%3E%3Cpath d='m6 8-4 4 4 4'/%3E%3Cpath d='m14.5 4-5 16'/%3E%3C/svg%3E") center/19px 19px no-repeat !important; }
    .brand-mark:before,.brand-mark:after { display:none !important; }

    /* Lucide Sparkles replaces the old brain glyph for the reasoning control. */
    .intelligence-brain { width:16px !important; height:16px !important; background:currentColor !important; filter:none !important; -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z'/%3E%3Cpath d='M5 3v4'/%3E%3Cpath d='M19 17v4'/%3E%3Cpath d='M3 5h4'/%3E%3Cpath d='M17 19h4'/%3E%3C/svg%3E") center/contain no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1-1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z'/%3E%3Cpath d='M5 3v4'/%3E%3Cpath d='M19 17v4'/%3E%3Cpath d='M3 5h4'/%3E%3Cpath d='M17 19h4'/%3E%3C/svg%3E") center/contain no-repeat !important; }

    /* Consolidated top actions. Chat and AI configuration stay in their dedicated places. */
    .topbar-actions > [data-action="new-chat"],
    .topbar-actions > [data-action="ai-settings"] { display:none !important; }
    #${APP_SETTINGS_ID} { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:0; border:0; border-radius:9px; color:#aeb7c4; background:transparent; cursor:pointer; }
    #${APP_SETTINGS_ID}:hover { color:#eef2f6; background:#171d26; }
    #${APP_SETTINGS_ID}:before { content:""; width:17px; height:17px; background:currentColor; -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z'/%3E%3Cpath d='m19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.5 1.5-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.12v-.4a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.5-1.5.06-.06A1.7 1.7 0 0 0 9.2 15a1.7 1.7 0 0 0-1.56-1.03H7.2v-2.12h.44A1.7 1.7 0 0 0 9.2 10.8a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.5-1.5.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.27 6.2V6h2.12v.2a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.5 1.5-.06.06A1.7 1.7 0 0 0 19.46 10.8a1.7 1.7 0 0 0 1.54 1.05h.2v2.12h-.2A1.7 1.7 0 0 0 19.4 15Z'/%3E%3C/svg%3E") center/contain no-repeat; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z'/%3E%3Cpath d='m19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.5 1.5-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.12v-.4a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.5-1.5.06-.06A1.7 1.7 0 0 0 9.2 15a1.7 1.7 0 0 0-1.56-1.03H7.2v-2.12h.44A1.7 1.7 0 0 0 9.2 10.8a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.5-1.5.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.27 6.2V6h2.12v.2a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.5 1.5-.06.06A1.7 1.7 0 0 0 19.46 10.8a1.7 1.7 0 0 0 1.54 1.05h.2v2.12h-.2A1.7 1.7 0 0 0 19.4 15Z'/%3E%3C/svg%3E") center/contain no-repeat; }

    /* Remove the duplicate chat gear. The provider chip remains the chat settings entry point. */
    .chat-title-row .gear { display:none !important; }

    /* Lucide navigation icons. */
    .rail-button, .new-item-icon, .plugin-card-icon, .attach-button, .send-button { background-color:currentColor !important; }
    .rail-button[data-panel="plugins"] { -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='7' height='7' x='3' y='3' rx='1'/%3E%3Crect width='7' height='7' x='14' y='3' rx='1'/%3E%3Crect width='7' height='7' x='14' y='14' rx='1'/%3E%3Crect width='7' height='7' x='3' y='14' rx='1'/%3E%3C/svg%3E") center/18px 18px no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='7' height='7' x='3' y='3' rx='1'/%3E%3Crect width='7' height='7' x='14' y='3' rx='1'/%3E%3Crect width='7' height='7' x='14' y='14' rx='1'/%3E%3Crect width='7' height='7' x='3' y='14' rx='1'/%3E%3C/svg%3E") center/18px 18px no-repeat !important; }
    .new-chat-icon { width:18px !important; height:18px !important; -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.5'/%3E%3Cpath d='M16 5h6'/%3E%3Cpath d='M19 2v6'/%3E%3Cpath d='M8 12h8'/%3E%3Cpath d='M8 16h5'/%3E%3C/svg%3E") center/contain no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.5'/%3E%3Cpath d='M16 5h6'/%3E%3Cpath d='M19 2v6'/%3E%3Cpath d='M8 12h8'/%3E%3Cpath d='M8 16h5'/%3E%3C/svg%3E") center/contain no-repeat !important; }
    .attach-button { -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12h14'/%3E%3Cpath d='M12 5v14'/%3E%3C/svg%3E") center/18px 18px no-repeat !important; mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12h14'/%3E%3Cpath d='M12 5v14'/%3E%3C/svg%3E") center/18px 18px no-repeat !important; }

    #${APP_SETTINGS_MODAL_ID} { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.52); padding:24px; }
    #${APP_SETTINGS_MODAL_ID}[hidden] { display:none; }
    .ac-app-settings-dialog { width:min(560px,100%); border:1px solid #2a313d; border-radius:14px; background:#10151c; color:#e8edf3; box-shadow:0 24px 70px rgba(0,0,0,.45); overflow:hidden; }
    .ac-app-settings-head { display:flex; align-items:center; justify-content:space-between; padding:18px 20px; border-bottom:1px solid #202731; }
    .ac-app-settings-head h2 { margin:0; font-size:16px; font-weight:650; }
    .ac-app-settings-close { width:30px; height:30px; border:0; border-radius:8px; background:transparent; color:#8f9aaa; font-size:20px; cursor:pointer; }
    .ac-app-settings-close:hover { background:#1a2029; color:#eef2f6; }
    .ac-app-settings-body { padding:20px; color:#98a3b2; font-size:13px; line-height:1.55; }
    .ac-app-settings-section { padding:12px 0; border-top:1px solid #202731; }
    .ac-app-settings-section:first-child { border-top:0; padding-top:0; }
    .ac-app-settings-section strong { display:block; color:#dce2e9; margin-bottom:4px; }

    @keyframes ac-pulse { 0%,100%{opacity:.45;transform:scale(.9)} 50%{opacity:1;transform:scale(1)} }
    @media(prefers-reduced-motion:reduce){ .message.streaming .message-label:before{animation:none} }
  `;
  document.head.appendChild(style);
}

function openApiKeyManager(): void {
  document.querySelector<HTMLButtonElement>('.api-key-rail-button')?.click();
}

function openAppSettings(): void {
  let modal = document.getElementById(APP_SETTINGS_MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = APP_SETTINGS_MODAL_ID;
    modal.hidden = true;
    modal.innerHTML = `<div class="ac-app-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ac-app-settings-title"><div class="ac-app-settings-head"><h2 id="ac-app-settings-title">Configurações do aplicativo</h2><button class="ac-app-settings-close" type="button" aria-label="Fechar">×</button></div><div class="ac-app-settings-body"><div class="ac-app-settings-section"><strong>Auto CodeZ</strong><span>As configurações gerais do aplicativo ficarão concentradas neste painel.</span></div><div class="ac-app-settings-section"><strong>Próximas configurações</strong><span>Aparência, comportamento, editor, notificações e outras preferências serão adicionadas aqui.</span></div></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal || (event.target as HTMLElement).closest('.ac-app-settings-close')) modal!.hidden = true;
    });
  }
  modal.hidden = false;
}

function ensureAppSettingsButton(): void {
  const actions = document.querySelector<HTMLElement>('.topbar-actions');
  if (!actions || document.getElementById(APP_SETTINGS_ID)) return;
  const button = document.createElement('button');
  button.id = APP_SETTINGS_ID;
  button.type = 'button';
  button.title = 'Configurações do aplicativo';
  button.setAttribute('aria-label', 'Configurações do aplicativo');
  button.addEventListener('click', openAppSettings);
  actions.appendChild(button);
}

function removeDuplicateChatGear(): void {
  document.querySelectorAll<HTMLElement>('.chat-title-row .gear').forEach((element) => element.remove());
}

function removeReasoningProfileFromChatSettings(): void {
  const modalRoot = document.querySelector<HTMLElement>('#modal-root');
  if (!modalRoot) return;
  const candidates = Array.from(modalRoot.querySelectorAll<HTMLElement>('label, .field, .form-field, .setting-row, .setting-field, .modal-field, .modal-row'));
  for (const element of candidates) {
    const text = element.textContent?.trim().toLowerCase() ?? '';
    if (text.includes('perfil de raciocínio') || text.includes('perfil de raciocinio')) element.remove();
  }
}

function syncAiRecovery(): void {
  const header = document.querySelector<HTMLElement>('.chat-header');
  if (!header) return;
  const providerChip = header.querySelector<HTMLElement>('.provider-chip');
  const providerText = providerChip?.textContent?.trim().toLowerCase() ?? '';
  const isUnconfigured = providerText.includes('ia não configurada');
  let recovery = header.querySelector<HTMLButtonElement>(`#${RECOVERY_ID}`);

  if (!isUnconfigured) {
    recovery?.remove();
    return;
  }

  if (!recovery) {
    recovery = document.createElement('button');
    recovery.id = RECOVERY_ID;
    recovery.className = 'ac-ai-recovery';
    recovery.type = 'button';
    recovery.textContent = 'Configurar IA';
    recovery.title = 'Adicionar ou selecionar uma API key';
    recovery.addEventListener('click', openApiKeyManager);
    header.querySelector('.header-actions')?.prepend(recovery);
  }
}

function syncErrorState(): void {
  const activity = document.querySelector<HTMLElement>('#messages .activity-card');
  if (!activity) return;
  const hasError = Boolean(activity.querySelector('.activity-line.error'));
  activity.classList.toggle('ac-error-state', hasError);
}

function initialize(): void {
  installStyle();
  ensureAppSettingsButton();
  syncAiRecovery();
  syncErrorState();
  removeDuplicateChatGear();
  removeReasoningProfileFromChatSettings();

  const header = document.querySelector<HTMLElement>('.chat-header');
  if (header) new MutationObserver(() => { syncAiRecovery(); removeDuplicateChatGear(); }).observe(header, { childList:true, subtree:true, characterData:true });

  const messages = document.querySelector<HTMLElement>('#messages');
  if (messages) new MutationObserver(syncErrorState).observe(messages, { childList:true, subtree:true });

  const modalRoot = document.querySelector<HTMLElement>('#modal-root');
  if (modalRoot) new MutationObserver(removeReasoningProfileFromChatSettings).observe(modalRoot, { childList:true, subtree:true, characterData:true });

  new MutationObserver(ensureAppSettingsButton).observe(document.body, { childList:true, subtree:true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once:true });
else initialize();
