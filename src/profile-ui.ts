import { getAppPreferences, updateAppPreferences } from './app-preferences';

const profileProviders = [
  { id: 'google', name: 'Google', description: 'Login e sincronização via conta Google.', icon: 'globe-2' },
  { id: 'github', name: 'GitHub', description: 'Identidade GitHub vinculada à mesma conta Auto CodeZ.', icon: 'github' },
  { id: 'microsoft', name: 'Microsoft', description: 'Identidade Microsoft vinculada à mesma conta Auto CodeZ.', icon: 'monitor' },
];

type ProfileState = {
  providers: Array<{ id: string; displayName: string; configured?: boolean; requiresApiKey?: boolean }>;
  chats: Array<{ id: string; providerId: string; model: string; projectId?: string }>;
  projects: Array<{ id: string; name: string }>;
};
type ProfileBridge = {
  getState: () => Promise<ProfileState>;
  listApiKeys?: () => Promise<unknown[]>;
};
type LocalProfileSnapshot = {
  hardware: { totalRamBytes: number; architecture?: string; cpuModel?: string; gpuName?: string };
  runtimes: Array<{ id: string; displayName: string; available: boolean }>;
  installed: Array<{ id: string; runtimeId: string }>;
};
type LocalAiProfileBridge = {
  snapshot?: () => Promise<LocalProfileSnapshot>;
};
type ProfileData = {
  state: ProfileState;
  keys: unknown[];
  local?: LocalProfileSnapshot;
};

const bridge = (window as unknown as { autoCodez?: ProfileBridge }).autoCodez;
const localBridge = (window as unknown as { autoCodezLocalAi?: LocalAiProfileBridge }).autoCodezLocalAi;

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    'user-round': '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    'globe-2': '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 19.3 4c.1-.4.5-2-.1-4 0 0-1.2-.4-4 1.3a13.4 13.4 0 0 0-6.4 0C6.1-.4 4.9 0 4.9 0c-.6 2-.2 3.6-.1 4A5.5 5.5 0 0 0 3.3 7.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    fingerprint: '<path d="M12 11a3 3 0 0 1 3 3v1"/><path d="M12 7a7 7 0 0 1 7 7v1"/><path d="M12 3a11 11 0 0 1 11 11v1"/><path d="M12 11a3 3 0 0 0-3 3v5"/><path d="M12 7a7 7 0 0 0-7 7v5"/><path d="M12 3A11 11 0 0 0 1 14v1"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-10 6L2 7"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M12 2v3M15 2v3M9 19v3M12 19v3M15 19v3M2 9h3M2 12h3M2 15h3M19 9h3M19 12h3M19 15h3"/>',
    folder: '<path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
    message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z"/>',
    sparkles: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L19 14Z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  return `<svg class="profile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths['user-round']}</svg>`;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 'Não detectado';
  const gib = value / 1024 ** 3;
  return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function closeLegacyProfileModal(): void {
  document.querySelector<HTMLElement>('#modal-root')?.replaceChildren();
}

function stat(iconName: string, value: string, label: string): string {
  return `<div class="profile-method-row"><div class="profile-method-icon">${icon(iconName)}</div><div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div></div>`;
}

async function loadProfileData(): Promise<ProfileData> {
  const fallbackState: ProfileState = { providers: [], chats: [], projects: [] };
  const statePromise = bridge?.getState?.() ?? Promise.resolve(fallbackState);
  const keysPromise = bridge?.listApiKeys?.().catch((): unknown[] => []) ?? Promise.resolve<unknown[]>([]);
  const localPromise = localBridge?.snapshot?.().catch((): LocalProfileSnapshot | undefined => undefined) ?? Promise.resolve<LocalProfileSnapshot | undefined>(undefined);
  const [state, keys, local] = await Promise.all([statePromise, keysPromise, localPromise]);
  return { state, keys, ...(local ? { local } : {}) };
}

async function renderProfile(): Promise<void> {
  if (document.querySelector('.profile-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  closeLegacyProfileModal();
  const preferences = getAppPreferences();
  const displayName = escapeHtml(preferences.profile.displayName);
  const localId = escapeHtml(preferences.profile.id);

  const overlay = document.createElement('section');
  overlay.className = 'profile-overlay';
  overlay.setAttribute('aria-label', 'Perfil e conta');
  overlay.innerHTML = `<div class="profile-page"><header class="profile-header"><div><div class="profile-eyebrow">CONTA</div><h1>Perfil</h1><p>Identidade local, ambiente real e a base da futura conta Auto CodeZ.</p></div><button class="profile-close" type="button" data-profile-close title="Fechar perfil" aria-label="Fechar perfil">${icon('x')}</button></header><div class="profile-content"><section class="profile-card profile-identity-card"><div class="profile-avatar">${icon('user-round')}</div><div class="profile-identity-copy"><strong data-profile-display-name>${displayName}</strong><span>Perfil local</span><small>Seu perfil funciona offline hoje e será vinculado à conta Auto CodeZ quando a autenticação cloud entrar.</small></div><span class="profile-status profile-status-neutral">Local</span></section><section class="profile-section"><div class="profile-section-heading"><div class="profile-section-icon">${icon('sparkles')}</div><div><h2>Carregando seu ambiente</h2><p>Lendo projetos, conversas, IAs e hardware local.</p></div></div></section></div></div>`;
  shell.appendChild(overlay);
  document.querySelector<HTMLElement>('.rail-button[data-action="profile"]')?.classList.add('active');
  overlay.querySelector<HTMLButtonElement>('[data-profile-close]')?.focus();

  const data = await loadProfileData();
  if (!overlay.isConnected) return;
  const platform = navigator.platform || 'Desktop';
  const localRuntime = data.local?.runtimes.find((runtime: LocalProfileSnapshot['runtimes'][number]) => runtime.id === 'ollama');
  const configuredCloudProviders = data.state.providers.filter((provider) => provider.requiresApiKey !== false && provider.configured).length;
  const localModelCount = data.local?.installed.length ?? 0;
  const providerCount = configuredCloudProviders + (localRuntime?.available ? 1 : 0);
  const hardware = data.local?.hardware;
  const cpuDescription = hardware?.cpuModel || platform;
  const architecture = hardware?.architecture ? hardware.architecture.toUpperCase() : 'Desktop';

  const content = overlay.querySelector<HTMLElement>('.profile-content');
  if (!content) return;
  content.innerHTML = `
    <section class="profile-card profile-identity-card">
      <div class="profile-avatar">${icon('user-round')}</div>
      <div class="profile-identity-copy">
        <strong data-profile-display-name>${displayName}</strong>
        <span>Perfil local</span>
        <small>${escapeHtml(platform)} · ${escapeHtml(architecture)}${hardware?.totalRamBytes ? ` · ${escapeHtml(formatBytes(hardware.totalRamBytes))} RAM` : ''}</small>
      </div>
      <span class="profile-status profile-status-neutral">Local</span>
    </section>

    <div class="profile-grid">
      <section class="profile-section">
        <div class="profile-section-heading"><div class="profile-section-icon">${icon('user-round')}</div><div><h2>Identidade neste dispositivo</h2><p>Edite seu nome local e consulte a identidade persistente desta instalação.</p></div></div>
        <form class="profile-local-form" data-profile-local-form>
          <label><span>Nome de exibição</span><input data-profile-name-input maxlength="80" value="${displayName}" autocomplete="off"></label>
          <label><span>ID local</span><div class="profile-id-row"><code data-profile-local-id>${localId}</code><button type="button" class="profile-secondary-button enabled" data-profile-copy-id>Copiar</button></div></label>
          <button class="profile-primary-button" type="submit">Salvar perfil</button>
          <span class="profile-save-state" data-profile-save-state aria-live="polite"></span>
        </form>
      </section>

      <section class="profile-section">
        <div class="profile-section-heading"><div class="profile-section-icon">${icon('message')}</div><div><h2>Seu espaço de trabalho</h2><p>Números lidos do estado local atual.</p></div></div>
        <div class="profile-method-list">
          ${stat('folder', String(data.state.projects.length), data.state.projects.length === 1 ? 'projeto local' : 'projetos locais')}
          ${stat('message', String(data.state.chats.length), data.state.chats.length === 1 ? 'conversa' : 'conversas')}
          ${stat('sparkles', String(providerCount), providerCount === 1 ? 'fonte de IA disponível' : 'fontes de IA disponíveis')}
          ${stat('cpu', String(localModelCount), localModelCount === 1 ? 'modelo local instalado' : 'modelos locais instalados')}
        </div>
      </section>
    </div>

    <div class="profile-grid profile-grid-secondary">
      <section class="profile-section">
        <div class="profile-section-heading"><div class="profile-section-icon">${icon('sparkles')}</div><div><h2>Ambiente de IA</h2><p>Atalhos para as fontes de inteligência usadas no produto.</p></div></div>
        <div class="profile-provider-list">
          <div class="profile-provider-row"><div class="profile-provider-icon">${icon('sparkles')}</div><div class="profile-provider-copy"><strong>Providers cloud</strong><span>${data.keys.length} credencial${data.keys.length === 1 ? '' : 'is'} salva${data.keys.length === 1 ? '' : 's'} neste dispositivo.</span></div><button class="profile-secondary-button enabled" type="button" data-profile-action="providers">Gerenciar</button></div>
          <div class="profile-provider-row"><div class="profile-provider-icon">${icon('cpu')}</div><div class="profile-provider-copy"><strong>IA Local</strong><span>${localRuntime?.available ? `${localRuntime.displayName} conectado · ${localModelCount} modelo${localModelCount === 1 ? '' : 's'}` : 'Runtime local ainda não detectado.'}</span></div><button class="profile-secondary-button enabled" type="button" data-profile-action="local-ai">Abrir</button></div>
        </div>
      </section>

      <section class="profile-section">
        <div class="profile-section-heading"><div class="profile-section-icon">${icon('monitor')}</div><div><h2>Este dispositivo</h2><p>Informações úteis para IA Local e diagnóstico do ambiente.</p></div></div>
        <div class="profile-device-summary"><strong>${escapeHtml(cpuDescription)}</strong><span>${escapeHtml(architecture)}${hardware?.totalRamBytes ? ` · ${escapeHtml(formatBytes(hardware.totalRamBytes))} RAM` : ''}</span><small>${hardware?.gpuName ? escapeHtml(hardware.gpuName) : 'GPU/VRAM só serão exibidas quando a detecção for confiável.'}</small></div>
      </section>
    </div>

    <section class="profile-section">
      <div class="profile-section-heading"><div class="profile-section-icon">${icon('globe-2')}</div><div><h2>Conta Auto CodeZ</h2><p>Essas opções permanecem visíveis porque serão ligadas ao backend de conta antes do lançamento.</p></div></div>
      <div class="profile-provider-list">
        ${profileProviders.map((provider) => `<div class="profile-provider-row"><div class="profile-provider-icon">${icon(provider.icon)}</div><div class="profile-provider-copy"><strong>${provider.name}</strong><span>${provider.description}</span></div><button class="profile-secondary-button" type="button" disabled title="Será conectado ao serviço de conta Auto CodeZ.">Em breve</button></div>`).join('')}
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section-heading"><div class="profile-section-icon">${icon('shield')}</div><div><h2>Métodos de acesso</h2><p>Base passwordless-first planejada para a conta sincronizada.</p></div></div>
      <div class="profile-method-list">
        <div class="profile-method-row"><div class="profile-method-icon">${icon('fingerprint')}</div><div><strong>Passkeys</strong><span>Chaves de acesso seguras, sem senha tradicional.</span></div><span class="profile-method-state">Em breve</span></div>
        <div class="profile-method-row"><div class="profile-method-icon">${icon('mail')}</div><div><strong>Magic Link</strong><span>Acesso temporário por e-mail para recuperação e entrada rápida.</span></div><span class="profile-method-state">Em breve</span></div>
      </div>
    </section>

    <section class="profile-note">
      ${icon('shield')}
      <div><strong>Planejado, não simulado</strong><span>Google, GitHub, Microsoft, Passkeys e Magic Link continuam na interface como recursos planejados. Eles só serão habilitados quando autenticação, sessão e backend de sincronização estiverem realmente conectados.</span></div>
      <button class="profile-secondary-button enabled" type="button" data-profile-action="privacy">Privacidade</button>
    </section>`;
}

function closeProfile(): void {
  document.querySelector('.profile-overlay')?.remove();
  closeLegacyProfileModal();
  document.querySelector<HTMLElement>('.rail-button[data-action="profile"]')?.classList.remove('active');
}

function openSettingsSection(section: 'privacy' | 'local-ai'): void {
  closeProfile();
  document.querySelector<HTMLElement>('#ac-app-settings')?.click();
  window.setTimeout(() => {
    if (section === 'local-ai') document.querySelector<HTMLElement>('[data-local-ai-settings]')?.click();
    else document.querySelector<HTMLElement>('[data-settings-section="privacy"]')?.click();
  }, 80);
}

async function copyLocalId(): Promise<void> {
  const id = getAppPreferences().profile.id;
  const state = document.querySelector<HTMLElement>('[data-profile-save-state]');
  try {
    await navigator.clipboard.writeText(id);
    if (state) state.textContent = 'ID copiado.';
  } catch {
    if (state) state.textContent = 'Não foi possível copiar automaticamente.';
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-action="profile"]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void renderProfile();
    return;
  }
  if (target.closest('[data-profile-close]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeProfile();
    return;
  }
  if (target.closest('[data-profile-copy-id]')) {
    event.preventDefault();
    void copyLocalId();
    return;
  }
  const action = target.closest<HTMLElement>('[data-profile-action]')?.dataset.profileAction;
  if (action === 'providers') {
    closeProfile();
    document.querySelector<HTMLElement>('.api-key-rail-button')?.click();
    return;
  }
  if (action === 'local-ai') {
    openSettingsSection('local-ai');
    return;
  }
  if (action === 'privacy') openSettingsSection('privacy');
}, true);

document.addEventListener('submit', (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form?.matches('[data-profile-local-form]')) return;
  event.preventDefault();
  const input = form.querySelector<HTMLInputElement>('[data-profile-name-input]');
  const state = form.querySelector<HTMLElement>('[data-profile-save-state]');
  const displayName = input?.value.trim() || '';
  if (!displayName) {
    if (state) state.textContent = 'Informe um nome de exibição.';
    input?.focus();
    return;
  }
  const current = getAppPreferences();
  const next = updateAppPreferences({ profile: { ...current.profile, displayName } });
  const heading = document.querySelector<HTMLElement>('[data-profile-display-name]');
  if (heading) heading.textContent = next.profile.displayName;
  if (input) input.value = next.profile.displayName;
  if (state) state.textContent = 'Perfil salvo neste dispositivo.';
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.profile-overlay')) closeProfile();
});
