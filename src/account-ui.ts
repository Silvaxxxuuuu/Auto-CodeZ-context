import './account-ui.css';

type AccountState = {
  state: 'signed_out' | 'authenticated' | 'offline' | 'restoring' | 'revoked' | 'error';
  account?: { displayName: string; primaryEmail: string };
  device: { id: string; name: string; platform: string; arch: string; appVersion: string };
  lastError?: string;
};

type AuthFlowState = {
  status: 'idle' | 'waiting_magic_link' | 'waiting_browser' | 'completing' | 'authenticated' | 'error';
  method?: 'magic_link' | 'oauth' | 'passkey';
  provider?: 'github' | 'google' | 'microsoft';
  flowId?: string;
  emailHint?: string;
  expiresAt?: number;
  lastError?: string;
};

type AuthConfiguration = {
  configured: boolean;
  methods: Array<'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey'>;
  configurationError?: string;
};

type AccountBridge = {
  accountState: () => Promise<AccountState>;
  accountAuthFlowState: () => Promise<AuthFlowState>;
  accountAuthConfiguration: () => Promise<AuthConfiguration>;
  beginAccountMagicLink: (email: string) => Promise<AuthFlowState>;
  beginAccountOAuth: (provider: 'github' | 'google' | 'microsoft') => Promise<AuthFlowState>;
  beginAccountPasskey: () => Promise<AuthFlowState>;
  renameAccountDevice: (name: string) => Promise<AccountState>;
  renameAccountDeviceRegistryCurrent: (name: string) => Promise<unknown>;
  onAccountState: (listener: (state: AccountState) => void) => () => void;
  onAccountAuthFlowState: (listener: (state: AuthFlowState) => void) => () => void;
};

const DEVICE_ONBOARDING_KEY = 'auto-codez:account-device-onboarded';
const bridge = (window as unknown as { autoCodez?: AccountBridge }).autoCodez;

let accountState: AccountState | undefined;
let flowState: AuthFlowState = { status: 'idle' };
let configuration: AuthConfiguration = { configured: false, methods: [] };
let root: HTMLElement | null = null;
let busy = false;
let unsubAccount: (() => void) | undefined;
let unsubFlow: (() => void) | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function providerIcon(provider: string): string {
  if (provider === 'github') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
  }
  if (provider === 'google') {
    return '<svg viewBox="0 0 23.5 24" aria-hidden="true"><defs><clipPath id="auto-codez-google-g-clip"><path d="M12 10v4.5h6.47c-.5 2.7-3 4.74-6.47 4.74-3.9 0-7.1-3.3-7.1-7.25S8.1 4.75 12 4.75c1.8 0 3.35.6 4.6 1.8l3.4-3.4C18 1.2 15.24 0 12 0 5.4 0 0 5.4 0 12s5.4 12 12 12c7 0 11.5-4.9 11.5-11.7 0-.8-.1-1.54-.2-2.3z"/></clipPath><filter id="auto-codez-google-g-blur"><feGaussianBlur stdDeviation="1"/></filter></defs><g clip-path="url(#auto-codez-google-g-clip)"><foreignObject x="-2" y="-2" width="28" height="28" filter="url(#auto-codez-google-g-blur)"><div xmlns="http://www.w3.org/1999/xhtml" style="height:100%;width:100%;background:conic-gradient(#FF4641,#FD5061 40deg,#FD5061 60deg,#3186FF 85deg,#3186FF 117deg,#00A5B7 142deg,#0EBC5F 167deg,#0EBC5F 200deg,#6CC500 226deg,#FC0 253deg,#FFD314 268deg,#FC0 292deg,#FF4641 327deg)"></div></foreignObject><path fill="#3186FF" d="M11 8h16v8H11z"/></g></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="9.25" height="9.25" fill="#F25022"/><rect x="12.75" y="2" width="9.25" height="9.25" fill="#7FBA00"/><rect x="2" y="12.75" width="9.25" height="9.25" fill="#00A4EF"/><rect x="12.75" y="12.75" width="9.25" height="9.25" fill="#FFB900"/></svg>';
}

function passkeyIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="m15.5 7.5 2 2L22 5l-3-3-4.5 4.5"/><path d="m13.5 9.5 2 2"/><circle cx="6" cy="18" r="3"/><path d="M9 15 15.5 8.5"/></svg>';
}

function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.createElement('section');
  root.id = 'account-onboarding';
  root.className = 'account-onboarding';
  root.setAttribute('aria-live', 'polite');
  document.body.appendChild(root);
  return root;
}

function removeRoot(): void {
  root?.remove();
  root = null;
}

function shouldShowDeviceStep(): boolean {
  return accountState?.state === 'authenticated'
    && localStorage.getItem(DEVICE_ONBOARDING_KEY) !== accountState.device.id;
}

function providerButton(provider: 'github' | 'google' | 'microsoft', label: string): string {
  if (!configuration.methods.includes(provider)) return '';
  return `<button type="button" class="account-provider" data-account-provider="${provider}" ${busy ? 'disabled' : ''}>
    <span class="account-provider-icon">${providerIcon(provider)}</span>
    <span>Continuar com ${label}</span>
  </button>`;
}

function renderLogin(): void {
  const target = ensureRoot();
  const magic = configuration.methods.includes('magic_link');
  const passkey = configuration.methods.includes('passkey');
  const error = flowState.status === 'error'
    ? flowState.lastError
    : accountState?.state === 'revoked'
      ? 'Sua sessão foi revogada. Entre novamente.'
      : accountState?.state === 'error'
        ? accountState.lastError
        : configuration.configurationError;

  target.innerHTML = `
    <div class="account-backdrop-glow"></div>
    <main class="account-card" data-account-screen="login">
      <div class="account-brand">
        <div class="account-brand-mark">&gt;_</div>
        <span>Auto CodeZ</span>
      </div>
      <header class="account-header">
        <span class="account-eyebrow">Sua conta Auto CodeZ</span>
        <h1>Bem-vindo ao Auto CodeZ</h1>
        <p>Escolha uma das formas de login para continuar. Você pode adicionar outros métodos depois.</p>
      </header>
      ${magic ? `
        <form class="account-magic-form" id="account-magic-form">
          <label for="account-email">Magic Link</label>
          <div class="account-email-row">
            <input id="account-email" name="email" type="email" autocomplete="email" placeholder="seuemail@exemplo.com" required ${busy ? 'disabled' : ''}>
            <button type="submit" class="account-primary" ${busy ? 'disabled' : ''}>Enviar link</button>
          </div>
        </form>
      ` : ''}
      <div class="account-divider"><span>ou continue com</span></div>
      <div class="account-providers">
        ${providerButton('github', 'GitHub')}
        ${providerButton('google', 'Google')}
        ${providerButton('microsoft', 'Microsoft')}
      </div>
      ${passkey ? '<button type="button" class="account-passkey" data-account-passkey '+(busy ? 'disabled' : '')+'><span class="account-passkey-icon">'+passkeyIcon()+'</span> Entrar com passkey</button>' : ''}
      ${error ? `<div class="account-inline-error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${configuration.configurationError ? '<button type="button" class="account-secondary" data-account-retry-configuration '+(busy ? 'disabled' : '')+'>Tentar novamente</button>' : ''}
      <p class="account-security-note">Sem senhas. Suas credenciais sensíveis permanecem protegidas pelo sistema operacional.</p>
    </main>
  `;
}

function renderWaiting(): void {
  const target = ensureRoot();
  const isMagic = flowState.status === 'waiting_magic_link';
  const title = isMagic ? 'Verifique seu e-mail' : 'Conclua no navegador';
  const body = isMagic
    ? `Enviamos um link seguro para <strong>${escapeHtml(flowState.emailHint || 'seu e-mail')}</strong>.`
    : 'A janela de autenticação foi aberta no seu navegador. O Auto CodeZ continuará automaticamente quando você concluir.';
  target.innerHTML = `
    <div class="account-backdrop-glow"></div>
    <main class="account-card compact" data-account-screen="waiting">
      <div class="account-waiting-icon"><span></span></div>
      <header class="account-header centered">
        <h1>${title}</h1>
        <p>${body}</p>
      </header>
      <button type="button" class="account-secondary" data-account-back>Voltar</button>
    </main>
  `;
}

function renderCompleting(): void {
  const target = ensureRoot();
  target.innerHTML = `
    <div class="account-backdrop-glow"></div>
    <main class="account-card compact" data-account-screen="completing">
      <div class="account-spinner" aria-hidden="true"></div>
      <header class="account-header centered">
        <h1>Preparando sua conta</h1>
        <p>Validando sessão e registrando este dispositivo com segurança.</p>
      </header>
    </main>
  `;
}

function renderDevice(): void {
  if (!accountState) return;
  const target = ensureRoot();
  const suggestedName = accountState.device.name === 'Este dispositivo'
    ? accountState.account?.displayName?.trim() || accountState.device.name
    : accountState.device.name;
  target.innerHTML = `
    <div class="account-backdrop-glow"></div>
    <main class="account-card compact" data-account-screen="device">
      <div class="account-device-badge">✓</div>
      <header class="account-header centered">
        <span class="account-eyebrow">Conta conectada</span>
        <h1>Seu dispositivo está pronto</h1>
        <p>Esse nome serve apenas para identificar o computador dentro do Auto CodeZ.</p>
      </header>
      <form id="account-device-form" class="account-device-form">
        <label for="account-device-name">Nome do dispositivo</label>
        <input id="account-device-name" value="${escapeHtml(suggestedName)}" maxlength="80" autocomplete="off" ${busy ? 'disabled' : ''}>
        <div class="account-device-meta">${escapeHtml(accountState.device.platform)} · ${escapeHtml(accountState.device.arch)} · Auto CodeZ ${escapeHtml(accountState.device.appVersion)}</div>
        <button type="submit" class="account-primary full" ${busy ? 'disabled' : ''}>Continuar</button>
      </form>
    </main>
  `;
}

function render(): void {
  if (!configuration.configured || !accountState) {
    removeRoot();
    return;
  }

  if (shouldShowDeviceStep()) {
    renderDevice();
    return;
  }

  if (accountState.state === 'authenticated' || accountState.state === 'offline') {
    removeRoot();
    return;
  }

  if (flowState.status === 'waiting_magic_link' || flowState.status === 'waiting_browser') {
    renderWaiting();
    return;
  }

  if (flowState.status === 'completing' || accountState.state === 'restoring') {
    renderCompleting();
    return;
  }

  renderLogin();
}

async function refreshConfiguration(): Promise<void> {
  if (!bridge) return;
  busy = true;
  render();
  try {
    configuration = await bridge.accountAuthConfiguration();
    accountState = await bridge.accountState();
  } catch (error) {
    configuration = {
      ...configuration,
      configured: true,
      methods: [],
      configurationError: error instanceof Error ? error.message : 'Serviço de autenticação indisponível.',
    };
  } finally {
    busy = false;
    render();
  }
}

async function beginMagicLink(email: string): Promise<void> {
  if (!bridge) return;
  busy = true;
  render();
  try {
    flowState = await bridge.beginAccountMagicLink(email);
  } catch (error) {
    flowState = { status: 'error', lastError: error instanceof Error ? error.message : 'Não foi possível enviar o link.' };
  } finally {
    busy = false;
    render();
  }
}

async function beginOAuth(provider: 'github' | 'google' | 'microsoft'): Promise<void> {
  if (!bridge) return;
  busy = true;
  render();
  try {
    flowState = await bridge.beginAccountOAuth(provider);
  } catch (error) {
    flowState = { status: 'error', lastError: error instanceof Error ? error.message : 'Não foi possível abrir o login.' };
  } finally {
    busy = false;
    render();
  }
}

async function beginPasskey(): Promise<void> {
  if (!bridge) return;
  busy = true;
  render();
  try {
    flowState = await bridge.beginAccountPasskey();
  } catch (error) {
    flowState = { status: 'error', lastError: error instanceof Error ? error.message : 'Não foi possível abrir o login com passkey.' };
  } finally {
    busy = false;
    render();
  }
}

async function finishDevice(name: string): Promise<void> {
  if (!bridge || !accountState) return;
  busy = true;
  render();
  try {
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new Error('Digite um nome para este dispositivo.');
    accountState = await bridge.renameAccountDevice(normalized);
    await bridge.renameAccountDeviceRegistryCurrent(normalized).catch((): undefined => undefined);
    localStorage.setItem(DEVICE_ONBOARDING_KEY, accountState.device.id);
  } catch (error) {
    flowState = { status: 'error', lastError: error instanceof Error ? error.message : 'Não foi possível salvar o dispositivo.' };
  } finally {
    busy = false;
    render();
  }
}

document.addEventListener('submit', (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form) return;
  if (form.id === 'account-magic-form') {
    event.preventDefault();
    const data = new FormData(form);
    void beginMagicLink(String(data.get('email') ?? ''));
  }
  if (form.id === 'account-device-form') {
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>('#account-device-name');
    void finishDevice(input?.value ?? '');
  }
}, true);

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const provider = target.closest<HTMLElement>('[data-account-provider]')?.dataset.accountProvider;
  if (provider === 'github' || provider === 'google' || provider === 'microsoft') {
    void beginOAuth(provider);
    return;
  }
  if (target.closest('[data-account-passkey]')) {
    void beginPasskey();
    return;
  }
  if (target.closest('[data-account-retry-configuration]')) {
    void refreshConfiguration();
    return;
  }
  if (target.closest('[data-account-back]')) {
    flowState = { status: 'idle' };
    render();
  }
}, true);

async function initialize(): Promise<void> {
  if (!bridge) return;
  [configuration, accountState, flowState] = await Promise.all([
    bridge.accountAuthConfiguration(),
    bridge.accountState(),
    bridge.accountAuthFlowState(),
  ]);
  render();

  unsubAccount = bridge.onAccountState((state) => {
    accountState = state;
    render();
  });
  unsubFlow = bridge.onAccountAuthFlowState((state) => {
    flowState = state;
    render();
  });
}

window.addEventListener('beforeunload', () => {
  unsubAccount?.();
  unsubFlow?.();
}, { once: true });

void initialize();
