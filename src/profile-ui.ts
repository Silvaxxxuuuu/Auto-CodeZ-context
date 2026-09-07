import { getAppPreferences, updateAppPreferences } from './app-preferences';

const profileProviders = [
  { id: 'google', name: 'Google', description: 'Login e sincronização via conta Google.', icon: 'globe-2' },
  { id: 'github', name: 'GitHub', description: 'Identidade GitHub vinculada à mesma conta Auto CodeZ.', icon: 'github' },
  { id: 'microsoft', name: 'Microsoft', description: 'Identidade Microsoft vinculada à mesma conta Auto CodeZ.', icon: 'monitor' },
];

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    'user-round': '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    'globe-2': '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 19.3 4c.1-.4.5-2-.1-4 0 0-1.2-.4-4 1.3a13.4 13.4 0 0 0-6.4 0C6.1-.4 4.9 0 4.9 0c-.6 2-.2 3.6-.1 4A5.5 5.5 0 0 0 3.3 7.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    fingerprint: '<path d="M12 11a3 3 0 0 1 3 3v1"/><path d="M12 7a7 7 0 0 1 7 7v1"/><path d="M12 3a11 11 0 0 1 11 11v1"/><path d="M12 11a3 3 0 0 0-3 3v5"/><path d="M12 7a7 7 0 0 0-7 7v5"/><path d="M12 3A11 11 0 0 0 1 14v1"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-10 6L2 7"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  return `<svg class="profile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths['user-round']}</svg>`;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function closeLegacyProfileModal(): void {
  document.querySelector<HTMLElement>('#modal-root')?.replaceChildren();
}

function renderProfile(): void {
  if (document.querySelector('.profile-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  closeLegacyProfileModal();
  const preferences = getAppPreferences();
  const displayName = escapeHtml(preferences.profile.displayName);
  const localId = escapeHtml(preferences.profile.id);
  const platform = escapeHtml(navigator.platform || 'Desktop');

  const overlay = document.createElement('section');
  overlay.className = 'profile-overlay';
  overlay.setAttribute('aria-label', 'Perfil e conta');
  overlay.innerHTML = `
    <div class="profile-page">
      <header class="profile-header">
        <div>
          <div class="profile-eyebrow">CONTA</div>
          <h1>Perfil</h1>
          <p>Identidade local funcionando agora; conta cloud e login externo serão conectados sobre esta base.</p>
        </div>
        <button class="profile-close" type="button" data-profile-close title="Fechar perfil" aria-label="Fechar perfil">${icon('x')}</button>
      </header>

      <div class="profile-content">
        <section class="profile-card profile-identity-card">
          <div class="profile-avatar">${icon('user-round')}</div>
          <div class="profile-identity-copy">
            <strong data-profile-display-name>${displayName}</strong>
            <span>Perfil local</span>
            <small>Este perfil permanece disponível offline e será a identidade local vinculada à futura conta Auto CodeZ.</small>
          </div>
          <span class="profile-status profile-status-neutral">Local</span>
        </section>

        <div class="profile-grid">
          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('user-round')}</div>
              <div><h2>Identidade neste dispositivo</h2><p>Edite seu nome local e consulte a identidade persistente desta instalação.</p></div>
            </div>
            <form class="profile-local-form" data-profile-local-form>
              <label><span>Nome de exibição</span><input data-profile-name-input maxlength="80" value="${displayName}" autocomplete="off"></label>
              <label><span>ID local</span><div class="profile-id-row"><code data-profile-local-id>${localId}</code><button type="button" class="profile-secondary-button enabled" data-profile-copy-id>Copiar</button></div></label>
              <label><span>Plataforma</span><div class="profile-static-value">${platform}</div></label>
              <button class="profile-primary-button" type="submit">Salvar perfil</button>
              <span class="profile-save-state" data-profile-save-state aria-live="polite"></span>
            </form>
          </section>

          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('link')}</div>
              <div><h2>Conta Auto CodeZ</h2><p>Login externo será ligado ao serviço de conta sem substituir a identidade local.</p></div>
            </div>
            <div class="profile-provider-list">
              ${profileProviders.map((provider) => `
                <div class="profile-provider-row">
                  <div class="profile-provider-icon">${icon(provider.icon)}</div>
                  <div class="profile-provider-copy"><strong>${provider.name}</strong><span>${provider.description}</span></div>
                  <button class="profile-secondary-button" type="button" disabled title="Requer o serviço de conta Auto CodeZ.">Em breve</button>
                </div>
              `).join('')}
            </div>
          </section>
        </div>

        <div class="profile-grid profile-grid-secondary">
          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('shield-check')}</div>
              <div><h2>Métodos de acesso</h2><p>Modelo passwordless-first definido para a futura conta sincronizada.</p></div>
            </div>
            <div class="profile-method-list">
              <div class="profile-method-row"><div class="profile-method-icon">${icon('fingerprint')}</div><div><strong>Passkeys</strong><span>Chaves de acesso seguras, sem senha tradicional.</span></div><span class="profile-method-state">Não conectado</span></div>
              <div class="profile-method-row"><div class="profile-method-icon">${icon('mail')}</div><div><strong>Magic Link</strong><span>Acesso temporário por e-mail.</span></div><span class="profile-method-state">Não conectado</span></div>
            </div>
          </section>

          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('monitor')}</div>
              <div><h2>Este dispositivo</h2><p>A identidade local já persiste sem depender de login ou internet.</p></div>
            </div>
            <div class="profile-device-summary"><strong>${platform}</strong><span>Perfil local ativo</span><small>Backup e sincronização serão adicionados como camada separada e recuperável.</small></div>
          </section>
        </div>

        <section class="profile-note">
          ${icon('shield-check')}
          <div><strong>Conta cloud não é simulada</strong><span>Google, GitHub e Microsoft permanecem claramente indisponíveis até existir autenticação real, sessão e backend de sincronização.</span></div>
        </section>
      </div>
    </div>`;

  shell.appendChild(overlay);
  document.querySelector<HTMLElement>('.rail-button[data-action="profile"]')?.classList.add('active');
  overlay.querySelector<HTMLButtonElement>('[data-profile-close]')?.focus();
}

function closeProfile(): void {
  document.querySelector('.profile-overlay')?.remove();
  closeLegacyProfileModal();
  document.querySelector<HTMLElement>('.rail-button[data-action="profile"]')?.classList.remove('active');
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
    renderProfile();
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
  }
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
