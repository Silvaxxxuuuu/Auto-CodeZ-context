const sections = [
  { id: 'general', label: 'Geral', icon: 'settings-2', description: 'Aparência e comportamento' },
  { id: 'ai', label: 'Inteligência', icon: 'sparkles', description: 'Providers e comportamento da IA' },
  { id: 'editor', label: 'Editor', icon: 'code-2', description: 'Preferências do editor' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', description: 'Shell e execução local' },
  { id: 'security', label: 'Segurança', icon: 'shield-check', description: 'Sessões e credenciais' },
  { id: 'sync', label: 'Sincronização', icon: 'refresh-cw', description: 'Estado e conflitos' },
] as const;

type SectionId = (typeof sections)[number]['id'];

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    'settings-2': '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    sparkles: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8L19 14Z"/>',
    'code-2': '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  };
  return `<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths['settings-2']}</svg>`;
};

const content: Record<SectionId, { eyebrow: string; title: string; description: string; rows: Array<[string, string, string]> }> = {
  general: {
    eyebrow: 'PREFERÊNCIAS', title: 'Geral', description: 'Ajustes que definem como o Auto CodeZ se apresenta e inicia.',
    rows: [
      ['Tema', 'Escuro', 'A interface atual usa o tema escuro do Auto CodeZ.'],
      ['Idioma', 'Português (Brasil)', 'Idioma principal da interface.'],
      ['Animações', 'Ativadas', 'Transições sutis da interface.'],
      ['Densidade', 'Confortável', 'Espaçamento padrão entre controles e conteúdo.'],
      ['Inicialização', 'Estado anterior', 'Mantém a última área de trabalho aberta.'],
    ],
  },
  ai: {
    eyebrow: 'IA', title: 'Inteligência', description: 'Preferências globais para providers, modelos e execução assistida.',
    rows: [
      ['Provider padrão', 'Automático', 'Será usado quando um novo chat não definir um provider.'],
      ['Modelo padrão', 'Automático', 'O modelo será resolvido de acordo com o provider disponível.'],
      ['Inteligência', 'Normal', 'Equilíbrio entre qualidade, velocidade e custo.'],
      ['Ferramentas', 'Permitidas', 'A disponibilidade real depende das capacidades e permissões.'],
      ['Aprovação', 'Acesso seguro', 'Operações sensíveis continuam sujeitas às regras de permissão.'],
    ],
  },
  editor: {
    eyebrow: 'EDITOR', title: 'Editor', description: 'Preferências que serão aplicadas ao ambiente de edição.',
    rows: [
      ['Fonte', 'Inter', 'Família tipográfica da interface e áreas de código.'],
      ['Tamanho', '13 px', 'Tamanho base previsto para o editor.'],
      ['Word wrap', 'Automático', 'Quebra de linhas conforme a largura disponível.'],
      ['Minimap', 'Ativo', 'Mapa lateral para navegação rápida em arquivos.'],
      ['Indentação', 'Detectar automaticamente', 'Respeita a estrutura existente do arquivo.'],
    ],
  },
  terminal: {
    eyebrow: 'AMBIENTE', title: 'Terminal', description: 'Comportamento do terminal e dos processos locais.',
    rows: [
      ['Shell', 'Padrão do sistema', 'Usa o shell configurado no Windows.'],
      ['Diretório inicial', 'Projeto ativo', 'Novas sessões começam no workspace selecionado.'],
      ['Histórico', 'Persistente', 'O histórico permanece associado ao projeto.'],
    ],
  },
  security: {
    eyebrow: 'PROTEÇÃO', title: 'Segurança', description: 'Credenciais, sessões e dispositivos ficam concentrados nesta área.',
    rows: [
      ['Credenciais', 'Protegidas localmente', 'Secrets locais usam o armazenamento seguro do Electron.'],
      ['Sessões', 'Gerenciar', 'Revogação e atividade de login serão exibidas aqui.'],
      ['Dispositivos', 'Gerenciar', 'Controle de dispositivos conectados à conta Auto CodeZ.'],
      ['Recuperação', 'Magic Link / provedores', 'Recuperação segue os métodos de acesso da conta.'],
    ],
  },
  sync: {
    eyebrow: 'CONTA', title: 'Sincronização', description: 'Estado do armazenamento local, nuvem e alterações pendentes.',
    rows: [
      ['Estado', 'Local', 'A conta ainda não está conectada neste dispositivo.'],
      ['Alterações pendentes', '0', 'Nenhuma operação de sincronização está aguardando envio.'],
      ['Conflitos', '0', 'Conflitos serão apresentados para decisão explícita do usuário.'],
      ['Projetos', 'Controle por projeto', 'Cada projeto poderá ser mantido localmente ou sincronizado.'],
    ],
  },
};

function clearLegacySettings(): void {
  document.querySelector<HTMLElement>('#modal-root')?.replaceChildren();
}

function renderSection(id: SectionId): void {
  const data = content[id];
  const body = document.querySelector<HTMLElement>('.settings-body');
  if (!body) return;
  body.innerHTML = `
    <header class="settings-section-header">
      <div class="settings-eyebrow">${data.eyebrow}</div>
      <h2>${data.title}</h2>
      <p>${data.description}</p>
    </header>
    <section class="settings-card">
      ${data.rows.map(([label, value, description]) => `
        <div class="settings-row">
          <div class="settings-row-copy"><strong>${label}</strong><span>${description}</span></div>
          <div class="settings-row-value"><span>${value}</span><button type="button" disabled aria-label="Editar ${label}">${icon('chevron-right')}</button></div>
        </div>
      `).join('')}
    </section>
    <div class="settings-footnote">A estrutura visual está pronta. Persistência e controles editáveis serão conectados aos módulos de configuração correspondentes.</div>`;
}

function renderSettings(initial: SectionId = 'general'): void {
  if (document.querySelector('.settings-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  clearLegacySettings();

  const overlay = document.createElement('section');
  overlay.className = 'settings-overlay';
  overlay.setAttribute('aria-label', 'Configurações');
  overlay.innerHTML = `
    <div class="settings-page">
      <header class="settings-header">
        <div><div class="settings-eyebrow">AUTO CODEZ</div><h1>Configurações</h1><p>Organize preferências, ambiente, segurança e sincronização em um único lugar.</p></div>
        <button class="settings-close" type="button" data-settings-close title="Fechar configurações" aria-label="Fechar configurações">${icon('x')}</button>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Categorias de configuração">
          ${sections.map((section) => `<button type="button" class="settings-nav-item ${section.id === initial ? 'active' : ''}" data-settings-section="${section.id}"><span class="settings-nav-icon">${icon(section.icon)}</span><span><strong>${section.label}</strong><small>${section.description}</small></span></button>`).join('')}
        </nav>
        <main class="settings-body"></main>
      </div>
    </div>`;

  shell.appendChild(overlay);
  renderSection(initial);
  overlay.querySelector<HTMLButtonElement>('[data-settings-close]')?.focus();
}

function closeSettings(): void {
  document.querySelector('.settings-overlay')?.remove();
  clearLegacySettings();
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-action="settings"]')) {
    event.preventDefault();
    event.stopPropagation();
    renderSettings();
    return;
  }
  if (target.closest('[data-settings-close]')) {
    event.preventDefault();
    closeSettings();
    return;
  }
  const sectionButton = target.closest<HTMLButtonElement>('[data-settings-section]');
  if (sectionButton) {
    const id = sectionButton.dataset.settingsSection as SectionId | undefined;
    if (!id || !content[id]) return;
    document.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === sectionButton));
    renderSection(id);
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.settings-overlay')) closeSettings();
});
