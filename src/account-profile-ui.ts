import './account-profile-ui.css';

type LinkedIdentity = {
  id: string;
  provider: 'google' | 'github' | 'microsoft' | 'passkey' | 'magic_link';
  email?: string;
  displayName?: string;
  linkedAt: number;
  lastUsedAt?: number;
};

type AccountSnapshot = {
  state: 'signed_out' | 'authenticated' | 'offline' | 'restoring' | 'revoked' | 'error';
  account?: {
    id: string;
    primaryEmail: string;
    displayName: string;
    username?: string;
    identities: LinkedIdentity[];
  };
  session?: {
    id: string;
    identityProvider: LinkedIdentity['provider'];
    lastActivityAt: number;
    accessExpiresAt: number;
  };
  device: {
    id: string;
    name: string;
    platform: string;
    arch: string;
    appVersion: string;
  };
  lastError?: string;
};

type RemoteDevice = {
  id: string;
  name: string;
  platform: string;
  arch: string;
  appVersion: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
};

type RegistrySnapshot = {
  state: 'unavailable' | 'idle' | 'registering' | 'ready' | 'offline' | 'error';
  devices: RemoteDevice[];
  currentDeviceId?: string;
  lastError?: string;
};

type AuthConfiguration = {
  configured: boolean;
};

type Bridge = {
  accountState: () => Promise<AccountSnapshot>;
  accountAuthConfiguration: () => Promise<AuthConfiguration>;
  accountDeviceRegistryState: () => Promise<RegistrySnapshot>;
  refreshAccountDeviceRegistry: () => Promise<RegistrySnapshot>;
  revokeAccountDevice: (deviceId: string) => Promise<RegistrySnapshot>;
  openAccountPasskeyEnrollment: () => Promise<{ opened: boolean }>;
  logoutAccount: () => Promise<AccountSnapshot>;
  onAccountState: (listener: (state: AccountSnapshot) => void) => () => void;
  onAccountDeviceRegistryState: (listener: (state: RegistrySnapshot) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: Bridge }).autoCodez;
let account: AccountSnapshot | undefined;
let registry: RegistrySnapshot | undefined;
let configured = false;
let confirmingAction = '';
let unsubscribeAccount: (() => void) | undefined;
let unsubscribeRegistry: (() => void) | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function providerName(provider: LinkedIdentity['provider']): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'passkey') return 'Passkey';
  return 'Magic Link';
}

function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Nunca';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'Agora';
  if (delta < 3_600_000) return `Há ${Math.max(1, Math.floor(delta / 60_000))} min`;
  if (delta < 86_400_000) return `Há ${Math.max(1, Math.floor(delta / 3_600_000))} h`;
  return new Date(timestamp).toLocaleDateString('pt-BR');
}

function stateLabel(): { label: string; tone: string } {
  if (account?.state === 'authenticated') return { label: 'Conectada', tone: 'online' };
  if (account?.state === 'offline') return { label: 'Offline', tone: 'offline' };
  if (account?.state === 'revoked') return { label: 'Revogada', tone: 'danger' };
  return { label: 'Desconectada', tone: 'neutral' };
}

function identityRows(): string {
  const identities = account?.account?.identities ?? [];
  if (!identities.length) {
    return '<div class="account-profile-empty">Nenhum método vinculado foi carregado ainda.</div>';
  }
  return identities.map((identity) => `
    <div class="account-profile-method">
      <div>
        <strong>${escapeHtml(providerName(identity.provider))}</strong>
        <span>${escapeHtml(identity.email || identity.displayName || 'Vinculado à conta')}</span>
      </div>
      <small>${identity.lastUsedAt ? `Usado ${escapeHtml(relativeTime(identity.lastUsedAt))}` : 'Vinculado'}</small>
    </div>
  `).join('');
}

function deviceRows(): string {
  if (!registry || registry.state === 'registering' || registry.state === 'idle') {
    return '<div class="account-profile-empty">Carregando dispositivos...</div>';
  }
  if (!registry.devices.length) {
    return '<div class="account-profile-empty">Nenhum dispositivo remoto disponível.</div>';
  }
  return registry.devices.map((device) => {
    const current = device.id === registry?.currentDeviceId;
    const revoked = Boolean(device.revokedAt);
    const confirmKey = `revoke:${device.id}`;
    return `
      <div class="account-profile-device ${revoked ? 'revoked' : ''}">
        <div class="account-profile-device-main">
          <strong>${escapeHtml(device.name)} ${current ? '<em>Este dispositivo</em>' : ''}</strong>
          <span>${escapeHtml(device.platform)} · ${escapeHtml(device.arch)} · ${escapeHtml(device.appVersion)}</span>
          <small>${revoked ? 'Revogado' : `Última atividade: ${escapeHtml(relativeTime(device.lastSeenAt))}`}</small>
        </div>
        ${!current && !revoked ? `
          <button type="button" class="account-profile-danger" data-account-revoke-device="${escapeHtml(device.id)}">
            ${confirmingAction === confirmKey ? 'Confirmar revogação' : 'Revogar'}
          </button>
        ` : ''}
      </div>
    `;
  }).join('');
}

function panelMarkup(): string {
  if (!account?.account || (account.state !== 'authenticated' && account.state !== 'offline')) return '';
  const state = stateLabel();
  const session = account.session;
  return `
    <section class="profile-section account-profile-cloud" data-account-cloud-panel>
      <div class="profile-section-heading">
        <div class="profile-section-icon account-profile-cloud-icon">A</div>
        <div>
          <h2>Conta Auto CodeZ</h2>
          <p>Identidade, sessão e dispositivos vinculados à sua conta.</p>
        </div>
        <span class="account-profile-state ${state.tone}">${state.label}</span>
      </div>

      <div class="account-profile-identity">
        <div>
          <strong>${escapeHtml(account.account.displayName)}</strong>
          <span>${escapeHtml(account.account.primaryEmail)}</span>
          ${account.account.username ? `<small>@${escapeHtml(account.account.username)}</small>` : ''}
        </div>
        <div class="account-profile-current-device">
          <span>Dispositivo atual</span>
          <strong>${escapeHtml(account.device.name)}</strong>
        </div>
      </div>

      <div class="account-profile-subsection">
        <div class="account-profile-subheading row">
          <div><strong>Métodos de acesso</strong><span>Vincule métodos passwordless à sua conta.</span></div>
          ${account.state === 'authenticated' ? '<button type="button" class="profile-secondary-button enabled" data-account-add-passkey>Adicionar passkey</button>' : ''}
        </div>
        <div class="account-profile-methods">${identityRows()}</div>
      </div>

      <div class="account-profile-subsection">
        <div class="account-profile-subheading row">
          <div><strong>Dispositivos</strong><span>Revogue qualquer instalação que você não reconheça.</span></div>
          <button type="button" class="profile-secondary-button enabled" data-account-refresh-devices>Atualizar</button>
        </div>
        <div class="account-profile-devices">${deviceRows()}</div>
        ${registry?.lastError ? `<div class="account-profile-warning">${escapeHtml(registry.lastError)}</div>` : ''}
      </div>

      <div class="account-profile-session">
        <div>
          <strong>Sessão atual</strong>
          <span>${session ? `${escapeHtml(providerName(session.identityProvider))} · atividade ${escapeHtml(relativeTime(session.lastActivityAt))}` : 'Sessão local restaurada'}</span>
        </div>
        <button type="button" class="account-profile-danger" data-account-logout>
          ${confirmingAction === 'logout' ? 'Confirmar saída' : 'Sair da conta'}
        </button>
      </div>
    </section>
  `;
}

function enhanceProfile(): void {
  document.querySelectorAll<HTMLElement>('[data-account-cloud-panel]').forEach((element) => element.remove());
  if (!configured || !account?.account) return;
  const content = document.querySelector<HTMLElement>('.profile-overlay .profile-content');
  if (!content) return;

  const firstGrid = content.querySelector('.profile-grid');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = panelMarkup();
  const panel = wrapper.firstElementChild;
  if (!panel) return;
  if (firstGrid) content.insertBefore(panel, firstGrid);
  else content.appendChild(panel);
}

async function refreshRegistry(): Promise<void> {
  if (!bridge || account?.state !== 'authenticated') return;
  registry = await bridge.refreshAccountDeviceRegistry().catch(() => registry);
  enhanceProfile();
}

async function revokeDevice(deviceId: string): Promise<void> {
  if (!bridge) return;
  const key = `revoke:${deviceId}`;
  if (confirmingAction !== key) {
    confirmingAction = key;
    enhanceProfile();
    return;
  }
  confirmingAction = '';
  registry = await bridge.revokeAccountDevice(deviceId);
  enhanceProfile();
}

async function logout(): Promise<void> {
  if (!bridge) return;
  if (confirmingAction !== 'logout') {
    confirmingAction = 'logout';
    enhanceProfile();
    return;
  }
  confirmingAction = '';
  account = await bridge.logoutAccount();
  document.querySelector<HTMLElement>('[data-profile-close]')?.click();
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-action="profile"]')) {
    window.setTimeout(() => enhanceProfile(), 0);
    return;
  }

  if (target.closest('[data-account-add-passkey]')) {
    void bridge?.openAccountPasskeyEnrollment();
    return;
  }

  if (target.closest('[data-account-refresh-devices]')) {
    void refreshRegistry();
    return;
  }

  const deviceId = target.closest<HTMLElement>('[data-account-revoke-device]')?.dataset.accountRevokeDevice;
  if (deviceId) {
    void revokeDevice(deviceId);
    return;
  }

  if (target.closest('[data-account-logout]')) {
    void logout();
    return;
  }

  if (!target.closest('[data-account-cloud-panel]')) confirmingAction = '';
}, true);

const observer = new MutationObserver(() => {
  if (document.querySelector('.profile-overlay') && !document.querySelector('[data-account-cloud-panel]')) {
    enhanceProfile();
  }
});
observer.observe(document.documentElement, { subtree: true, childList: true });

async function initialize(): Promise<void> {
  if (!bridge) return;
  const [config, currentAccount, currentRegistry] = await Promise.all([
    bridge.accountAuthConfiguration(),
    bridge.accountState(),
    bridge.accountDeviceRegistryState(),
  ]);
  configured = config.configured;
  account = currentAccount;
  registry = currentRegistry;

  unsubscribeAccount = bridge.onAccountState((snapshot) => {
    account = snapshot;
    enhanceProfile();
  });
  unsubscribeRegistry = bridge.onAccountDeviceRegistryState((snapshot) => {
    registry = snapshot;
    enhanceProfile();
  });
}

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  unsubscribeAccount?.();
  unsubscribeRegistry?.();
}, { once: true });

void initialize();
