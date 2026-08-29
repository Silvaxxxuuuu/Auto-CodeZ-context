import './index.css';

type ProviderSummary = { id: string; displayName: string; configured: boolean; selectedModel?: string; apiKeyConfigured: boolean };
type Model = { id: string; name: string; providerId: string; capabilities: string[]; reasoningLevels?: string[] };
type Message = { role: 'user' | 'assistant' | 'system'; content: string; createdAt?: number };
type Chat = { id: string; title: string; projectId?: string; providerId: string; model: string; intelligence: 'low' | 'normal' | 'high' | 'maximum'; permissionLevel: 'read-only' | 'safe' | 'ask' | 'unrestricted'; messages: Message[]; createdAt: number; updatedAt: number };
type Project = { id: string; name: string; rootPath: string; createdAt: number; updatedAt: number };

declare global {
  interface Window {
    autoCodez: {
      getState: () => Promise<{ providers: ProviderSummary[]; chats: Chat[]; projects: Project[] }>;
      listModels: (providerId: string) => Promise<Model[]>;
      saveProvider: (input: { providerId: string; apiKey: string; model?: string; baseUrl?: string }) => Promise<{ providers: ProviderSummary[]; models: Model[] }>;
      removeProvider: (providerId: string) => Promise<ProviderSummary[]>;
      createChat: (input: { providerId: string; model: string; intelligence: string; permissionLevel: string; projectId?: string }) => Promise<Chat>;
      updateChatSettings: (input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }) => Promise<Chat>;
      sendChat: (input: { chatId: string; content: string }) => Promise<{ response: { content: string; model: string; providerId: string }; chat: Chat }>;
      createProject: (input: { name: string; rootPath: string }) => Promise<Project>;
      openFolder: () => Promise<string | null>;
      scanProject: (rootPath: string) => Promise<Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>>;
      readFile: (filePath: string) => Promise<string>;
      writeFile: (input: { filePath: string; content: string }) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}

const intelligence = [
  ['low', 'Baixo', 'Rápido e econômico'],
  ['normal', 'Normal', 'Equilíbrio padrão'],
  ['high', 'Alto', 'Mais raciocínio'],
  ['maximum', 'Máximo', 'Maior esforço disponível'],
] as const;

let providers: ProviderSummary[] = [];
let models: Model[] = [];
let chats: Chat[] = [];
let projects: Project[] = [];
let activeChat: Chat | null = null;
let activePanel = 'chats';
let modal = '';
let selectedProviderId = '';
let selectedModel = '';
let composerIntelligence: Chat['intelligence'] = 'normal';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Elemento #app não encontrado.');

app.innerHTML = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><span class="brand-mark">CZ</span><span>Auto CodeZ</span></div>
    <div class="topbar-actions">
      <button class="top-action" data-action="new-chat">Novo chat</button>
      <button class="top-action" data-action="settings">Configurações</button>
      <button class="top-action icon-only" data-action="profile" title="Perfil">◉</button>
    </div>
  </header>
  <div class="body">
    <aside class="rail">
      <button class="rail-button active" data-panel="chats" title="Chats">▢</button>
      <button class="rail-button" data-panel="projects" title="Projetos">⌘</button>
      <button class="rail-button" data-panel="plugins" title="Plugins">◇</button>
      <div class="rail-spacer"></div>
      <button class="rail-button" data-action="profile" title="Perfil">◉</button>
    </aside>
    <aside class="nav-panel" id="nav-panel"></aside>
    <main class="chat-area">
      <section class="chat-header" id="chat-header"></section>
      <section class="messages" id="messages"></section>
      <section class="composer-wrap">
        <div class="composer">
          <button class="attach-button" data-action="attachments" title="Anexar arquivos">＋</button>
          <textarea id="prompt" rows="1" placeholder="Digite uma mensagem..."></textarea>
          <div class="composer-divider"></div>
          <button class="intelligence-button" id="intelligence-button">Normal <span>⌄</span></button>
          <button class="send-button" id="send-button" title="Enviar">↑</button>
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
const modalRoot = document.querySelector<HTMLDivElement>('#modal-root')!;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function providerName(id: string): string {
  return providers.find((provider) => provider.id === id)?.displayName || id;
}

function intelligenceLabel(level: string): string {
  return intelligence.find((item) => item[0] === level)?.[1] || 'Normal';
}

function renderNav(): void {
  if (activePanel === 'projects') {
    navPanel.innerHTML = `<div class="panel-title">Projetos</div><button class="new-item" data-action="new-project">＋ Novo projeto</button>${projects.map((project) => `<button class="project-item" data-project="${project.id}"><span>${escapeHtml(project.name)}</span><small>${escapeHtml(project.rootPath)}</small></button>`).join('') || '<div class="empty-panel">Nenhum projeto criado.</div>'}`;
    return;
  }
  if (activePanel === 'plugins') {
    navPanel.innerHTML = `<div class="panel-title">Plugins</div><div class="plugin-card"><strong>Ecossistema de extensões</strong><span>A barra lateral direita permanece reservada para extensões.</span></div><div class="empty-panel">Nenhum plugin instalado.</div>`;
    return;
  }
  navPanel.innerHTML = `<div class="panel-title">Chats</div><button class="new-item" data-action="new-chat">＋ Novo chat</button><div class="group-label">Recentes</div>${chats.map((chat) => `<button class="chat-item ${activeChat?.id === chat.id ? 'selected' : ''}" data-chat="${chat.id}"><span>${escapeHtml(chat.title)}</span><span class="chat-item-meta"><small>${escapeHtml(providerName(chat.providerId))}</small><button class="chat-settings" data-chat-settings="${chat.id}" title="Configurações do chat">⚙</button></span></button>`).join('') || '<div class="empty-panel">Nenhum chat salvo. Chats vazios não são persistidos.</div>'}`;
}

function renderHeader(): void {
  if (!activeChat) {
    chatHeader.innerHTML = `<div><div class="eyebrow">NOVO CHAT</div><h1>Comece uma conversa</h1></div><div class="header-actions"><button class="header-button" data-action="settings">Configurar IA</button></div>`;
    return;
  }
  chatHeader.innerHTML = `<div><div class="chat-title-row"><h1>${escapeHtml(activeChat.title)}</h1><button class="gear" data-chat-settings="${activeChat.id}" title="Configurações do chat">⚙</button></div><div class="chat-subtitle">${escapeHtml(providerName(activeChat.providerId))} · ${escapeHtml(activeChat.model)} · Inteligência ${intelligenceLabel(activeChat.intelligence)}</div></div><div class="header-actions"><button class="provider-chip" data-chat-settings="${activeChat.id}">${escapeHtml(providerName(activeChat.providerId))} <span>⌄</span></button></div>`;
}

function renderMessages(extraActivity = ''): void {
  if (!activeChat) {
    messages.innerHTML = `<div class="welcome"><div class="welcome-mark">CZ</div><h2>Como você quer trabalhar?</h2><p>Converse com uma IA, crie conteúdo ou abra um projeto para trabalhar em arquivos.</p><div class="welcome-grid"><button data-suggestion="Explique como o Auto CodeZ funciona.">Pergunte qualquer coisa</button><button data-suggestion="Analise meu projeto e explique a estrutura.">Analise um projeto</button><button data-suggestion="Crie uma ideia de interface moderna.">Crie conteúdo</button></div></div>`;
    return;
  }
  const rendered = activeChat.messages.map((message) => `<article class="message ${message.role}"><div class="message-label">${message.role === 'user' ? 'Você' : providerName(activeChat!.providerId)}</div><div class="message-content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div></article>`).join('');
  const activity = extraActivity ? `<div class="activity-card"><div class="activity-heading"><span class="activity-pulse"></span> Atividade</div>${extraActivity}</div>` : '';
  messages.innerHTML = rendered + activity;
  messages.scrollTop = messages.scrollHeight;
}

function renderComposer(): void {
  intelligenceButton.innerHTML = `${intelligenceLabel(composerIntelligence)} <span>⌄</span>`;
  sendButton.disabled = !activeChat || !prompt.value.trim();
}

async function refresh(): Promise<void> {
  const state = await window.autoCodez.getState();
  providers = state.providers;
  chats = state.chats;
  projects = state.projects;
  if (activeChat) activeChat = chats.find((chat) => chat.id === activeChat!.id) || activeChat;
  renderNav();
  renderHeader();
  renderMessages();
  renderComposer();
}

function openModal(content: string): void {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal">${content}</div></div>`;
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
}

function closeModal(): void {
  modalRoot.innerHTML = '';
  modal = '';
}

async function openProviderSettings(providerId = ''): Promise<void> {
  modal = 'providers';
  const configured = providers.filter((provider) => provider.configured);
  openModal(`<div class="modal-head"><div><div class="eyebrow">CONFIGURAÇÕES</div><h2>Inteligências artificiais</h2><p>Cadastre provedores. Cada chat usa uma IA por vez.</p></div><button class="modal-close" data-action="close-modal">×</button></div><div class="provider-list">${configured.map((provider) => `<div class="provider-row"><div><strong>${escapeHtml(provider.displayName)}</strong><span>API key configurada</span></div><div class="row-actions"><button data-provider-edit="${provider.id}">Configurar</button><button data-provider-remove="${provider.id}" class="danger">Remover</button></div></div>`).join('') || '<div class="empty-panel">Nenhuma IA configurada.</div>'}</div><div class="add-provider"><h3>${providerId ? 'Editar provedor' : 'Adicionar IA'}</h3><label>IA<select id="provider-id">${providers.map((provider) => `<option value="${provider.id}" ${provider.id === providerId ? 'selected' : ''}>${escapeHtml(provider.displayName)}</option>`).join('')}</select></label><label>API Key<input id="provider-key" type="password" placeholder="Cole sua API key aqui"></label><label>Modelo<select id="provider-model"><option value="">Carregue os modelos depois de testar</option></select></label><button class="primary-button" id="save-provider">Testar e salvar</button></div>`);
}

async function openChatSettings(chat: Chat): Promise<void> {
  const provider = providers.find((item) => item.id === chat.providerId);
  let availableModels: Model[] = [];
  if (provider?.configured) {
    try { availableModels = await window.autoCodez.listModels(chat.providerId); } catch { availableModels = []; }
  }
  openModal(`<div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Essas configurações pertencem a esta conversa.</p></div><button class="modal-close" data-action="close-modal">×</button></div><label>Inteligência artificial<select id="chat-provider">${providers.map((item) => `<option value="${item.id}" ${item.id === chat.providerId ? 'selected' : ''} ${item.configured ? '' : 'disabled'}>${escapeHtml(item.displayName)}${item.configured ? '' : ' · não configurada'}</option>`).join('')}</select></label><label>Modelo<select id="chat-model">${availableModels.map((model) => `<option value="${model.id}" ${model.id === chat.model ? 'selected' : ''}>${escapeHtml(model.name)}</option>`).join('') || `<option value="${escapeHtml(chat.model)}">${escapeHtml(chat.model)}</option>`}</select></label><label>Perfil de raciocínio<select id="chat-intelligence">${intelligence.map((item) => `<option value="${item[0]}" ${item[0] === chat.intelligence ? 'selected' : ''}>${item[1]} · ${item[2]}</option>`).join('')}</select></label><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-chat-settings">Salvar configurações</button>`);
}

async function newChat(): Promise<void> {
  const provider = providers.find((item) => item.configured);
  if (!provider) { await openProviderSettings(); return; }
  let available: Model[] = [];
  try { available = await window.autoCodez.listModels(provider.id); } catch { available = []; }
  const model = provider.selectedModel || available[0]?.id;
  if (!model) { await openProviderSettings(provider.id); return; }
  activeChat = await window.autoCodez.createChat({ providerId: provider.id, model, intelligence: 'normal', permissionLevel: 'safe' });
  await refresh();
}

async function newProject(): Promise<void> {
  const rootPath = await window.autoCodez.openFolder();
  if (!rootPath) return;
  const name = rootPath.split(/[\\/]/).pop() || 'Novo projeto';
  await window.autoCodez.createProject({ name, rootPath });
  activePanel = 'projects';
  await refresh();
}

async function sendMessage(): Promise<void> {
  const content = prompt.value.trim();
  if (!content || !activeChat) return;
  prompt.value = '';
  renderComposer();
  activeChat.messages.push({ role: 'user', content, createdAt: Date.now() });
  renderMessages(`<div class="activity-line done">✓ Preparando a solicitação</div><div class="activity-line running">● Enviando para ${escapeHtml(providerName(activeChat.providerId))}</div>`);
  try {
    const result = await window.autoCodez.sendChat({ chatId: activeChat.id, content });
    activeChat = result.chat;
    renderMessages(`<div class="activity-line done">✓ Solicitação concluída</div><div class="activity-line done">✓ Resposta recebida de ${escapeHtml(providerName(result.response.providerId))}</div>`);
    setTimeout(() => renderMessages(), 500);
    await refresh();
  } catch (error) {
    renderMessages(`<div class="activity-line error">× ${escapeHtml(error instanceof Error ? error.message : 'Falha ao enviar mensagem.')}</div>`);
  }
}

intelligenceButton.addEventListener('click', () => {
  const next = intelligence[(intelligence.findIndex((item) => item[0] === composerIntelligence) + 1) % intelligence.length][0];
  composerIntelligence = next;
  if (activeChat) activeChat.intelligence = next;
  renderComposer();
});

prompt.addEventListener('input', () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`; renderComposer(); });
prompt.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } });
sendButton.addEventListener('click', () => void sendMessage());

app.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const panelButton = target.closest<HTMLElement>('[data-panel]');
  if (panelButton) {
    activePanel = panelButton.dataset.panel || 'chats';
    document.querySelectorAll('.rail-button').forEach((button) => button.classList.toggle('active', button === panelButton));
    renderNav();
    return;
  }
  const chatButton = target.closest<HTMLElement>('[data-chat]');
  if (chatButton && !target.closest('[data-chat-settings]')) {
    activeChat = chats.find((chat) => chat.id === chatButton.dataset.chat) || null;
    composerIntelligence = activeChat?.intelligence || 'normal';
    renderNav(); renderHeader(); renderMessages(); renderComposer();
    return;
  }
  const settingsButton = target.closest<HTMLElement>('[data-chat-settings]');
  if (settingsButton) {
    const chat = chats.find((item) => item.id === settingsButton.dataset.chatSettings);
    if (chat) await openChatSettings(chat);
    return;
  }
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'new-chat') { closeModal(); await newChat(); return; }
  if (action === 'new-project') { await newProject(); return; }
  if (action === 'settings') { await openProviderSettings(); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'profile') { openModal(`<div class="modal-head"><div><div class="eyebrow">PERFIL</div><h2>Seu perfil</h2><p>O sistema de conta e sincronização será conectado em uma etapa própria.</p></div><button class="modal-close" data-action="close-modal">×</button></div><div class="profile-preview"><div class="avatar">CZ</div><div><strong>Usuário local</strong><span>Configuração local do Auto CodeZ</span></div></div>`); return; }
  if (action === 'attachments') { openModal(`<div class="modal-head"><div><div class="eyebrow">ANEXOS</div><h2>Anexar conteúdo</h2><p>O suporte a arquivos e multimídia será conectado ao runtime de capacidades.</p></div><button class="modal-close" data-action="close-modal">×</button></div><div class="attachment-options"><button>Arquivo</button><button>Imagem</button><button>Áudio</button><button>Vídeo</button></div>`); return; }
  const projectButton = target.closest<HTMLElement>('[data-project]');
  if (projectButton) {
    const project = projects.find((item) => item.id === projectButton.dataset.project);
    if (project) {
      const projectChats = chats.filter((chat) => chat.projectId === project.id);
      navPanel.innerHTML = `<div class="panel-title">${escapeHtml(project.name)}</div><div class="group-label">Chats do projeto</div>${projectChats.map((chat) => `<button class="chat-item" data-chat="${chat.id}"><span>${escapeHtml(chat.title)}</span><small>${escapeHtml(providerName(chat.providerId))}</small></button>`).join('') || '<div class="empty-panel">Nenhum chat neste projeto.</div>'}`;
    }
    return;
  }
});

modalRoot.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const edit = target.closest<HTMLElement>('[data-provider-edit]');
  if (edit) { await openProviderSettings(edit.dataset.providerEdit || ''); return; }
  const remove = target.closest<HTMLElement>('[data-provider-remove]');
  if (remove) { await window.autoCodez.removeProvider(remove.dataset.providerRemove || ''); await refresh(); await openProviderSettings(); return; }
  if (target.id === 'save-provider') {
    const providerId = (document.querySelector<HTMLSelectElement>('#provider-id')!).value;
    const apiKey = (document.querySelector<HTMLInputElement>('#provider-key')!).value;
    const model = (document.querySelector<HTMLSelectElement>('#provider-model')!).value || undefined;
    if (!apiKey.trim()) return;
    const button = target as HTMLButtonElement; button.disabled = true; button.textContent = 'Validando...';
    try { const result = await window.autoCodez.saveProvider({ providerId, apiKey, model }); providers = result.providers; models = result.models; await refresh(); await openProviderSettings(); }
    catch (error) { button.disabled = false; button.textContent = 'Testar e salvar'; alert(error instanceof Error ? error.message : 'Falha ao validar a API key.'); }
    return;
  }
  if (target.id === 'chat-provider') {
    const providerId = (target as HTMLSelectElement).value;
    const select = document.querySelector<HTMLSelectElement>('#chat-model');
    try { const nextModels = await window.autoCodez.listModels(providerId); if (select) select.innerHTML = nextModels.map((model) => `<option value="${model.id}">${escapeHtml(model.name)}</option>`).join(''); } catch {}
    return;
  }
  if (target.id === 'save-chat-settings') {
    if (!activeChat) return;
    const providerId = document.querySelector<HTMLSelectElement>('#chat-provider')!.value;
    const model = document.querySelector<HTMLSelectElement>('#chat-model')!.value;
    const intelligenceLevel = document.querySelector<HTMLSelectElement>('#chat-intelligence')!.value;
    const permissionLevel = document.querySelector<HTMLSelectElement>('#chat-permission')!.value;
    activeChat = await window.autoCodez.updateChatSettings({ chatId: activeChat.id, providerId, model, intelligence: intelligenceLevel, permissionLevel });
    composerIntelligence = activeChat.intelligence;
    closeModal(); await refresh();
  }
});

void refresh();
