import { getAppPreferences, updateAppPreferences } from './app-preferences';

const sections = [
  { id: 'general', label: 'Geral', icon: 'settings-2', description: 'Aparência e comportamento' },
  { id: 'ai', label: 'Inteligência', icon: 'sparkles', description: 'Modelo, raciocínio e acesso' },
  { id: 'editor', label: 'Editor', icon: 'code-2', description: 'Preferências do editor' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', description: 'Shell e execução local' },
  { id: 'security', label: 'Segurança', icon: 'shield-check', description: 'Credenciais e execução' },
  { id: 'sync', label: 'Sincronização', icon: 'refresh-cw', description: 'Conta, backup e conflitos' },
] as const;

type SectionId = (typeof sections)[number]['id'];
type IntelligenceLevel = 'low' | 'normal' | 'high' | 'maximum';
type PermissionLevel = 'read-only' | 'safe' | 'ask' | 'unrestricted';
type Chat = {
  id: string;
  providerId: string;
  model: string;
  apiKeyId?: string;
  intelligence: IntelligenceLevel;
  permissionLevel: PermissionLevel;
};
type State = { providers: Array<{ id: string; displayName: string }>; chats: Chat[]; projects: unknown[] };
type SettingsBridge = {
  getState: () => Promise<State>;
  listApiKeys?: () => Promise<unknown[]>;
  updateChatSettings: (input: { chatId: string; providerId: string; model: string; apiKeyId?: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }) => Promise<Chat>;
};

const bridge = (window as unknown as { autoCodez?: SettingsBridge }).autoCodez;
if (!bridge?.getState || !bridge.updateChatSettings) throw new Error('Infraestrutura de configurações indisponível.');

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    'settings-2': '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    sparkles: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L19 14Z"/>',
    'code-2': '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    'refresh-cw': '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  return `<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths['settings-2']}</svg>`;
};

const sectionMeta: Record<SectionId, { eyebrow: string; title: string; description: string }> = {
  general: { eyebrow: 'PREFERÊNCIAS', title: 'Geral', description: 'Ajustes locais aplicados imediatamente à interface.' },
  ai: { eyebrow: 'IA', title: 'Inteligência', description: 'Configurações reais do chat atualmente selecionado.' },
  editor: { eyebrow: 'EDITOR', title: 'Editor', description: 'Estado atual do editor e da revisão de alterações.' },
  terminal: { eyebrow: 'AMBIENTE', title: 'Terminal', description: 'Estado atual do terminal PTY e da execução local.' },
  security: { eyebrow: 'PROTEÇÃO', title: 'Segurança', description: 'Proteções ativas para credenciais e execução.' },
  sync: { eyebrow: 'CONTA', title: 'Sincronização', description: 'Fundação local pronta para conta, backup e sincronização.' },
};

let activeSection: SectionId = 'general';
let renderToken = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function row(label: string, description: string, control: string): string {
  return `<div class="settings-row"><div class="settings-row-copy"><strong>${label}</strong><span>${description}</span></div><div class="settings-row-value">${control}</div></div>`;
}

function badge(value: string, tone = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}">${escapeHtml(value)}</span>`;
}

function selectControl(name: string, value: string, options: Array<[string, string]>, disabled = false): string {
  return `<select class="settings-select" data-settings-control="${name}" ${disabled ? 'disabled' : ''}>${options.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
}

function toggleControl(name: string, checked: boolean): string {
  return `<label class="settings-toggle"><input type="checkbox" data-settings-control="${name}" ${checked ? 'checked' : ''}><span aria-hidden="true"></span><strong>${checked ? 'Ativado' : 'Desativado'}</strong></label>`;
}

function actionButton(label: string, action: string): string {
  return `<button class="settings-action-button" type="button" data-settings-action="${action}">${escapeHtml(label)}</button>`;
}

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function renderShell(meta: { eyebrow: string; title: string; description: string }, card: string, footnote = ''): string {
  return `<header class="settings-section-header"><div class="settings-eyebrow">${meta.eyebrow}</div><h2>${meta.title}</h2><p>${meta.description}</p></header>${card}${footnote ? `<div class="settings-footnote">${footnote}</div>` : ''}`;
}

async function renderSection(id: SectionId): Promise<void> {
  activeSection = id;
  const token = ++renderToken;
  const body = document.querySelector<HTMLElement>('.settings-body');
  if (!body) return;
  const meta = sectionMeta[id];
  body.innerHTML = renderShell(meta, '<section class="settings-card"><div class="settings-loading">Carregando…</div></section>');

  if (id === 'general') {
    const preferences = getAppPreferences();
    const card = `<section class="settings-card">${[
      row('Tema', 'O tema escuro permanece como identidade visual atual do Auto CodeZ.', badge('Escuro', 'locked')),
      row('Animações', 'Ativa ou remove transições e animações não essenciais imediatamente.', toggleControl('animations', preferences.general.animations)),
      row('Densidade', 'Controla o espaçamento de chats, navegação, configurações e perfil.', selectControl('density', preferences.general.density, [['comfortable', 'Confortável'], ['compact', 'Compacta']])),
      row('Idioma', 'Idioma atual da interface. A infraestrutura de tradução entra em uma etapa própria.', badge('Português (Brasil)', 'locked')),
    ].join('')}</section>`;
    if (token === renderToken) body.innerHTML = renderShell(meta, card, 'Preferências visuais são locais e persistem neste dispositivo.');
    return;
  }

  if (id === 'ai') {
    const state = await bridge.getState();
    if (token !== renderToken) return;
    const chatId = selectedChatId();
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) {
      const card = `<section class="settings-card">${row('Chat ativo', 'Abra ou crie um chat para editar modelo, raciocínio e nível de acesso.', actionButton('Ir para Chats', 'open-chats'))}${row('API Keys', 'Cadastre providers e credenciais no gerenciador de IA.', actionButton('Gerenciar API Keys', 'open-api-keys'))}</section>`;
      body.innerHTML = renderShell(meta, card, 'Estas opções não inventam defaults globais: elas editam somente um chat real selecionado.');
      return;
    }
    const provider = state.providers.find((item) => item.id === chat.providerId)?.displayName || chat.providerId;
    const card = `<section class="settings-card">${[
      row('Provider', 'Provider realmente associado ao chat ativo.', badge(provider)),
      row('Modelo', 'Modelo persistido para este chat.', badge(chat.model)),
      row('Inteligência', 'O runtime traduz o nível escolhido para o esforço realmente suportado pelo modelo.', selectControl('chat-intelligence', chat.intelligence, [['low', 'Baixo'], ['normal', 'Normal'], ['high', 'Alto'], ['maximum', 'Máximo']])),
      row('Nível de acesso', 'Define a política de ferramentas deste chat. Shell continua exigindo aprovação explícita.', selectControl('chat-permission', chat.permissionLevel, [['read-only', 'Somente leitura'], ['safe', 'Acesso seguro'], ['ask', 'Acesso solicitado'], ['unrestricted', 'Acesso irrestrito']])),
      row('API Keys', 'Providers, chaves e modelos disponíveis são gerenciados separadamente.', actionButton('Gerenciar API Keys', 'open-api-keys')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, 'Alterações de Inteligência e acesso são persistidas no ChatManager e usadas na próxima requisição.');
    return;
  }

  if (id === 'editor') {
    const card = `<section class="settings-card">${[
      row('Monaco Editor', 'Editor e Diff Review usam Monaco 0.56 empacotado no aplicativo.', badge('Ativo', 'good')),
      row('Diff Review', 'Alterações de arquivo podem ser revisadas antes da aplicação.', badge('Ativo', 'good')),
      row('Edição incremental', 'replace_text, replace_range, insert_before/after e replace_symbol reduzem reescritas inteiras.', badge('Ativa', 'good')),
      row('Preferências avançadas', 'Fonte, word wrap e minimap serão conectados ao Monaco como próximo incremento desta área.', badge('Próximo bloco', 'locked')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, 'Nenhuma opção é exibida como editável antes de existir efeito real no Monaco.');
    return;
  }

  if (id === 'terminal') {
    const card = `<section class="settings-card">${[
      row('Terminal PTY', 'O terminal usa sessão PTY real com node-pty e xterm.js.', badge('Ativo', 'good')),
      row('Shell', 'Novas sessões usam o shell padrão resolvido pelo runtime.', badge('Sistema')),
      row('Histórico', 'O histórico é persistido pelo TerminalService.', badge('Persistente', 'good')),
      row('Processos', 'Sessões podem ser encerradas pelo runtime e são verificadas no teste visual empacotado.', badge('Controlados', 'good')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card);
    return;
  }

  if (id === 'security') {
    const keys = bridge.listApiKeys ? await bridge.listApiKeys().catch((): unknown[] => []) : [];
    if (token !== renderToken) return;
    const card = `<section class="settings-card">${[
      row('Credenciais de IA', 'Chaves cadastradas atualmente no cofre local do Auto CodeZ.', badge(`${keys.length} cadastrada${keys.length === 1 ? '' : 's'}`)),
      row('Shell do agente', 'Todo run_command exige aprovação explícita antes do processo iniciar, inclusive em unrestricted.', badge('Aprovação obrigatória', 'good')),
      row('Command sandbox', 'Workspace, HOME, config, cache e temp são materializados em ambiente temporário endurecido.', badge('Ativo', 'good')),
      row('Secrets', '.env, .npmrc, chaves e outros paths sensíveis são excluídos do contexto e do command sandbox.', badge('Protegidos', 'good')),
      row('API Keys', 'Abra o cofre de credenciais para adicionar, renomear ou remover chaves.', actionButton('Gerenciar API Keys', 'open-api-keys')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, 'O shell ainda não é descrito como sandbox de sistema operacional completo; AppContainer permanece em spike separado.');
    return;
  }

  const card = `<section class="settings-card">${[
    row('Modo atual', 'Chats, projetos e configurações permanecem locais neste dispositivo.', badge('Local-first', 'good')),
    row('Conta Auto CodeZ', 'Login Google, GitHub, Microsoft, Passkeys e Magic Link entram no próximo bloco de conta.', badge('Não conectada')),
    row('Backup', 'O BackupManager ainda não foi conectado à interface. Ele será implementado antes de habilitar sincronização remota.', badge('Pendente', 'locked')),
    row('Conflitos', 'O modelo de sync já prevê conflitos explícitos; nenhum servidor remoto está ativo neste momento.', badge('0')),
  ].join('')}</section>`;
  body.innerHTML = renderShell(meta, card, 'A UI agora distingue fatos implementados de recursos planejados; controles inexistentes não aparecem habilitados.');
}

function clearLegacySettings(): void {
  document.querySelector<HTMLElement>('#modal-root')?.replaceChildren();
}

function renderSettings(initial: SectionId = 'general'): void {
  if (document.querySelector('.settings-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  clearLegacySettings();
  activeSection = initial;
  const overlay = document.createElement('section');
  overlay.className = 'settings-overlay';
  overlay.setAttribute('aria-label', 'Configurações');
  overlay.innerHTML = `<div class="settings-page"><header class="settings-header"><div><div class="settings-eyebrow">AUTO CODEZ</div><h1>Configurações</h1><p>Preferências reais, estado do ambiente e controles do chat em um único lugar.</p></div><button class="settings-close" type="button" data-settings-close title="Fechar configurações" aria-label="Fechar configurações">${icon('x')}</button></header><div class="settings-layout"><nav class="settings-nav" aria-label="Categorias de configuração">${sections.map((section) => `<button type="button" class="settings-nav-item ${section.id === initial ? 'active' : ''}" data-settings-section="${section.id}"><span class="settings-nav-icon">${icon(section.icon)}</span><span><strong>${section.label}</strong><small>${section.description}</small></span></button>`).join('')}</nav><main class="settings-body"></main></div></div>`;
  shell.appendChild(overlay);
  void renderSection(initial);
  overlay.querySelector<HTMLButtonElement>('[data-settings-close]')?.focus();
}

function closeSettings(): void {
  document.querySelector('.settings-overlay')?.remove();
  clearLegacySettings();
}

async function updateChatSetting(kind: 'intelligence' | 'permissionLevel', value: string): Promise<void> {
  const state = await bridge.getState();
  const chatId = selectedChatId();
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) throw new Error('Nenhum chat ativo para atualizar.');
  const intelligence = kind === 'intelligence' ? value as IntelligenceLevel : chat.intelligence;
  const permissionLevel = kind === 'permissionLevel' ? value as PermissionLevel : chat.permissionLevel;
  await bridge.updateChatSettings({
    chatId: chat.id,
    providerId: chat.providerId,
    model: chat.model,
    apiKeyId: chat.apiKeyId,
    intelligence,
    permissionLevel,
  });
  document.querySelector<HTMLElement>(`.chat-item.selected[data-chat="${CSS.escape(chat.id)}"]`)?.click();
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  await renderSection('ai');
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const legacySettingsButton = target.closest<HTMLElement>('#ac-app-settings');
  const settingsAction = target.closest<HTMLElement>('[data-action="settings"]');
  if (legacySettingsButton || settingsAction) {
    event.preventDefault();
    event.stopImmediatePropagation();
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
    if (!id || !sectionMeta[id]) return;
    document.querySelectorAll('[data-settings-section]').forEach((item) => item.classList.toggle('active', item === sectionButton));
    void renderSection(id);
    return;
  }
  const action = target.closest<HTMLElement>('[data-settings-action]')?.dataset.settingsAction;
  if (action === 'open-api-keys') {
    closeSettings();
    document.querySelector<HTMLElement>('.api-key-rail-button')?.click();
    return;
  }
  if (action === 'open-chats') {
    closeSettings();
    document.querySelector<HTMLElement>('.rail-button[data-panel="chats"]')?.click();
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target) return;
  const control = target.dataset.settingsControl;
  if (!control) return;
  if (control === 'animations' && target instanceof HTMLInputElement) {
    const current = getAppPreferences();
    updateAppPreferences({ general: { ...current.general, animations: target.checked } });
    void renderSection('general');
    return;
  }
  if (control === 'density' && target instanceof HTMLSelectElement) {
    const current = getAppPreferences();
    const density = target.value === 'compact' ? 'compact' : 'comfortable';
    updateAppPreferences({ general: { ...current.general, density } });
    void renderSection('general');
    return;
  }
  if (control === 'chat-intelligence' && target instanceof HTMLSelectElement) {
    target.disabled = true;
    void updateChatSetting('intelligence', target.value).catch((error) => {
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível atualizar a Inteligência.' }));
      void renderSection(activeSection);
    });
    return;
  }
  if (control === 'chat-permission' && target instanceof HTMLSelectElement) {
    target.disabled = true;
    void updateChatSetting('permissionLevel', target.value).catch((error) => {
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível atualizar o nível de acesso.' }));
      void renderSection(activeSection);
    });
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.settings-overlay')) closeSettings();
});
