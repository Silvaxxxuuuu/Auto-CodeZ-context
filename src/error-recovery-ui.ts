const STYLE_ID = 'auto-codez-error-recovery-ui';
const PANEL_ID = 'auto-codez-error-recovery';
let lastRecoverySignature = '';
let recoveryFrame = 0;

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .welcome{max-width:720px;margin:auto;padding:clamp(30px,8vh,84px) 20px 48px;text-align:center}
    .welcome-mark{width:58px;height:58px;margin:0 auto 20px;border:1px solid #303742;border-radius:18px;background:#11151b;display:grid;place-items:center;box-shadow:0 14px 34px #0004}
    .welcome-mark-eye{width:19px;height:19px;border:2px solid #9da7b4;border-radius:50%;position:relative;display:block}
    .welcome-mark-eye:after{content:'';position:absolute;width:5px;height:5px;left:5px;top:5px;border-radius:50%;background:#9da7b4}
    .welcome h2{margin:0;color:#e5e9ee;font-size:20px;letter-spacing:-.025em}
    .welcome p{max-width:520px;margin:9px auto 24px;color:#7f8996;font-size:11px;line-height:1.65}
    .welcome-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;text-align:left}
    .welcome-grid button{min-height:54px;padding:10px 12px;border:1px solid #272e37;border-radius:10px;background:#10141a;color:#aeb7c2;font:500 10px Inter,ui-sans-serif,system-ui,sans-serif;text-align:left;cursor:pointer;transition:background .14s,border-color .14s,transform .14s}
    .welcome-grid button:hover{background:#161b22;border-color:#3c4652;transform:translateY(-1px)}
    .welcome-grid button:focus-visible{outline:2px solid #586577;outline-offset:2px}
    .ac-recovery-panel{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:10px;padding:11px 12px;border:1px solid #3a2b30;border-radius:9px;background:#111318}
    .ac-recovery-copy{min-width:0;display:flex;flex-direction:column;gap:3px}
    .ac-recovery-copy strong{font-size:10px;font-weight:650;color:#dfe4eb}
    .ac-recovery-copy span{font-size:9px;line-height:1.45;color:#7f8996}
    .ac-recovery-actions{display:flex;align-items:center;gap:6px;flex:none}
    .ac-recovery-action{height:29px;padding:0 9px;border:1px solid #303945;border-radius:7px;background:#171c23;color:#cfd6df;font:500 9px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;white-space:nowrap;transition:background .14s,border-color .14s,color .14s,transform .14s}
    .ac-recovery-action:hover{background:#202630;border-color:#465262;color:#f0f3f7;transform:translateY(-1px)}
    .ac-recovery-action.primary{border-color:#586576;background:#e0e6ed;color:#0b0f14}
    .ac-recovery-action.primary:hover{background:#f0f3f7;border-color:#718095;color:#080b0f}
    .ac-recovery-action:focus-visible{outline:2px solid #586577;outline-offset:2px}
    .ac-ui-toast{position:fixed;right:18px;bottom:18px;z-index:1200;max-width:min(420px,calc(100vw - 36px));padding:11px 13px;border:1px solid #39434f;border-radius:10px;background:#12171e;color:#dce2ea;font:10px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;box-shadow:0 16px 42px #0007;animation:ac-toast-in .18s ease-out}
    .ac-ui-toast.error{border-color:#54353c;color:#e1b9be}
    @keyframes ac-toast-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
    @media(max-width:700px){.welcome{padding-top:32px}.welcome-grid{grid-template-columns:1fr}.ac-recovery-panel{align-items:flex-start;flex-direction:column}.ac-recovery-actions{width:100%}.ac-recovery-action{flex:1}}
    @media(prefers-reduced-motion:reduce){.welcome-grid button,.ac-recovery-action,.ac-ui-toast{transition:none;animation:none}}
  `;
  document.head.appendChild(style);
}

function openApiKeys(): void {
  const button = document.querySelector<HTMLButtonElement>('.api-key-rail-button');
  if (button) {
    button.click();
    return;
  }
  document.querySelector<HTMLButtonElement>('[data-action="ai-settings"]')?.click();
}

function openChatAiSettings(): void {
  const providerChip = document.querySelector<HTMLButtonElement>('.provider-chip');
  if (providerChip) {
    providerChip.click();
    return;
  }
  openApiKeys();
}

function createToast(message: string): void {
  document.querySelector('.ac-ui-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'ac-ui-toast error';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function classify(text: string): 'authentication' | 'billing' | 'quota' | 'rate_limit' | 'network' | 'server' | 'generic' {
  const value = text.toLowerCase();
  if (/api key|apikey|authentication|unauthorized|forbidden|401|403/.test(value)) return 'authentication';
  if (/credit|billing|payment|spending limit|funds/.test(value)) return 'billing';
  if (/quota|free tier|resource exhausted/.test(value)) return 'quota';
  if (/rate limit|too many requests|429/.test(value)) return 'rate_limit';
  if (/network|fetch failed|timeout|timed out|socket|dns|econn/.test(value)) return 'network';
  if (/server|service unavailable|500|502|503|504/.test(value)) return 'server';
  return 'generic';
}

function recoveryCopy(kind: ReturnType<typeof classify>): { title: string; description: string; action: string; primary: boolean } {
  switch (kind) {
    case 'authentication': return { title: 'Verifique sua API key', description: 'A chave foi recusada. Abra as credenciais para trocar ou adicionar outra chave.', action: 'Abrir API Keys', primary: true };
    case 'billing': return { title: 'Conta sem créditos disponíveis', description: 'Sua chave continua salva. Você pode adicionar outra chave ou revisar as credenciais.', action: 'Abrir API Keys', primary: true };
    case 'quota': return { title: 'Cota do modelo atingida', description: 'Troque o modelo ou selecione outra API key nas configurações deste chat.', action: 'Configurar IA', primary: true };
    case 'rate_limit': return { title: 'Limite de requisições atingido', description: 'Aguarde alguns instantes e envie a mensagem novamente.', action: 'Tentar novamente', primary: false };
    case 'network': return { title: 'Falha de conexão', description: 'Verifique sua conexão com a internet e tente novamente.', action: 'Tentar novamente', primary: false };
    case 'server': return { title: 'Falha temporária do provider', description: 'O serviço remoto apresentou um erro. Tente novamente em instantes.', action: 'Tentar novamente', primary: false };
    default: return { title: 'A solicitação falhou', description: 'Revise as configurações da IA ou tente enviar a mensagem novamente.', action: 'Configurar IA', primary: true };
  }
}

function retryLastMessage(): void {
  window.dispatchEvent(new CustomEvent('auto-codez-retry-message'));
}

function syncWelcome(): void {
  const welcome = document.querySelector<HTMLElement>('#messages .welcome');
  if (!welcome) return;
  welcome.querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach((button) => {
    if (button.dataset.recoveryBound) return;
    button.dataset.recoveryBound = 'true';
    button.addEventListener('click', () => {
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
      if (!prompt) return;
      prompt.value = button.dataset.suggestion || '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.focus();
    });
  });
}

function syncRecovery(): void {
  syncWelcome();
  const activity = document.querySelector<HTMLElement>('#messages .activity-card');
  const error = activity?.querySelector<HTMLElement>('.activity-line.error');
  const errorText = error?.textContent?.trim() || '';
  if (!errorText) {
    lastRecoverySignature = '';
    document.querySelector(`#${PANEL_ID}`)?.remove();
    return;
  }

  const kind = classify(errorText);
  const signature = `${kind}:${errorText}`;
  if (signature === lastRecoverySignature && document.getElementById(PANEL_ID)) return;
  lastRecoverySignature = signature;

  document.querySelector(`#${PANEL_ID}`)?.remove();
  if (!activity) return;
  const copy = recoveryCopy(kind);
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'ac-recovery-panel';
  panel.innerHTML = `<div class="ac-recovery-copy"><strong>${copy.title}</strong><span>${copy.description}</span></div><div class="ac-recovery-actions"><button type="button" class="ac-recovery-action ${copy.primary ? 'primary' : ''}" data-recovery-action="${kind}">${copy.action}</button></div>`;
  activity.appendChild(panel);
  panel.querySelector<HTMLButtonElement>('[data-recovery-action]')?.addEventListener('click', () => {
    if (kind === 'authentication' || kind === 'billing') { openApiKeys(); return; }
    if (kind === 'quota') { openChatAiSettings(); return; }
    if (kind === 'rate_limit' || kind === 'network' || kind === 'server') { retryLastMessage(); return; }
    openChatAiSettings();
  });
}

function scheduleRecoverySync(): void {
  if (recoveryFrame) return;
  recoveryFrame = window.requestAnimationFrame(() => {
    recoveryFrame = 0;
    syncRecovery();
  });
}

window.addEventListener('auto-codez-ui-error', (event) => {
  const detail = (event as CustomEvent<string>).detail;
  if (detail) createToast(detail);
});

installStyles();
const observer = new MutationObserver(scheduleRecoverySync);
const start = (): void => {
  const messages = document.querySelector('#messages');
  if (!messages) { window.setTimeout(start, 50); return; }
  observer.observe(messages, { childList: true, subtree: true });
  scheduleRecoverySync();
};
start();
