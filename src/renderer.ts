import './index.css';

type ProviderSummary = { id: string; displayName: string; configured: boolean; selectedModel?: string; model?: string; apiKeyConfigured: boolean };
type Model = { id: string; name: string; providerId: string; capabilities: string[]; reasoningLevels?: string[] };
type Change = { path: string; type: string; before: string; after: string; addedLines: number; removedLines: number };
type Message = { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt?: number; toolCallId?: string; toolName?: string; changes?: Change[] };
type Chat = { id: string; title: string; projectId?: string; providerId: string; model: string; intelligence: 'low' | 'normal' | 'high' | 'maximum'; permissionLevel: 'read-only' | 'safe' | 'ask' | 'unrestricted'; messages: Message[]; createdAt: number; updatedAt: number };
type Project = { id: string; name: string; rootPath: string; createdAt: number; updatedAt: number };
type IntelligenceLevel = Chat['intelligence'];
type PermissionLevel = Chat['permissionLevel'];
type StreamEvent = { type: 'start' | 'delta' | 'activity' | 'tool_call' | 'usage' | 'complete' | 'approval_required' | 'error'; text?: string; activity?: { message: string; status: string }; toolCall?: { id: string; name: string; input: Record<string, unknown> }; pendingApprovalIds?: string[]; error?: string };
type Approval = { id: string; projectId: string; permissionLevel: string; toolCall: { id: string; name: string; input: Record<string, unknown> }; createdAt: number };
type ExecutionState = 'idle' | 'running' | 'waiting_approval' | 'failed';

declare global {
  interface Window {
    autoCodez: {
      getState: () => Promise<{ providers: ProviderSummary[]; chats: Chat[]; projects: Project[] }>;
      listModels: (providerId: string) => Promise<Model[]>;
      saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => Promise<{ providers: ProviderSummary[]; models: Model[] }>;
      removeProvider: (providerId: string) => Promise<ProviderSummary[]>;
      createChat: (input: { providerId?: string; model?: string; intelligence: string; permissionLevel: string; projectId?: string }) => Promise<Chat>;
      deleteChat: (chatId: string) => Promise<Chat[]>;
      updateChatSettings: (input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }) => Promise<Chat>;
      streamChat: (input: { chatId: string; content: string }) => Promise<{ pendingApprovalIds: string[]; chat: Chat }>;
      onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
      listApprovals: () => Promise<Approval[]>;
      approveTool: (approvalId: string) => Promise<{ chatId?: string; messages?: Message[]; pendingApprovalIds?: string[] }>;
      denyTool: (approvalId: string) => Promise<{ chatId?: string; messages?: Message[]; pendingApprovalIds?: string[] }>;
      onActivity: (listener: (event: { message?: string; status?: string }) => void) => () => void;
      terminal: {
        start: (input: { projectId: string; command: string }) => Promise<unknown>;
        kill: (sessionId: string) => Promise<unknown>;
        listSessions: () => Promise<unknown[]>;
        getOutput: (sessionId: string) => Promise<unknown>;
        listHistory: (projectId?: string) => Promise<unknown[]>;
        clearHistory: (projectId?: string) => Promise<void>;
        onEvent: (listener: (event: unknown) => void) => () => void;
      };
      git: {
        status: (projectId: string) => Promise<{ branch: string; ahead: number; behind: number; clean: boolean; files: Array<{ path: string; index: string; worktree: string }> }>;
        branches: (projectId: string) => Promise<Array<{ name: string; current: boolean; upstream?: string }>>;
        diff: (projectId: string) => Promise<string>;
        log: (input: { projectId: string; limit?: number }) => Promise<Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>>;
      };
      createProject: (input: { name: string; rootPath: string }) => Promise<Project>;
      openFolder: () => Promise<string | null>;
    };
  }
}

const intelligence: ReadonlyArray<[IntelligenceLevel, string, string]> = [
  ['low', 'Baixo', 'Respostas rápidas, com menor esforço'],
  ['normal', 'Normal', 'Equilíbrio entre qualidade, velocidade e custo'],
  ['high', 'Alto', 'Mais esforço e contexto quando disponível'],
  ['maximum', 'Máximo', 'Maior esforço permitido pelo modelo'],
];

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Elemento #app não encontrado.');

let providers: ProviderSummary[] = [];
let chats: Chat[] = [];
let projects: Project[] = [];
let activeChat: Chat | null = null;
let activePanel = 'chats';
let activeProjectId: string | undefined;
let composerIntelligence: IntelligenceLevel = 'normal';
let intelligenceMenuOpen = false;
let executionState: ExecutionState = 'idle';
let streamingText = '';
let streamingActivity: string[] = [];
let pendingApprovals: Approval[] = [];
let lastError = '';
let retryContent = '';
let lastSubmittedContent = '';

app.innerHTML = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Auto CodeZ</span></div>
    <div class="topbar-actions"></div>
  </header>
  <div class="body">
    <aside class="rail">
      <button class="rail-button active" data-panel="chats" title="Chats" aria-label="Chats"></button>
      <button class="rail-button" data-panel="projects" title="Projetos" aria-label="Projetos"></button>
      <button class="rail-button" data-panel="plugins" title="Plugins" aria-label="Plugins"></button>
      <div class="rail-spacer"></div>
      <button class="rail-button" data-action="profile" title="Perfil" aria-label="Perfil"></button>
    </aside>
    <aside class="nav-panel" id="nav-panel"></aside>
    <main class="chat-area">
      <section class="chat-header" id="chat-header"></section>
      <section class="messages" id="messages"></section>
      <section class="composer-wrap">
        <div class="composer">
          <button class="attach-button" data-action="attachments" title="Anexar conteúdo" aria-label="Anexar conteúdo"></button>
          <textarea id="prompt" rows="1" placeholder="Digite uma mensagem..." aria-label="Mensagem"></textarea>
          <div class="composer-divider" aria-hidden="true"></div>
          <div class="intelligence-control">
            <button class="intelligence-button" id="intelligence-button" aria-haspopup="menu" aria-expanded="false">
              <span class="intelligence-brain" aria-hidden="true"></span>
              <span class="intelligence-text">Raciocínio</span>
              <span class="intelligence-current">Normal</span>
              <span class="intelligence-chevron" aria-hidden="true"></span>
            </button>
            <div class="intelligence-menu" id="intelligence-menu" role="menu" hidden></div>
          </div>
          <button class="send-button" id="send-button" title="Enviar" aria-label="Enviar"></button>
        </div>
        <div class="composer-hint">A IA selecionada neste chat trabalha dentro das permissões configuradas.</div>
      </section>
    </main>
    <aside class="right-rail" id="right-rail"></aside>
  </div>
</div>
<div class="modal-root" id="modal-root"></div>
`;

const navPanel = document.querySelector<HTMLDivElement>('#nav-panel')!;
const chatHeader = document.querySelector<HTMLElement>('#chat-header')!;
const messages = document.querySelector<HTMLElement>('#messages')!;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
const sendButton = document.querySelector<HTMLButtonElement>('#send-button')!;
const intelligenceButton = document.querySelector<HTMLButtonElement>('#intelligence-button')!;
const intelligenceMenu = document.querySelector<HTMLDivElement>('#intelligence-menu')!;
const modalRoot = document.querySelector<HTMLDivElement>('#modal-root')!;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function providerName(id: string): string {
  if (id === 'unconfigured') return 'IA não configurada';
  return providers.find((provider) => provider.id === id)?.displayName || id;
}

function intelligenceLabel(level: string): string {
  return intelligence.find((item) => item[0] === level)?.[1] || 'Normal';
}

function intelligenceDescription(level: IntelligenceLevel): string {
  return intelligence.find((item) => item[0] === level)?.[2] || '';
}

function setExecutionState(state: ExecutionState, error = ''): void {
  executionState = state;
  lastError = error;
  renderMessages();
  renderComposer();
}

function setIntelligenceMenu(open: boolean): void {
  intelligenceMenuOpen = open;
  intelligenceMenu.hidden = !open;
  intelligenceButton.setAttribute('aria-expanded', String(open));
  intelligenceButton.classList.toggle('open', open);
  if (open) renderIntelligenceMenu();
}

function renderIntelligenceMenu(): void {
  intelligenceMenu.innerHTML = intelligence.map(([value, label]) => `
    <div class="intelligence-option ${value === composerIntelligence ? 'selected' : ''}" data-intelligence-option="${value}" role="menuitemradio" aria-checked="${value === composerIntelligence}">
      <span class="intelligence-option-main"><span class="intelligence-option-label">${label}</span></span>
      <button class="info-button" data-intelligence-info="${value}" title="Informações sobre ${label}" aria-label="Informações sobre ${label}"></button>
    </div>
  `).join('');
}

function renderNav(): void {
  document.querySelectorAll('.rail-button').forEach((button) => button.classList.toggle('active', button.getAttribute('data-panel') === activePanel));
  if (activePanel === 'projects') {
    const project = activeProjectId ? projects.find((item) => item.id === activeProjectId) : undefined;
    const projectChats = project ? chats.filter((chat) => chat.projectId === project.id) : [];
    navPanel.innerHTML = `<div class="panel-title">${project ? escapeHtml(project.name) : 'Projetos'}</div><button class="new-item" data-action="new-project"><span class="new-item-icon new-folder-icon" aria-hidden="true"></span><span>Novo projeto</span></button>${project ? `<button class="new-item" data-action="new-project-chat"><span class="new-item-icon new-chat-icon" aria-hidden="true"></span><span>Novo chat neste projeto</span></button><div class="group-label">Chats do projeto</div>${projectChats.map((chat) => chatItem(chat)).join('') || '<div class="empty-panel">Nenhum chat neste projeto.</div>'}` : projects.map((item) => `<div class="project-item" data-project="${item.id}" role="button" tabindex="0"><span class="project-item-main"><span class="project-folder-icon" aria-hidden="true"></span><span class="project-item-copy"><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.rootPath)}</small></span></span></div>`).join('') || '<div class="empty-panel">Nenhum projeto criado.</div>'}`;
    return;
  }
  if (activePanel === 'plugins') {
    navPanel.innerHTML = `<div class="panel-title">Plugins</div><div class="plugin-card"><span class="plugin-card-icon plugin-extension-icon" aria-hidden="true"></span><div><strong>Ecossistema de extensões</strong><span>A barra lateral direita permanece reservada para extensões.</span></div></div><div class="empty-panel">Nenhum plugin instalado.</div>`;
    return;
  }
  navPanel.innerHTML = `<div class="panel-title">Chats</div><button class="new-item" data-action="new-chat"><span class="new-item-icon new-chat-icon" aria-hidden="true"></span><span>Novo chat</span></button><div class="group-label">Recentes</div>${chats.map(chatItem).join('') || '<div class="empty-panel">Nenhum chat salvo.</div>'}`;
}

function chatItem(chat: Chat): string {
  return `<div class="chat-item ${activeChat?.id === chat.id ? 'selected' : ''}" data-chat="${chat.id}" role="button" tabindex="0"><span class="chat-item-copy"><span>${escapeHtml(chat.title)}</span><small>${escapeHtml(providerName(chat.providerId))}</small></span><button class="chat-settings" data-chat-rename="${chat.id}" title="Renomear chat" aria-label="Renomear chat"></button><button class="chat-delete" data-chat-delete="${chat.id}" title="Excluir chat" aria-label="Excluir chat"></button></div>`;
}

function renderHeader(): void {
  if (!activeChat) {
    chatHeader.innerHTML = `<div><div class="eyebrow">NOVO CHAT</div><h1>Comece uma conversa</h1></div><div class="header-actions"></div>`;
    return;
  }
  const unconfigured = activeChat.providerId === 'unconfigured';
  chatHeader.innerHTML = `<div><div class="chat-title-row"><h1>${escapeHtml(activeChat.title)}</h1></div><div class="chat-subtitle">${escapeHtml(providerName(activeChat.providerId))}${unconfigured ? '' : ` · ${escapeHtml(activeChat.model)} · Inteligência ${intelligenceLabel(activeChat.intelligence)}`}</div></div><div class="header-actions"><button class="provider-chip" data-chat-settings="${activeChat.id}">${escapeHtml(providerName(activeChat.providerId))}<span class="provider-chevron" aria-hidden="true"></span></button></div>`;
}

function renderApprovals(): string {
  if (!pendingApprovals.length) return '';
  return pendingApprovals.map((approval) => `<div class="approval-card" data-approval="${approval.id}"><div class="approval-heading">Aprovação necessária</div><div class="approval-tool">${escapeHtml(approval.toolCall.name)}</div><div class="approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</div><div class="approval-actions"><button data-approve="${approval.id}" class="primary-button">Aprovar</button><button data-deny="${approval.id}" class="danger-button">Recusar</button></div></div>`).join('');
}

function renderMessages(): void {
  if (!activeChat) {
    messages.innerHTML = `<div class="welcome"><div class="welcome-mark"><span class="welcome-mark-eye"></span></div><h2>Como você quer trabalhar?</h2><p>Converse com uma IA, crie conteúdo ou abra um projeto para trabalhar em arquivos.</p><div class="welcome-grid"><button data-suggestion="Explique como o Auto CodeZ funciona.">Pergunte qualquer coisa</button><button data-suggestion="Analise meu projeto e explique a estrutura.">Analise um projeto</button><button data-suggestion="Crie uma ideia de interface moderna.">Crie conteúdo</button></div></div>`;
    return;
  }
  const rendered = activeChat.messages.map((message) => `<article class="message ${message.role}"><div class="message-label">${message.role === 'user' ? 'Você' : message.role === 'tool' ? 'Ferramenta' : providerName(activeChat!.providerId)}</div><div class="message-content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div></article>`).join('');
  const live = executionState === 'running' && streamingText ? `<article class="message assistant streaming"><div class="message-label">${escapeHtml(providerName(activeChat.providerId))}</div><div class="message-content">${escapeHtml(streamingText).replace(/\n/g, '<br>')}</div></article>` : '';
  const activityLines = [...streamingActivity];
  if (executionState === 'waiting_approval') activityLines.push('Aguardando sua aprovação.');
  if (lastError) activityLines.push(lastError);
  const activity = activityLines.length || pendingApprovals.length ? `<div class="activity-card"><div class="activity-heading"><span class="activity-pulse"></span>Atividade</div>${activityLines.slice(-8).map((line) => `<div class="activity-line ${executionState === 'failed' ? 'error' : 'running'}">${escapeHtml(line)}</div>`).join('')}${renderApprovals()}</div>` : '';
  messages.innerHTML = rendered + live + activity;
  messages.scrollTop = messages.scrollHeight;
}

function renderComposer(): void {
  const busy = executionState === 'running' || executionState === 'waiting_approval';
  intelligenceButton.querySelector<HTMLElement>('.intelligence-current')!.textContent = intelligenceLabel(composerIntelligence);
  sendButton.disabled = !activeChat || !prompt.value.trim() || busy || pendingApprovals.length > 0;
  prompt.disabled = busy;
  renderIntelligenceMenu();
}

async function refresh(): Promise<void> {
  try {
    const state = await window.autoCodez.getState();
    providers = state.providers;
    chats = state.chats;
    projects = state.projects;
    if (activeChat) {
      const persistedChat = chats.find((chat) => chat.id === activeChat!.id);
      if (persistedChat) activeChat = persistedChat;
      else if (activeChat.messages.length > 0) activeChat = null;
    }
    if (activeChat) composerIntelligence = activeChat.intelligence;
    renderNav();
    renderHeader();
    renderMessages();
    renderComposer();
  } catch (error) {
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível carregar o estado do aplicativo.');
  }
}

function closeModal(): void {
  modalRoot.innerHTML = '';
}

function openModal(content: string): void {
  setIntelligenceMenu(false);
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal">${content}</div></div>`;
}

async function openGeneralSettings(): Promise<void> {
  openModal(`<div class="modal-head"><div><div class="eyebrow">AUTO CODEZ</div><h2>Configurações gerais</h2><p>Configurações gerais do aplicativo.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><div class="empty-panel">Preferências gerais, aparência, comportamento e integrações globais serão configurados nos módulos correspondentes.</div>`);
}

async function openProviderSettings(providerId = ''): Promise<void> {
  openModal(`<div class="modal-head"><div><div class="eyebrow">CONFIGURAÇÕES DE IA</div><h2>Inteligências artificiais</h2><p>Cadastre provedores, API keys e modelos.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><div class="provider-list">${providers.map((provider) => `<div class="provider-row"><div><strong>${escapeHtml(provider.displayName)}</strong><span>${provider.configured ? 'API key configurada' : 'Não configurada'}</span></div><div class="row-actions"><button data-provider-edit="${provider.id}">${provider.configured ? 'Alterar chave' : 'Configurar'}</button>${provider.configured ? `<button data-provider-remove="${provider.id}" class="danger">Remover</button>` : ''}</div></div>`).join('')}</div><div class="add-provider"><h3>${providerId ? 'Editar provedor' : 'Adicionar IA'}</h3><label>IA<select id="provider-id">${providers.map((provider) => `<option value="${provider.id}" ${provider.id === providerId ? 'selected' : ''}>${escapeHtml(provider.displayName)}</option>`).join('')}</select></label><label>API Key<input id="provider-key" type="password" placeholder="Cole sua API key aqui" autocomplete="off"></label><label>Modelo<input id="provider-model" type="text" placeholder="Modelo opcional"></label><button class="primary-button" id="save-provider">Testar e salvar</button></div>`);
}

async function openChatSettings(chat: Chat): Promise<void> {
  let models: Model[] = [];
  const provider = providers.find((item) => item.id === chat.providerId);
  if (provider?.configured) {
    try { models = await window.autoCodez.listModels(chat.providerId); } catch { models = []; }
  }
  openModal(`<div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Essas configurações pertencem a esta conversa.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><label>Inteligência artificial<select id="chat-provider">${providers.map((item) => `<option value="${item.id}" ${item.id === chat.providerId ? 'selected' : ''} ${item.configured ? '' : 'disabled'}>${escapeHtml(item.displayName)}${item.configured ? '' : ' · não configurada'}</option>`).join('')}</select></label><label>Modelo<select id="chat-model">${models.map((model) => `<option value="${model.id}" ${model.id === chat.model ? 'selected' : ''}>${escapeHtml(model.name)}</option>`).join('') || (chat.model === 'unconfigured' ? '<option value="">Configure uma IA primeiro</option>' : `<option value="${escapeHtml(chat.model)}">${escapeHtml(chat.model)}</option>`)}</select></label><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-chat-settings">Salvar configurações</button></div>`);
}

async function newChat(projectId?: string): Promise<void> {
  if (executionState !== 'idle' && executionState !== 'failed') return;
  try {
    activeChat = await window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'safe', projectId });
    composerIntelligence = 'normal';
    pendingApprovals = [];
    streamingActivity = [];
    lastError = '';
    retryContent = '';
    lastSubmittedContent = '';
    executionState = 'idle';
    activePanel = projectId ? 'projects' : 'chats';
    activeProjectId = projectId;
    await refresh();
  } catch (error) {
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível criar o chat.');
  }
}

async function newProject(): Promise<void> {
  try {
    const rootPath = await window.autoCodez.openFolder();
    if (!rootPath) return;
    const name = rootPath.split(/[\\/]/).pop() || 'Novo projeto';
    await window.autoCodez.createProject({ name, rootPath });
    activePanel = 'projects';
    activeProjectId = undefined;
    await refresh();
  } catch (error) {
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível criar o projeto.');
  }
}

async function refreshApprovals(): Promise<void> {
  try {
    pendingApprovals = await window.autoCodez.listApprovals();
    if (pendingApprovals.length) executionState = 'waiting_approval';
    renderMessages();
    renderComposer();
  } catch (error) {
    pendingApprovals = [];
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível carregar as aprovações.');
  }
}

async function sendMessage(contentOverride?: string, isRetry = false): Promise<void> {
  const content = (contentOverride ?? prompt.value).trim();
  if (!content || !activeChat || (executionState !== 'idle' && executionState !== 'failed') || pendingApprovals.length) return;
  if (isRetry && !retryContent) return;
  if (executionState === 'failed') {
    executionState = 'idle';
    lastError = '';
  }
  const chatId = activeChat.id;
  prompt.value = '';
  prompt.style.height = '';
  streamingText = '';
  streamingActivity = [`Enviando para ${providerName(activeChat.providerId)}`];
  lastError = '';
  lastSubmittedContent = content;
  if (!isRetry) {
    retryContent = '';
    activeChat.messages = [...activeChat.messages, { role: 'user', content, createdAt: Date.now() }];
  }
  setExecutionState('running');
  try {
    const result = await window.autoCodez.streamChat({ chatId, content });
    if (!activeChat || activeChat.id !== chatId) return;
    activeChat = result.chat;
    pendingApprovals = result.pendingApprovalIds.length ? await window.autoCodez.listApprovals() : [];
    if (pendingApprovals.length) {
      executionState = 'waiting_approval';
      streamingText = '';
      renderMessages();
      renderComposer();
    } else {
      executionState = 'idle';
      streamingText = '';
      streamingActivity = [];
      retryContent = '';
      lastSubmittedContent = '';
      await refresh();
    }
  } catch (error) {
    retryContent = content;
    setExecutionState('failed', error instanceof Error ? error.message : 'Falha ao enviar mensagem.');
  }
}

async function retryLastMessage(): Promise<void> {
  if (!activeChat || executionState !== 'failed' || pendingApprovals.length || !retryContent) return;
  const content = retryContent;
  await sendMessage(content, true);
}

async function resumeApproval(id: string, approve: boolean): Promise<void> {
  if (executionState !== 'waiting_approval') return;
  const approval = pendingApprovals.find((item) => item.id === id);
  if (!approval) return;
  executionState = 'running';
  pendingApprovals = pendingApprovals.filter((item) => item.id !== id);
  streamingText = '';
  streamingActivity = [approve ? 'Aprovando operação...' : 'Recusando operação...'];
  lastError = '';
  renderMessages();
  renderComposer();
  try {
    const result = approve ? await window.autoCodez.approveTool(id) : await window.autoCodez.denyTool(id);
    if (result.chatId) {
      const chat = chats.find((item) => item.id === result.chatId);
      if (chat && result.messages) chat.messages = result.messages;
      if (activeChat?.id === result.chatId && result.messages) activeChat.messages = result.messages;
    }
    pendingApprovals = await window.autoCodez.listApprovals();
    if (pendingApprovals.length) {
      executionState = 'waiting_approval';
      streamingActivity = ['Outras operações ainda aguardam aprovação.'];
      renderMessages();
      renderComposer();
    } else {
      executionState = 'idle';
      streamingText = '';
      streamingActivity = [];
      retryContent = '';
      lastSubmittedContent = '';
      await refresh();
    }
  } catch (error) {
    pendingApprovals = await window.autoCodez.listApprovals().catch((): Approval[] => []);
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível processar a aprovação.');
  }
}

async function setComposerIntelligence(level: IntelligenceLevel): Promise<void> {
  if (!activeChat || (executionState !== 'idle' && executionState !== 'failed')) return;
  const previous = composerIntelligence;
  const previousState = executionState;
  composerIntelligence = level;
  setIntelligenceMenu(false);
  if (activeChat.intelligence === level) { renderComposer(); return; }
  try {
    activeChat = await window.autoCodez.updateChatSettings({ chatId: activeChat.id, providerId: activeChat.providerId, model: activeChat.model, intelligence: level, permissionLevel: activeChat.permissionLevel });
    executionState = 'idle';
    lastError = '';
    retryContent = '';
    lastSubmittedContent = '';
    await refresh();
  } catch (error) {
    composerIntelligence = previous;
    setExecutionState(previousState === 'failed' ? 'failed' : 'failed', error instanceof Error ? error.message : 'Não foi possível atualizar o perfil de raciocínio.');
  }
}

async function deleteChat(chatId: string): Promise<void> {
  if (executionState === 'running' || executionState === 'waiting_approval') return;
  if (!window.confirm('Excluir esta conversa permanentemente?')) return;
  try {
    await window.autoCodez.deleteChat(chatId);
    if (activeChat?.id === chatId) {
      activeChat = null;
      pendingApprovals = [];
      streamingText = '';
      streamingActivity = [];
      lastError = '';
      retryContent = '';
      lastSubmittedContent = '';
      executionState = 'idle';
    }
    await refresh();
  } catch (error) {
    setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível excluir o chat.');
  }
}

intelligenceButton.addEventListener('click', () => setIntelligenceMenu(!intelligenceMenuOpen));
intelligenceMenu.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const info = target.closest<HTMLElement>('[data-intelligence-info]');
  if (info) {
    event.stopPropagation();
    const level = info.dataset.intelligenceInfo as IntelligenceLevel;
    openModal(`<div class="modal-head"><div><div class="eyebrow">RACIOCÍNIO</div><h2>${intelligenceLabel(level)}</h2><p>${escapeHtml(intelligenceDescription(level))}</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><div class="intelligence-info-card"><span class="info-card-icon" aria-hidden="true"></span><span>O Auto CodeZ traduz este perfil para o nível de esforço compatível com o modelo escolhido.</span></div>`);
    return;
  }
  const option = target.closest<HTMLElement>('[data-intelligence-option]');
  if (option) await setComposerIntelligence(option.dataset.intelligenceOption as IntelligenceLevel);
});

prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
  renderComposer();
});
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
sendButton.addEventListener('click', () => void sendMessage());
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('.intelligence-control')) setIntelligenceMenu(false);
  const approve = target.closest<HTMLElement>('[data-approve]');
  if (approve?.dataset.approve) void resumeApproval(approve.dataset.approve, true);
  const deny = target.closest<HTMLElement>('[data-deny]');
  if (deny?.dataset.deny) void resumeApproval(deny.dataset.deny, false);
});

window.addEventListener('auto-codez-retry-message', () => {
  void retryLastMessage();
});

app.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const panel = target.closest<HTMLElement>('[data-panel]');
  if (panel) {
    activePanel = panel.dataset.panel || 'chats';
    activeProjectId = undefined;
    renderNav();
    return;
  }
  const deleteButton = target.closest<HTMLElement>('[data-chat-delete]');
  if (deleteButton?.dataset.chatDelete) {
    event.stopPropagation();
    await deleteChat(deleteButton.dataset.chatDelete);
    return;
  }
  const settings = target.closest<HTMLElement>('[data-chat-settings]');
  if (settings) {
    if (executionState === 'running' || executionState === 'waiting_approval') return;
    const chat = chats.find((item) => item.id === settings.dataset.chatSettings) || (activeChat?.id === settings.dataset.chatSettings ? activeChat : undefined);
    if (chat) await openChatSettings(chat);
    return;
  }
  const chatButton = target.closest<HTMLElement>('[data-chat]');
  if (chatButton) {
    if (executionState === 'running' || executionState === 'waiting_approval') return;
    activeChat = chats.find((chat) => chat.id === chatButton.dataset.chat) || null;
    pendingApprovals = [];
    streamingText = '';
    streamingActivity = [];
    lastError = '';
    retryContent = '';
    lastSubmittedContent = '';
    composerIntelligence = activeChat?.intelligence || 'normal';
    renderNav();
    renderHeader();
    renderMessages();
    renderComposer();
    return;
  }
  const projectButton = target.closest<HTMLElement>('[data-project]');
  if (projectButton) {
    activePanel = 'projects';
    activeProjectId = projectButton.dataset.project;
    renderNav();
    renderHeader();
    renderMessages();
    renderComposer();
    return;
  }
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'new-chat') { closeModal(); await newChat(); return; }
  if (action === 'new-project-chat') { if (activeProjectId) await newChat(activeProjectId); return; }
  if (action === 'new-project') { await newProject(); return; }
  if (action === 'settings') { await openGeneralSettings(); return; }
  if (action === 'ai-settings') { await openProviderSettings(); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'profile') { openModal(`<div class="modal-head"><div><div class="eyebrow">PERFIL</div><h2>Seu perfil</h2><p>O sistema de conta e sincronização será conectado em uma etapa própria.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><div class="profile-preview"><div class="avatar">CZ</div><div><strong>Usuário local</strong><span>Configuração local do Auto CodeZ</span></div></div>`); return; }
  if (action === 'attachments') { openModal(`<div class="modal-head"><div><div class="eyebrow">ANEXOS</div><h2>Anexar conteúdo</h2><p>Arquivos e multimídia serão conectados ao sistema de capacidades.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><div class="attachment-options"><button>Arquivo</button><button>Imagem</button><button>Áudio</button><button>Vídeo</button></div>`); return; }
});

modalRoot.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const edit = target.closest<HTMLElement>('[data-provider-edit]');
  if (edit) { await openProviderSettings(edit.dataset.providerEdit || ''); return; }
  const remove = target.closest<HTMLElement>('[data-provider-remove]');
  if (remove) {
    try { await window.autoCodez.removeProvider(remove.dataset.providerRemove || ''); await refresh(); await openProviderSettings(); } catch (error) { setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível remover o provider.'); }
    return;
  }
  if (target.id === 'save-provider') {
    const providerId = document.querySelector<HTMLSelectElement>('#provider-id')?.value || '';
    const apiKey = document.querySelector<HTMLInputElement>('#provider-key')?.value || '';
    const model = document.querySelector<HTMLInputElement>('#provider-model')?.value.trim() || undefined;
    const button = target as HTMLButtonElement;
    if (!apiKey.trim()) return;
    button.disabled = true;
    button.textContent = 'Validando...';
    try { await window.autoCodez.saveProvider({ providerId, apiKey, model }); await refresh(); await openProviderSettings(providerId); } catch (error) { button.disabled = false; button.textContent = 'Testar e salvar'; setExecutionState('failed', error instanceof Error ? error.message : 'Falha ao validar a API key.'); }
    return;
  }
  if (target.id === 'chat-provider') {
    const providerId = (target as HTMLSelectElement).value;
    const select = document.querySelector<HTMLSelectElement>('#chat-model');
    try { const nextModels = await window.autoCodez.listModels(providerId); if (select) select.innerHTML = nextModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join(''); } catch (error) { if (select) select.innerHTML = `<option value="">${escapeHtml(error instanceof Error ? error.message : 'Não foi possível carregar os modelos')}</option>`; }
    return;
  }
  if (target.id === 'save-chat-settings') {
    if (!activeChat) return;
    const providerId = document.querySelector<HTMLSelectElement>('#chat-provider')?.value || activeChat.providerId;
    const model = document.querySelector<HTMLSelectElement>('#chat-model')?.value || activeChat.model;
    const permissionLevel = document.querySelector<HTMLSelectElement>('#chat-permission')?.value || activeChat.permissionLevel;
    if (providerId === 'unconfigured' || !model) {
      closeModal();
      await openProviderSettings();
      return;
    }
    try { activeChat = await window.autoCodez.updateChatSettings({ chatId: activeChat.id, providerId, model, intelligence: activeChat.intelligence, permissionLevel }); composerIntelligence = activeChat.intelligence; closeModal(); executionState = 'idle'; lastError = ''; retryContent = ''; lastSubmittedContent = ''; await refresh(); } catch (error) { setExecutionState('failed', error instanceof Error ? error.message : 'Não foi possível salvar as configurações do chat.'); }
  }
});

window.autoCodez.onStreamEvent((event) => {
  if (event.type === 'start') {
    executionState = 'running';
    lastError = '';
    renderComposer();
    return;
  }
  if (event.type === 'delta' && event.text) {
    streamingText += event.text;
    renderMessages();
    return;
  }
  if (event.type === 'tool_call' && event.toolCall) {
    streamingActivity.push(`Solicitou ferramenta: ${event.toolCall.name}`);
    renderMessages();
    return;
  }
  if (event.type === 'activity' && event.activity?.message) {
    streamingActivity.push(event.activity.message);
    renderMessages();
    return;
  }
  if (event.type === 'approval_required') {
    executionState = 'waiting_approval';
    void refreshApprovals();
    return;
  }
  if (event.type === 'complete') {
    streamingText = '';
    renderMessages();
    return;
  }
  if (event.type === 'error' && event.error) {
    retryContent = lastSubmittedContent;
    setExecutionState('failed', event.error);
  }
});

window.autoCodez.onActivity((event) => {
  if (event.message) {
    streamingActivity.push(event.message);
    if (executionState === 'running') renderMessages();
  }
});

window.addEventListener('error', (event) => {
  if (executionState === 'running' || executionState === 'waiting_approval') {
    retryContent = lastSubmittedContent;
    setExecutionState('failed', event.error instanceof Error ? event.error.message : event.message || 'Erro inesperado no renderer.');
  }
});
window.addEventListener('unhandledrejection', (event) => {
  retryContent = lastSubmittedContent;
  setExecutionState('failed', event.reason instanceof Error ? event.reason.message : String(event.reason || 'Operação rejeitada.'));
});

void refresh();
