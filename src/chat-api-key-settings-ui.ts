type SavedApiKey = { id: string; name: string; providerId: string; providerName: string; maskedKey: string; selectedModel?: string; active: boolean };
type Chat = { id: string; providerId: string; model: string; apiKeyId?: string; permissionLevel: string; intelligence: string };
type Model = { id: string; name: string };
type ChatApi = {
  getState: () => Promise<{ providers: unknown[]; chats: Chat[]; projects: unknown[] }>;
  listApiKeys: () => Promise<SavedApiKey[]>;
  listModels: (providerId: string) => Promise<Model[]>;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function modalRoot(): HTMLElement | null { return document.querySelector('#modal-root'); }
function api(): ChatApi { return window.autoCodez as unknown as ChatApi; }

function openSavedKeyChatSettings(chat: Chat, keys: SavedApiKey[]): void {
  const root = modalRoot();
  if (!root) return;
  const referencedKey = chat.apiKeyId ? keys.find((key) => key.id === chat.apiKeyId) : undefined;
  const currentKey = referencedKey || (!chat.apiKeyId ? keys.find((key) => key.providerId === chat.providerId && key.active) : undefined);
  const missingKey = Boolean(chat.apiKeyId && !referencedKey);
  const missingOption = missingKey ? `<option value="" selected disabled>Credencial salva não encontrada</option>` : '';
  const options = keys.length
    ? `${missingOption}${keys.map((key) => `<option value="${escapeHtml(key.id)}" ${key.id === currentKey?.id ? 'selected' : ''}>${escapeHtml(key.name)} · ${escapeHtml(key.providerName)}</option>`).join('')}`
    : `<option value="${escapeHtml(chat.providerId)}">${escapeHtml(chat.providerId)}</option>`;
  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Escolha exatamente qual credencial salva esta conversa deve usar.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><label>Chaves API salvas<select id="chat-provider">${options}</select></label>${missingKey ? '<p class="modal-error">A credencial usada por este chat foi removida. Selecione uma nova chave antes de salvar.</p>' : ''}<label>Modelo<select id="chat-model"><option value="">${missingKey ? 'Selecione uma nova chave' : 'Carregando modelos...'}</option></select></label><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-chat-settings" ${keys.length && !missingKey ? '' : 'disabled'}>Salvar configurações</button></div></div>`;
  if (currentKey) void loadModels(currentKey.id, chat.model);
}

async function loadModels(identifier: string, selectedModel: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;
  try {
    const models = await api().listModels(identifier);
    select.innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.name)}</option>`).join('') || `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || 'Modelo não disponível')}</option>`;
  } catch (error) {
    select.innerHTML = `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || (error instanceof Error ? error.message : 'Não foi possível carregar os modelos'))}</option>`;
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const settings = target.closest<HTMLElement>('[data-chat-settings]');
  if (!settings) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const state = await api().getState();
    const chat = state.chats.find((item) => item.id === settings.dataset.chatSettings);
    if (!chat) return;
    const keys = await api().listApiKeys();
    openSavedKeyChatSettings(chat, keys);
  } catch (error) {
    const root = modalRoot();
    if (root) root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Não foi possível carregar as configurações</h2><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div></div></div>`;
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.id !== 'chat-provider') return;
  const chatModel = document.querySelector<HTMLSelectElement>('#chat-model');
  const saveButton = document.querySelector<HTMLButtonElement>('#save-chat-settings');
  if (!chatModel) return;
  if (saveButton) saveButton.disabled = false;
  void loadModels(target.value, '');
}, true);
