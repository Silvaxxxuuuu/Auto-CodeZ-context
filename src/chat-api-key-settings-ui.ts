type SavedApiKey = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  maskedKey: string;
  selectedModel?: string;
  active: boolean;
};

type ProviderSummary = {
  id: string;
  displayName: string;
  configured: boolean;
  requiresApiKey?: boolean;
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
  getState: () => Promise<{ providers: ProviderSummary[]; chats: Chat[]; projects: unknown[] }>;
  listApiKeys: () => Promise<SavedApiKey[]>;
  listModels: (providerId: string) => Promise<Model[]>;
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

type AvailableAi = {
  value: string;
  providerId: string;
  label: string;
  selectedModel?: string;
  apiKeyId?: string;
};

const RESTORE_CHAT_KEY = 'auto-codez.restore-chat-after-settings';
let openChat: Chat | null = null;
let availableAis: AvailableAi[] = [];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function modalRoot(): HTMLElement | null {
  return document.querySelector('#modal-root');
}

function api(): ChatApi {
  return window.autoCodez as unknown as ChatApi;
}

function savedAiLabel(key: SavedApiKey): string {
  return `${key.name} · ${key.providerName} · ${key.maskedKey}`;
}

function buildAvailableAis(keys: SavedApiKey[], providers: ProviderSummary[]): AvailableAi[] {
  const keySources = keys.map((key): AvailableAi => ({
    value: `key:${key.id}`,
    providerId: key.providerId,
    label: savedAiLabel(key),
    ...(key.selectedModel ? { selectedModel: key.selectedModel } : {}),
    apiKeyId: key.id,
  }));
  const keylessSources = providers
    .filter((provider) => provider.requiresApiKey === false && provider.configured)
    .map((provider): AvailableAi => ({
      value: `provider:${provider.id}`,
      providerId: provider.id,
      label: `${provider.displayName} · local`,
    }));
  return [...keySources, ...keylessSources];
}

function currentAiFor(chat: Chat, sources: AvailableAi[], keys: SavedApiKey[]): AvailableAi | undefined {
  if (chat.apiKeyId) {
    const exact = sources.find((source) => source.apiKeyId === chat.apiKeyId);
    if (exact) return exact;
  }
  const keyless = sources.find((source) => !source.apiKeyId && source.providerId === chat.providerId);
  if (keyless) return keyless;
  const activeKey = keys.find((key) => key.providerId === chat.providerId && key.active);
  return activeKey ? sources.find((source) => source.apiKeyId === activeKey.id) : undefined;
}

function openAvailableAiSettings(chat: Chat, keys: SavedApiKey[], providers: ProviderSummary[]): void {
  const root = modalRoot();
  if (!root) return;

  openChat = chat;
  availableAis = buildAvailableAis(keys, providers);

  const current = currentAiFor(chat, availableAis, keys);
  const options = availableAis.length
    ? availableAis.map((source) => `<option value="${escapeHtml(source.value)}" ${source.value === current?.value ? 'selected' : ''}>${escapeHtml(source.label)}</option>`).join('')
    : '<option value="">Nenhuma IA disponível</option>';

  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Escolha uma IA cloud salva ou um provider local disponível para esta conversa.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><label>IAs disponíveis<select id="chat-available-ai">${options}</select></label><label>Modelo<select id="chat-model"><option value="">${current ? 'Carregando modelos...' : 'Selecione uma IA'}</option></select></label><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-available-ai-settings" ${current ? '' : 'disabled'}>Salvar configurações</button></div></div>`;

  if (current) void loadModels(current, chat.model || current.selectedModel || '');
}

async function loadModels(source: AvailableAi, selectedModel: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;

  select.disabled = true;
  try {
    const models = source.apiKeyId
      ? await api().listModelsForApiKey(source.apiKeyId)
      : await api().listModels(source.providerId);
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

  const aiSelect = document.querySelector<HTMLSelectElement>('#chat-available-ai');
  const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');
  const permissionSelect = document.querySelector<HTMLSelectElement>('#chat-permission');
  const saveButton = document.querySelector<HTMLButtonElement>('#save-available-ai-settings');
  if (!aiSelect || !modelSelect || !permissionSelect || !saveButton) return;

  const source = availableAis.find((item) => item.value === aiSelect.value);
  if (!source || !modelSelect.value) return;

  saveButton.disabled = true;
  saveButton.textContent = 'Salvando...';

  try {
    const updated = await api().updateChatSettings({
      chatId: chat.id,
      providerId: source.providerId,
      model: modelSelect.value,
      ...(source.apiKeyId ? { apiKeyId: source.apiKeyId } : {}),
      intelligence: chat.intelligence,
      permissionLevel: permissionSelect.value,
    });
    openChat = updated;
    modalRoot()?.replaceChildren();
    window.dispatchEvent(new CustomEvent('auto-codez-chat-settings-updated', { detail: updated }));
    if (!source.apiKeyId) {
      sessionStorage.setItem(RESTORE_CHAT_KEY, updated.id);
      window.location.reload();
    }
  } catch (error) {
    saveButton.disabled = false;
    saveButton.textContent = 'Salvar configurações';
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', {
      detail: error instanceof Error ? error.message : 'Não foi possível salvar as configurações do chat.',
    }));
  }
}

function restoreChatAfterReload(): void {
  const chatId = sessionStorage.getItem(RESTORE_CHAT_KEY);
  if (!chatId) return;
  sessionStorage.removeItem(RESTORE_CHAT_KEY);
  const deadline = Date.now() + 10_000;
  const tryRestore = (): void => {
    const chatButton = document.querySelector<HTMLElement>(`.chat-item[data-chat="${CSS.escape(chatId)}"], [data-chat="${CSS.escape(chatId)}"]`);
    if (chatButton) {
      chatButton.click();
      return;
    }
    if (Date.now() < deadline) window.setTimeout(tryRestore, 80);
  };
  window.setTimeout(tryRestore, 0);
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
      openAvailableAiSettings(chat, keys, state.providers);
    } catch (error) {
      const root = modalRoot();
      if (root) root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Não foi possível carregar as configurações</h2><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div></div></div>`;
    }
    return;
  }

  if (target.closest('#save-available-ai-settings')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    await saveSettings();
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target || target.id !== 'chat-available-ai') return;

  event.stopImmediatePropagation();
  const source = availableAis.find((item) => item.value === target.value);
  const saveButton = document.querySelector<HTMLButtonElement>('#save-available-ai-settings');
  const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');

  if (saveButton) saveButton.disabled = !source;
  if (!modelSelect) return;

  if (!source) {
    modelSelect.innerHTML = '<option value="">Selecione uma IA</option>';
    return;
  }

  modelSelect.innerHTML = '<option value="">Carregando modelos...</option>';
  void loadModels(source, source.selectedModel || '');
}, true);

restoreChatAfterReload();
