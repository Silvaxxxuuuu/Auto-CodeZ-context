const STYLE_ID = 'auto-codez-ui-polish';
const RECOVERY_ID = 'ac-ai-recovery';

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
    .chat-settings:before { mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 17.3V20h2.7l9.9-9.9-2.7-2.7L4 17.3Zm14.7-8.6a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.3 1.3 2.7 2.7 1.3-1.3Z'/%3E%3C/svg%3E"); }
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

    @keyframes ac-pulse { 0%,100%{opacity:.45;transform:scale(.9)} 50%{opacity:1;transform:scale(1)} }
    @media(prefers-reduced-motion:reduce){ .message.streaming .message-label:before{animation:none} }
  `;
  document.head.appendChild(style);
}

function openApiKeyManager(): void {
  document.querySelector<HTMLButtonElement>('.api-key-rail-button')?.click();
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
  syncAiRecovery();
  syncErrorState();

  const header = document.querySelector<HTMLElement>('.chat-header');
  if (header) new MutationObserver(syncAiRecovery).observe(header, { childList:true, subtree:true, characterData:true });

  const messages = document.querySelector<HTMLElement>('#messages');
  if (messages) new MutationObserver(syncErrorState).observe(messages, { childList:true, subtree:true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once:true });
else initialize();
