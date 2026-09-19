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
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 19.3 4c.1-.4.5-2-.1-4 0 0-1.2-.4-4 1.3a13.4 13.4 0 0 0-6.4 0C6.1-.4 4.9 0 4.9 0c-.6 2-.2 3.6-.1 4A5.5 5.5 0 0 0 3.3 7.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4"/></svg>';
  }
  if (provider === 'google') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.1a4.4 4.4 0 0 1-1.9 2.9v2.6h3.1c1.8-1.7 2.7-4.2 2.7-7.4Z"/><path d="M12 21c2.5 0 4.7-.8 6.3-2.2l-3.1-2.6c-.9.6-2 1-3.2 1a5.5 5.5 0 0 1-5.2-3.8H3.6V16A9.5 9.5 0 0 0 12 21Z"/><path d="M6.8 13.4A5.7 5.7 0 0 1 6.5 12c0-.5.1-1 .3-1.4V8H3.6A9.5 9.5 0 0 0 2.6 12c0 1.4.3 2.7 1 4l3.2-2.6Z"/><path d="M12 6.8c1.4 0 2.6.5 3.6 1.4l2.8-2.8A9.3 9.3 0 0 0 3.6 8l3.2 2.6A5.5 5.5 0 0 1 12 6.8Z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z"/></svg>';
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
  const error = flowState.status === 'error' ? flowState.lastError : accountState?.state === 'revoked' ? 'Sua sessão foi revogada. Entre novamente.' : '';

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
      ${passkey ? '<button type="button" class="account-passkey" data-account-passkey '+(busy ? 'disabled' : '')+'><span aria-hidden="true">◉</span> Entrar com passkey</button>' : ''}
      ${error ? `<div class="account-inline-error" role="alert">${escapeHtml(error)}</div>` : ''}
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
