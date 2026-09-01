const profileProviders = [
  { id: 'google', name: 'Google', description: 'Use sua conta Google para acessar o Auto CodeZ.', icon: 'globe-2' },
  { id: 'github', name: 'GitHub', description: 'Vincule sua identidade do GitHub ao mesmo perfil.', icon: 'github' },
  { id: 'microsoft', name: 'Microsoft', description: 'Adicione sua conta Microsoft como método de acesso.', icon: 'monitor' },
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

function renderProfile(): void {
  if (document.querySelector('.profile-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;

  const overlay = document.createElement('section');
  overlay.className = 'profile-overlay';
  overlay.setAttribute('aria-label', 'Perfil e conta');
  overlay.innerHTML = `
    <div class="profile-page">
      <header class="profile-header">
        <div>
          <div class="profile-eyebrow">CONTA</div>
          <h1>Perfil</h1>
          <p>Gerencie sua identidade e os métodos usados para acessar o Auto CodeZ.</p>
        </div>
        <button class="profile-close" type="button" data-profile-close title="Fechar perfil" aria-label="Fechar perfil">${icon('x')}</button>
      </header>

      <div class="profile-content">
        <section class="profile-card profile-identity-card">
          <div class="profile-avatar">${icon('user-round')}</div>
          <div class="profile-identity-copy">
            <strong>Sua conta Auto CodeZ</strong>
            <span>Não conectada</span>
            <small>Conecte uma identidade para sincronizar sua conta entre dispositivos.</small>
          </div>
          <span class="profile-status profile-status-neutral">Offline</span>
        </section>

        <div class="profile-grid">
          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('link')}</div>
              <div><h2>Contas vinculadas</h2><p>Identidades externas pertencentes à mesma conta Auto CodeZ.</p></div>
            </div>
            <div class="profile-provider-list">
              ${profileProviders.map((provider) => `
                <div class="profile-provider-row">
                  <div class="profile-provider-icon">${icon(provider.icon)}</div>
                  <div class="profile-provider-copy"><strong>${provider.name}</strong><span>${provider.description}</span></div>
                  <button class="profile-secondary-button" type="button" disabled title="A autenticação externa será conectada ao servidor da conta.">Vincular</button>
                </div>
              `).join('')}
            </div>
            <button class="profile-link-button" type="button" disabled>+ Vincular outra conta</button>
          </section>

          <section class="profile-section">
            <div class="profile-section-heading">
              <div class="profile-section-icon">${icon('shield-check')}</div>
              <div><h2>Métodos de acesso</h2><p>Opções de autenticação sem senha para a mesma conta.</p></div>
            </div>
            <div class="profile-method-list">
              <div class="profile-method-row"><div class="profile-method-icon">${icon('fingerprint')}</div><div><strong>Passkeys</strong><span>Chaves de acesso para login seguro.</span></div><span class="profile-method-state">Nenhuma</span></div>
              <div class="profile-method-row"><div class="profile-method-icon">${icon('mail')}</div><div><strong>Magic Link</strong><span>Acesso por link temporário enviado ao e-mail.</span></div><span class="profile-method-state">Não configurado</span></div>
            </div>
          </section>
        </div>

        <section class="profile-note">
          ${icon('shield-check')}
          <div><strong>Segurança permanece separada do Perfil</strong><span>Sessões, dispositivos conectados, recuperação e eventos de segurança ficarão na área Segurança.</span></div>
        </section>
      </div>
    </div>`;

  shell.appendChild(overlay);
  const railButton = document.querySelector<HTMLElement>('.rail-button[data-action="profile"]');
  railButton?.classList.add('active');
  overlay.querySelector<HTMLButtonElement>('[data-profile-close]')?.focus();
}

function closeProfile(): void {
  document.querySelector('.profile-overlay')?.remove();
  document.querySelector<HTMLElement>('.rail-button[data-action="profile"]')?.classList.remove('active');
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-action="profile"]')) {
    event.preventDefault();
    renderProfile();
    return;
  }
  if (target.closest('[data-profile-close]')) {
    event.preventDefault();
    closeProfile();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.profile-overlay')) closeProfile();
});
