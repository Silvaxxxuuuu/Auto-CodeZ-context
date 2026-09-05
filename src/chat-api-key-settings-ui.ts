type SavedApiKey = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  maskedKey: string;
  selectedModel?: string;
  active: boolean;
};

type Chat = {
  id: string;
  providerId: string;
  model: string;
  apiKeyId?: string;
  permissionLevel: string;
  intelligence: string;
};

type Model = { id: string; name: string };

type ChatApi = {
  getState: () => Promise<{ providers: unknown[]; chats: Chat[]; projects: unknown[] }>;
  listApiKeys: () => Promise<SavedApiKey[]>;
  listModelsForApiKey: (keyId: string) => Promise<Model[]>;
  updateChatSettings: (input: {
    chatId: string;
    providerId: string;
    model: string;
    apiKeyId?: string;
    intelligence: string;
    permissionLevel: string;
  }) => Promise<Chat>;
};

let openChat: Chat | null = null;
let savedKeys: SavedApiKey[] = [];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function modalRoot(): HTMLElement | null {
  return document.querySelector('#modal-root');
}

function api(): ChatApi {
  return window.autoCodez as unknown as ChatApi;
}

function currentKeyFor(chat: Chat, keys: SavedApiKey[]): SavedApiKey | undefined {
  if (chat.apiKeyId) return keys.find((key) => key.id === chat.apiKeyId);
  return keys.find((key) => key.providerId === chat.providerId && key.active);
}

function savedAiLabel(key: SavedApiKey): string {
  return `${key.name} · ${key.providerName} · ${key.maskedKey}`;
}

function openSavedAiSettings(chat: Chat, keys: SavedApiKey[]): void {
  const root = modalRoot();
  if (!root) return;

  openChat = chat;
  savedKeys = keys;

  const currentKey = currentKeyFor(chat, keys);
  const options = keys.length
    ? keys.map((key) => `<option value="${escapeHtml(key.id)}" ${key.id === currentKey?.id ? 'selected' : ''}>${escapeHtml(savedAiLabel(key))}</option>`).join('')
    : '<option value="">Nenhuma IA salva</option>';

  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Escolha a IA salva específica que esta conversa deve usar. Cada IA salva corresponde a uma API key cadastrada.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><label>IAs salvas<select id="chat-saved-ai">${options}</select></label><label>Modelo<select id="chat-model"><option value="">${currentKey ? 'Carregando modelos...' : 'Selecione uma IA salva'}</option></select></label><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-saved-ai-settings" ${currentKey ? '' : 'disabled'}>Salvar configurações</button></div></div>`;

  if (currentKey) void loadModels(currentKey.id, chat.model || currentKey.selectedModel || '');
}

async function loadModels(keyId: string, selectedModel: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;

  select.disabled = true;
  try {
    const models = await api().listModelsForApiKey(keyId);
    select.innerHTML = models.length
      ? models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.name)}</option>`).join('')
      : `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || 'Nenhum modelo disponível')}</option>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível carregar os modelos';
    select.innerHTML = `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || message)}</option>`;
  } finally {
    select.disabled = false;
  }
}

async function saveSettings(): Promise<void> {
  const chat = openChat;
  if (!chat) return;

  const aiSelect = document.querySelector<HTMLSelectElement>('#chat-saved-ai');
  const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');
  const permissionSelect = document.querySelector<HTMLSelectElement>('#chat-permission');
  const saveButton = document.querySelector<HTMLButtonElement>('#save-saved-ai-settings');
  if (!aiSelect || !modelSelect || !permissionSelect || !saveButton) return;

  const key = savedKeys.find((item) => item.id === aiSelect.value);
  if (!key || !modelSelect.value) return;

  saveButton.disabled = true;
  saveButton.textContent = 'Salvando...';

  try {
    const updated = await api().updateChatSettings({
      chatId: chat.id,
      providerId: key.providerId,
      model: modelSelect.value,
      apiKeyId: key.id,
      intelligence: chat.intelligence,
      permissionLevel: permissionSelect.value,
    });
    openChat = updated;
    modalRoot()?.replaceChildren();
    window.dispatchEvent(new CustomEvent('auto-codez-chat-settings-updated', { detail: updated }));
  } catch (error) {
    saveButton.disabled = false;
    saveButton.textContent = 'Salvar configurações';
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', {
      detail: error instanceof Error ? error.message : 'Não foi possível salvar as configurações do chat.',
    }));
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const settings = target.closest<HTMLElement>('[data-chat-settings]');
  if (settings) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const state = await api().getState();
      const chat = state.chats.find((item) => item.id === settings.dataset.chatSettings);
      if (!chat) return;
      const keys = await api().listApiKeys();
      openSavedAiSettings(chat, keys);
    } catch (error) {
      const root = modalRoot();
      if (root) root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Não foi possível carregar as configurações</h2><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div></div></div>`;
    }
    return;
  }

  if (target.closest('#save-saved-ai-settings')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    await saveSettings();
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target || target.id !== 'chat-saved-ai') return;

  event.stopImmediatePropagation();
  const key = savedKeys.find((item) => item.id === target.value);
  const saveButton = document.querySelector<HTMLButtonElement>('#save-saved-ai-settings');
  const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');

  if (saveButton) saveButton.disabled = !key;
  if (!modelSelect) return;

  if (!key) {
    modelSelect.innerHTML = '<option value="">Selecione uma IA salva</option>';
    return;
  }

  modelSelect.innerHTML = '<option value="">Carregando modelos...</option>';
  void loadModels(key.id, key.selectedModel || '');
}, true);
