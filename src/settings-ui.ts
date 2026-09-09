import { getAppPreferences, updateAppPreferences } from './app-preferences';

const sections = [
  { id: 'ai', label: 'IA e modelos', icon: 'sparkles', description: 'Modelo, raciocínio e credenciais' },
  { id: 'execution', label: 'Execução', icon: 'zap', description: 'Acesso do agente e aprovações' },
  { id: 'privacy', label: 'Privacidade', icon: 'shield-check', description: 'Dados locais e proteção de secrets' },
  { id: 'interface', label: 'Interface', icon: 'sliders', description: 'Densidade e movimento' },
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
type State = {
  providers: Array<{ id: string; displayName: string; requiresApiKey?: boolean }>;
  chats: Chat[];
  projects: unknown[];
};
type SettingsBridge = {
  getState: () => Promise<State>;
  listApiKeys?: () => Promise<unknown[]>;
  updateChatSettings: (input: {
    chatId: string;
    providerId: string;
    model: string;
    apiKeyId?: string;
    intelligence: IntelligenceLevel;
    permissionLevel: PermissionLevel;
  }) => Promise<Chat>;
};

const bridge = (window as unknown as { autoCodez?: SettingsBridge }).autoCodez;
if (!bridge?.getState || !bridge.updateChatSettings) throw new Error('Infraestrutura de configurações indisponível.');

const icon = (name: string): string => {
  const paths: Record<string, string> = {
    sparkles: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L19 14Z"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  return `<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sliders}</svg>`;
};

const sectionMeta: Record<SectionId, { eyebrow: string; title: string; description: string }> = {
  ai: {
    eyebrow: 'INTELIGÊNCIA',
    title: 'IA e modelos',
    description: 'Escolhas que mudam diretamente como o Auto CodeZ responde e trabalha no chat ativo.',
  },
  execution: {
    eyebrow: 'AGENTE',
    title: 'Execução',
    description: 'Controle a autonomia do agente sem enfraquecer as barreiras críticas de segurança.',
  },
  privacy: {
    eyebrow: 'LOCAL-FIRST',
    title: 'Privacidade',
    description: 'Veja quais proteções estão ativas e onde ficam suas credenciais e dados de trabalho.',
  },
  interface: {
    eyebrow: 'EXPERIÊNCIA',
    title: 'Interface',
    description: 'Somente preferências visuais que alteram a experiência do aplicativo inteiro.',
  },
};

let activeSection: SectionId = 'ai';
let renderToken = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function row(label: string, description: string, control: string): string {
  return `<div class="settings-row"><div class="settings-row-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span></div><div class="settings-row-value">${control}</div></div>`;
}

function badge(value: string, tone = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}">${escapeHtml(value)}</span>`;
}

function selectControl(name: string, value: string, options: Array<[string, string]>): string {
  return `<select class="settings-select" data-settings-control="${name}">${options.map(([id, label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
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

async function currentChat(): Promise<{ state: State; chat?: Chat }> {
  const state = await bridge.getState();
  return { state, chat: state.chats.find((item) => item.id === selectedChatId()) };
}

async function renderSection(id: SectionId): Promise<void> {
  activeSection = id;
  const token = ++renderToken;
  const body = document.querySelector<HTMLElement>('.settings-body');
  if (!body) return;
  const meta = sectionMeta[id];
  body.innerHTML = renderShell(meta, '<section class="settings-card"><div class="settings-loading">Carregando…</div></section>');

  if (id === 'ai') {
    const { state, chat } = await currentChat();
    if (token !== renderToken) return;
    if (!chat) {
      const card = `<section class="settings-card">${[
        row('Chat ativo', 'Abra ou crie um chat para configurar a IA usada naquela conversa.', actionButton('Ir para Chats', 'open-chats')),
        row('Providers', 'Cadastre chaves cloud ou use um runtime local compatível.', actionButton('Gerenciar providers', 'open-api-keys')),
      ].join('')}</section>`;
      body.innerHTML = renderShell(meta, card, 'As escolhas de IA pertencem ao chat. O Auto CodeZ não inventa um modelo global escondido.');
      return;
    }
    const provider = state.providers.find((item) => item.id === chat.providerId);
    const card = `<section class="settings-card">${[
      row('Provider atual', 'Serviço que receberá a próxima mensagem deste chat.', badge(provider?.displayName || chat.providerId, 'good')),
      row('Modelo atual', 'Modelo persistido no chat e usado na próxima requisição.', badge(chat.model)),
      row('Raciocínio', 'Define quanto esforço o runtime pode solicitar quando o modelo suporta níveis de raciocínio.', selectControl('chat-intelligence', chat.intelligence, [['low', 'Baixo'], ['normal', 'Normal'], ['high', 'Alto'], ['maximum', 'Máximo']])),
      row('Credenciais e modelos', 'Troque provider, chave e catálogo de modelos em um fluxo dedicado.', actionButton('Gerenciar providers', 'open-api-keys')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, provider?.requiresApiKey === false ? 'Este chat usa um provider que não exige API key.' : 'Credenciais ficam fora do renderer e não são exibidas em texto aberto.');
    return;
  }

  if (id === 'execution') {
    const { chat } = await currentChat();
    if (token !== renderToken) return;
    if (!chat) {
      const card = `<section class="settings-card">${row('Chat ativo', 'A autonomia é configurada por conversa para evitar permissões globais acidentais.', actionButton('Ir para Chats', 'open-chats'))}</section>`;
      body.innerHTML = renderShell(meta, card);
      return;
    }
    const card = `<section class="settings-card">${[
      row('Autonomia do agente', 'Controla quais ferramentas o agente pode tentar usar neste chat.', selectControl('chat-permission', chat.permissionLevel, [['read-only', 'Somente leitura'], ['safe', 'Seguro'], ['ask', 'Perguntar quando necessário'], ['unrestricted', 'Amplo acesso']])),
      row('Comandos do sistema', 'run_command continua exigindo aprovação explícita antes de iniciar um processo.', badge('Aprovação obrigatória', 'good')),
      row('Escopo de arquivos', 'Allowed Paths limita leitura, contexto e ferramentas ao escopo autorizado da tarefa.', badge('Protegido', 'good')),
      row('Alterações', 'Shadow workspace, checkpoints e revisão evitam publicar mudanças sem rastreabilidade.', badge('Protegidas', 'good')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, '“Amplo acesso” não desativa as barreiras críticas do runtime.');
    return;
  }

  if (id === 'privacy') {
    const keys = bridge.listApiKeys ? await bridge.listApiKeys().catch((): unknown[] => []) : [];
    if (token !== renderToken) return;
    const card = `<section class="settings-card">${[
      row('Credenciais de IA', 'Quantidade de credenciais salvas no cofre local.', badge(`${keys.length} cadastrada${keys.length === 1 ? '' : 's'}`)),
      row('Secrets do projeto', '.env, .npmrc e outros caminhos sensíveis ficam fora do contexto automático e do sandbox de comando.', badge('Filtrados', 'good')),
      row('Dados de trabalho', 'Chats, projetos e preferências permanecem locais enquanto nenhum serviço de sincronização estiver ativo.', badge('Local-first', 'good')),
      row('Cofre de credenciais', 'Adicione, renomeie ou remova credenciais de providers.', actionButton('Abrir cofre', 'open-api-keys')),
    ].join('')}</section>`;
    body.innerHTML = renderShell(meta, card, 'A interface mostra apenas o estado das proteções que realmente existem hoje.');
    return;
  }

  const preferences = getAppPreferences();
  const card = `<section class="settings-card">${[
    row('Movimento da interface', 'Desative transições não essenciais se preferir uma interface mais direta.', toggleControl('animations', preferences.general.animations)),
    row('Densidade', 'Altera o espaçamento global de navegação, chats, perfil e configurações.', selectControl('density', preferences.general.density, [['comfortable', 'Confortável'], ['compact', 'Compacta']])),
  ].join('')}</section>`;
  if (token === renderToken) body.innerHTML = renderShell(meta, card, 'Configurações de editor de código não fazem mais parte das preferências globais do produto.');
}

function clearLegacySettings(): void {
  document.querySelector<HTMLElement>('#modal-root')?.replaceChildren();
}

function renderSettings(initial: SectionId = 'ai'): void {
  if (document.querySelector('.settings-overlay')) return;
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  clearLegacySettings();
  activeSection = initial;
  const overlay = document.createElement('section');
  overlay.className = 'settings-overlay';
  overlay.setAttribute('aria-label', 'Configurações');
  overlay.innerHTML = `<div class="settings-page"><header class="settings-header"><div><div class="settings-eyebrow">AUTO CODEZ</div><h1>Configurações</h1><p>Controles que mudam de verdade como o Auto CodeZ pensa, executa e protege seu trabalho.</p></div><button class="settings-close" type="button" data-settings-close title="Fechar configurações" aria-label="Fechar configurações">${icon('x')}</button></header><div class="settings-layout"><nav class="settings-nav" aria-label="Categorias de configuração">${sections.map((section) => `<button type="button" class="settings-nav-item ${section.id === initial ? 'active' : ''}" data-settings-section="${section.id}"><span class="settings-nav-icon">${icon(section.icon)}</span><span><strong>${section.label}</strong><small>${section.description}</small></span></button>`).join('')}</nav><main class="settings-body"></main></div></div>`;
  shell.appendChild(overlay);
  void renderSection(initial);
  overlay.querySelector<HTMLButtonElement>('[data-settings-close]')?.focus();
}

function closeSettings(): void {
  document.querySelector('.settings-overlay')?.remove();
  clearLegacySettings();
}

async function updateChatSetting(kind: 'intelligence' | 'permissionLevel', value: string): Promise<void> {
  const { chat } = await currentChat();
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
  await renderSection(activeSection);
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
    void renderSection('interface');
    return;
  }
  if (control === 'density' && target instanceof HTMLSelectElement) {
    const current = getAppPreferences();
    const density = target.value === 'compact' ? 'compact' : 'comfortable';
    updateAppPreferences({ general: { ...current.general, density } });
    void renderSection('interface');
    return;
  }
  if (control === 'chat-intelligence' && target instanceof HTMLSelectElement) {
    target.disabled = true;
    void updateChatSetting('intelligence', target.value).catch((error) => {
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível atualizar o raciocínio.' }));
      void renderSection(activeSection);
    });
    return;
  }
  if (control === 'chat-permission' && target instanceof HTMLSelectElement) {
    target.disabled = true;
    void updateChatSetting('permissionLevel', target.value).catch((error) => {
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível atualizar a autonomia do agente.' }));
      void renderSection(activeSection);
    });
  }
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.settings-overlay')) closeSettings();
});
