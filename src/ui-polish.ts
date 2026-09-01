const STYLE_ID = 'auto-codez-ui-polish';
const RECOVERY_ID = 'ac-ai-recovery';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .chat-item{position:relative;padding-right:64px!important}
    .chat-settings,.chat-delete{width:26px!important;height:26px!important;position:absolute;top:50%;transform:translateY(-50%);margin:0!important;border:0!important;border-radius:7px!important;background:transparent!important;font-size:0!important;opacity:0!important;transition:opacity .14s,background .14s,color .14s,transform .14s!important}
    .chat-settings{right:34px;color:#aeb7c4!important}
    .chat-delete{right:7px;color:#c76f78!important}
    .chat-item:hover .chat-settings,.chat-item:hover .chat-delete,.chat-settings:focus-visible,.chat-delete:focus-visible{opacity:1!important}
    .chat-settings:hover{background:#202630!important;color:#eef2f7!important;transform:translateY(-50%)!important}
    .chat-delete:hover{background:#382024!important;color:#f08b94!important;transform:translateY(-50%)!important}
    .chat-settings:before,.chat-delete:before{content:"";position:absolute;inset:6px;background:currentColor;mask-position:center;mask-size:contain;mask-repeat:no-repeat}
    .chat-settings:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 17.3V20h2.7l9.9-9.9-2.7-2.7L4 17.3Zm14.7-8.6a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.3 1.3 2.7 2.7 1.3-1.3Z'/%3E%3C/svg%3E")}
    .chat-delete:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M6 7h12l-.7 13H6.7L6 7Zm3-3h6l1 2H8l1-2Zm-5 2h16v2H4V6Zm5 4h2v7H9v-7Zm4 0h2v7h-2v-7Z'/%3E%3C/svg%3E")}
    .message.user{display:flex;flex-direction:column;align-items:flex-end}
    .message.user .message-label{align-self:flex-end}
    .message.user .message-content{max-width:min(78%,720px);text-align:left}
    .message.assistant,.message.tool{display:flex;flex-direction:column;align-items:flex-start}
    .message.assistant .message-content,.message.tool .message-content{max-width:78%}
    .message.streaming .message-label{display:flex;align-items:center;gap:7px}
    .message.streaming .message-label:before{content:"";width:7px;height:7px;border-radius:50%;background:#aeb9c8;box-shadow:0 0 0 4px #aeb9c812;animation:ac-pulse 1.2s ease-in-out infinite}
    .ac-thinking{display:inline-flex!important;align-items:center;gap:4px;min-height:28px}
    .ac-thinking-dot{width:4px;height:4px;border-radius:50%;background:#aeb9c8;animation:ac-thinking 1s ease-in-out infinite}
    .ac-thinking-dot:nth-child(2){animation-delay:.14s}.ac-thinking-dot:nth-child(3){animation-delay:.28s}
    @keyframes ac-thinking{0%,60%,100%{opacity:.22;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
    @keyframes ac-pulse{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}
    .activity-card.ac-hidden-while-thinking{display:none!important}
    .composer-hint{transition:opacity .18s}.composer-hint.ac-busy{opacity:.35}
    .intelligence-brain{filter:saturate(0)!important}

    .chat-header{position:relative}
    .chat-header h1{max-width:min(48vw,520px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .header-actions{align-items:center}
    .messages{scrollbar-gutter:stable both-edges;scroll-behavior:smooth}
    .empty-panel{margin:8px 2px;padding:18px 12px!important;border:1px solid #1b212b;border-radius:10px;background:#0f1319;color:#6d7785!important}
    .empty-panel:empty{display:none}
    .plugin-card{transition:border-color .16s,background .16s,transform .16s}
    .plugin-card:hover{border-color:#303845;background:linear-gradient(145deg,#131820,#0f1319);transform:translateY(-1px)}

    .api-key-manager-backdrop{animation:ac-backdrop-in .16s ease-out}
    .api-key-manager{animation:ac-dialog-in .18s ease-out}
    .api-key-manager-head{min-height:76px}
    .api-key-manager-toolbar{min-height:54px}
    .api-key-card{transition:border-color .16s,background .16s,transform .16s,box-shadow .16s}
    .api-key-card:hover{border-color:#303845;background:#131820;transform:translateY(-1px);box-shadow:0 8px 24px #0003}
    .api-key-card.active{box-shadow:inset 2px 0 #8f9baa}
    .api-key-empty{margin:8px 0;border:1px dashed #252d38;border-radius:10px;background:#0f1319}
    .api-key-manager-form.open{animation:ac-form-in .16s ease-out}
    .api-key-field input::placeholder{color:#4f5967}
    .api-key-field input:focus,.api-key-field select:focus{box-shadow:0 0 0 3px #56647622}
    .api-key-save:not(:disabled):hover{background:#f0f3f7;border-color:#707d8d}
    .api-key-cancel:hover{background:#171c24;color:#e4e9ef}

    .approval-card{border-color:#353d49!important;background:linear-gradient(145deg,#141922,#10141a)!important;box-shadow:0 10px 32px #0003}
    .approval-card button{transition:background .14s,border-color .14s,color .14s,transform .14s}
    .approval-card button:hover{transform:translateY(-1px)}
    .activity-card{transition:opacity .16s,transform .16s}
    .message.error,.message.system.error{border-color:#4b2b31!important;background:#171114!important}
    .message.error .message-content,.message.system.error .message-content{color:#e5b3b8}

    .ac-ai-recovery{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border:1px solid #343e4b;border-radius:9px;background:#12171e;color:#dfe5ed;font:500 10px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;white-space:nowrap;box-shadow:0 5px 18px #0002;transition:background .14s,border-color .14s,color .14s,transform .14s}
    .ac-ai-recovery:hover{background:#1a2029;border-color:#4a5666;color:#f3f6f9;transform:translateY(-1px)}
    .ac-ai-recovery:focus-visible{outline:2px solid #586577;outline-offset:2px}
    .ac-error-state{border-color:#4b3036!important;background:linear-gradient(145deg,#171317,#121014)!important}
    .ac-error-state .activity-heading{color:#d9b2b7!important}
    .ac-error-state .activity-line{color:#c9959c!important}

    @keyframes ac-backdrop-in{from{opacity:0}to{opacity:1}}
    @keyframes ac-dialog-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes ac-form-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}

    @media(max-width:700px){
      .message.user .message-content,.message.assistant .message-content,.message.tool .message-content{max-width:88%}
      .chat-item{padding-right:60px!important}.chat-settings{right:31px}.chat-delete{right:5px}
      .chat-header{padding:0 16px}.chat-header h1{max-width:42vw}.header-actions{gap:4px}.ac-ai-recovery{height:30px;padding:0 9px}
      .api-key-manager-backdrop{padding:14px}.api-key-manager{width:calc(100vw - 28px);max-height:calc(100vh - 28px);border-radius:13px}
    }
    @media(prefers-reduced-motion:reduce){
      .messages{scroll-behavior:auto}.api-key-manager-backdrop,.api-key-manager,.api-key-manager-form.open{animation:none}
      .plugin-card,.api-key-card,.approval-card button,.ac-ai-recovery{transition:none}.ac-thinking-dot,.message.streaming .message-label:before{animation:none}
    }
  `;
  document.head.appendChild(style);
}

function openApiKeyManager(): void {
  const button = document.querySelector<HTMLButtonElement>('.api-key-rail-button');
  button?.click();
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

function installThinkingIndicator(attempt = 0): void {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) {
    if (attempt < 20) window.setTimeout(() => installThinkingIndicator(attempt + 1), 50);
    return;
  }

  const observer = new MutationObserver(() => {
    const sendButton = document.querySelector<HTMLButtonElement>('.send-button');
    const busy = Boolean(sendButton?.disabled);
    const activity = messages.querySelector<HTMLElement>('.activity-card');
    const approval = messages.querySelector<HTMLElement>('.approval-card');
    const live = messages.querySelector<HTMLElement>('.message.streaming');

    if (!busy || live || approval) {
      activity?.classList.remove('ac-hidden-while-thinking');
      messages.querySelector('.ac-thinking')?.remove();
      document.querySelector('.composer-hint')?.classList.remove('ac-busy');
    } else {
      activity?.classList.add('ac-hidden-while-thinking');
      document.querySelector('.composer-hint')?.classList.add('ac-busy');
      if (!messages.querySelector('.ac-thinking')) {
        const indicator = document.createElement('article');
        indicator.className = 'message assistant ac-thinking';
        indicator.setAttribute('aria-label', 'A IA está respondendo');
        indicator.innerHTML = '<span class="ac-thinking-dot"></span><span class="ac-thinking-dot"></span><span class="ac-thinking-dot"></span>';
        messages.appendChild(indicator);
      }
      messages.scrollTop = messages.scrollHeight;
    }

    syncAiRecovery();
    syncErrorState();
  });

  observer.observe(messages, { childList: true, subtree: true });

  const headerObserver = new MutationObserver(syncAiRecovery);
  const header = document.querySelector<HTMLElement>('.chat-header');
  if (header) headerObserver.observe(header, { childList: true, subtree: true, characterData: true });

  syncAiRecovery();
  syncErrorState();
}

installStyle();
installThinkingIndicator();