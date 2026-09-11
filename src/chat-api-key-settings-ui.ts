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
type CompatibilityLevel = 'excellent' | 'compatible' | 'limit' | 'blocked';
type Compatibility = { level: CompatibilityLevel; reasons: string[]; requirements: { estimatedRamBytes?: number; minimumFreeDiskBytes?: number } };
type RuntimeInfo = {
  id: string;
  displayName: string;
  available: boolean;
  operations: { install: boolean; cancelInstall: boolean; remove: boolean };
};
type ManagedModel = {
  id: string;
  name: string;
  runtimeId: string;
  installed: boolean;
  installing?: boolean;
  recommended?: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  description?: string;
  compatibility: Compatibility;
};
type LocalAiSnapshot = {
  runtimes: RuntimeInfo[];
  installed: ManagedModel[];
  catalog: ManagedModel[];
  recommendation?: { runtimeId: string; modelId: string; compatibility: Compatibility; reason: string };
};
type InstallEvent = {
  type: 'progress' | 'complete' | 'cancelled' | 'error';
  runtimeId: string;
  modelId: string;
  progress?: { status: string; percent?: number; done: boolean };
  error?: string;
};

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

type LocalAiApi = {
  snapshot: () => Promise<LocalAiSnapshot>;
  install: (input: { runtimeId: string; modelId: string }) => Promise<{ started: boolean }>;
  cancelInstall: (input: { runtimeId: string; modelId: string }) => Promise<{ cancelled: boolean }>;
  onInstallEvent: (listener: (event: InstallEvent) => void) => () => void;
};

type AvailableAi = {
  value: string;
  providerId: string;
  label: string;
  selectedModel?: string;
  apiKeyId?: string;
};

const RESTORE_CHAT_KEY = 'auto-codez.restore-chat-after-settings';
const LOCAL_STYLE_ID = 'auto-codez-chat-local-model-style';
let openChat: Chat | null = null;
let availableAis: AvailableAi[] = [];
let localSnapshot: LocalAiSnapshot | null = null;
let localOverrideModelKey = '';
let lastAcceptableModel = '';
let installInFlightKey = '';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function installStyles(): void {
  if (document.getElementById(LOCAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = LOCAL_STYLE_ID;
  style.textContent = `
    .chat-local-model-state{display:flex;flex-direction:column;gap:10px;margin-top:10px}
    .chat-local-model-state:empty{display:none}
    .chat-local-notice{border:1px solid #394250;border-radius:10px;background:#111720;padding:12px 13px;color:#cbd3de}
    .chat-local-notice.warning{border-color:#655a38;background:#1b1810}.chat-local-notice.blocked{border-color:#703f46;background:#1c1114}
    .chat-local-notice strong{display:block;font:600 12px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;color:#edf1f6}.chat-local-notice span{display:block;margin-top:4px;font:10.5px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;color:#8f9aa8}
    .chat-local-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
    .chat-local-button{height:32px;border:1px solid #303946;border-radius:7px;background:#171d25;color:#cbd3dd;padding:0 12px;font:600 10.5px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}.chat-local-button:hover{background:#202732}.chat-local-button.primary{border-color:#3178c6;background:#2563a7;color:#fff}.chat-local-button.primary:hover{background:#2d72bd}.chat-local-button:disabled{opacity:.5;cursor:default}
    .chat-local-install{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #273342;border-radius:10px;background:#0e141c;padding:11px 12px}.chat-local-install-copy{min-width:0}.chat-local-install-copy strong{display:block;font:600 11px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;color:#e4e9ef}.chat-local-install-copy span{display:block;margin-top:3px;font:10px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:#7f8a98}
    #save-available-ai-settings:disabled{background:#454b54!important;color:#9aa1aa!important;cursor:not-allowed!important;opacity:.72!important}
  `;
  document.head.appendChild(style);
}

function modalRoot(): HTMLElement | null {
  return document.querySelector('#modal-root');
}

function api(): ChatApi {
  return window.autoCodez as unknown as ChatApi;
}

function localApi(): LocalAiApi | undefined {
  return (window as unknown as { autoCodezLocalAi?: LocalAiApi }).autoCodezLocalAi;
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

function selectedAi(): AvailableAi | undefined {
  const select = document.querySelector<HTMLSelectElement>('#chat-available-ai');
  return availableAis.find((item) => item.value === select?.value);
}

function modelKey(runtimeId: string, modelId: string): string {
  return `${runtimeId}:${modelId}`;
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '';
  const gib = value / 1024 ** 3;
  return gib >= 1 ? `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}

function localCandidates(runtimeId: string): ManagedModel[] {
  if (!localSnapshot) return [];
  const result = new Map<string, ManagedModel>();
  for (const model of [...localSnapshot.catalog, ...localSnapshot.installed]) {
    if (model.runtimeId !== runtimeId) continue;
    const existing = result.get(model.id);
    if (!existing) result.set(model.id, model);
    else result.set(model.id, { ...existing, ...model, installed: existing.installed || model.installed });
  }
  return [...result.values()].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function currentLocalModel(): ManagedModel | undefined {
  const source = selectedAi();
  const modelId = document.querySelector<HTMLSelectElement>('#chat-model')?.value;
  if (!source || source.apiKeyId || !modelId) return undefined;
  return localCandidates(source.providerId).find((model) => model.id === modelId);
}

function setSaveEnabled(enabled: boolean): void {
  const button = document.querySelector<HTMLButtonElement>('#save-available-ai-settings');
  if (button) button.disabled = !enabled;
}

function localStateRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#chat-local-model-state');
}

function compatibilityExplanation(model: ManagedModel): string {
  const reason = model.compatibility.reasons.join(' ') || model.description || 'Compatibilidade calculada localmente pelo Auto CodeZ.';
  const ram = formatBytes(model.compatibility.requirements.estimatedRamBytes);
  return `${reason}${ram ? ` RAM estimada para uso: ${ram}.` : ''}`.trim();
}

function selectFallbackModel(runtimeId: string, blockedModelId: string): void {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;
  const candidates = localCandidates(runtimeId).filter((model) => model.id !== blockedModelId && model.compatibility.level !== 'blocked');
  const preferred = candidates.find((model) => model.id === lastAcceptableModel)
    || candidates.find((model) => model.installed && model.compatibility.level !== 'limit')
    || candidates.find((model) => model.recommended)
    || candidates[0];
  select.value = preferred?.id || '';
  localOverrideModelKey = '';
  void renderLocalSelectionState();
  select.focus();
}

async function renderLocalSelectionState(): Promise<void> {
  const source = selectedAi();
  const root = localStateRoot();
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!root || !select) return;
  root.innerHTML = '';
  if (!source || source.apiKeyId) {
    setSaveEnabled(Boolean(source && select.value));
    return;
  }

  const snapshot = localSnapshot;
  const runtime = snapshot?.runtimes.find((item) => item.id === source.providerId);
  if (!runtime?.available) {
    setSaveEnabled(false);
    root.innerHTML = `<div class="chat-local-notice blocked"><strong>${escapeHtml(runtime?.displayName || source.label)} não está respondendo</strong><span>Inicie o runtime local e tente novamente. O Auto CodeZ não salva um modelo local que não consegue confirmar no computador.</span></div>`;
    return;
  }

  const model = currentLocalModel();
  if (!model) {
    setSaveEnabled(false);
    root.innerHTML = `<div class="chat-local-notice warning"><strong>Selecione um modelo disponível</strong><span>O Auto CodeZ só libera o chat depois de confirmar a compatibilidade e a disponibilidade do modelo local.</span></div>`;
    return;
  }

  const key = modelKey(model.runtimeId, model.id);
  if (model.compatibility.level === 'blocked') {
    setSaveEnabled(false);
    root.innerHTML = `<div class="chat-local-notice blocked"><strong>Este modelo é pesado demais para este computador</strong><span>${escapeHtml(compatibilityExplanation(model))} O Auto CodeZ bloqueia esta seleção porque a chance de travamentos ou uso praticamente inviável é alta.</span><div class="chat-local-actions"><button class="chat-local-button" type="button" data-local-model-back="${escapeHtml(model.id)}">Voltar para modelos</button></div></div>`;
    return;
  }

  if (model.compatibility.level === 'limit' && localOverrideModelKey !== key) {
    setSaveEnabled(false);
    root.innerHTML = `<div class="chat-local-notice warning"><strong>Este modelo pode funcionar com ressalvas</strong><span>${escapeHtml(compatibilityExplanation(model))} O desempenho pode oscilar e o sistema pode ficar sob pressão durante inferências maiores.</span><div class="chat-local-actions"><button class="chat-local-button" type="button" data-local-model-back="${escapeHtml(model.id)}">Voltar para modelos</button><button class="chat-local-button primary" type="button" data-local-model-override="${escapeHtml(key)}">Usar mesmo assim</button></div></div>`;
    return;
  }

  lastAcceptableModel = model.id;
  if (model.installed) {
    setSaveEnabled(true);
    return;
  }

  setSaveEnabled(false);
  if (!runtime.operations.install) {
    root.innerHTML = `<div class="chat-local-notice warning"><strong>Modelo ainda não está instalado</strong><span>${escapeHtml(runtime.displayName)} não oferece instalação controlável pelo Auto CodeZ para este modelo. Instale-o no runtime e volte a esta tela.</span></div>`;
    return;
  }

  const progress = installInFlightKey === key ? 'Instalando…' : 'Instalar modelo';
  const details = [model.parameterSize, formatBytes(model.sizeBytes), model.quantization].filter(Boolean).join(' · ');
  root.innerHTML = `<div class="chat-local-install"><div class="chat-local-install-copy"><strong>${escapeHtml(model.name)} ainda não está no computador</strong><span>${escapeHtml(details || 'Download gerenciado pelo runtime local.')}</span></div><button class="chat-local-button primary" type="button" data-local-model-install="${escapeHtml(key)}" ${installInFlightKey === key ? 'disabled' : ''}>${escapeHtml(progress)}</button></div>`;
}

async function refreshLocalSnapshot(): Promise<LocalAiSnapshot | null> {
  const bridge = localApi();
  if (!bridge) return null;
  try {
    localSnapshot = await bridge.snapshot();
    return localSnapshot;
  } catch {
    localSnapshot = null;
    return null;
  }
}

function renderLocalModelOptions(source: AvailableAi, selectedModel: string): void {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;
  const candidates = localCandidates(source.providerId);
  if (!candidates.length) {
    select.innerHTML = selectedModel
      ? `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel)}</option>`
      : '<option value="">Nenhum modelo local confirmado</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = candidates.map((model) => {
    const tags = [model.installed ? 'instalado' : '', model.recommended ? 'recomendado' : ''].filter(Boolean).join(' · ');
    return `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.name)}${tags ? ` · ${escapeHtml(tags)}` : ''}</option>`;
  }).join('');
  if (!select.value) select.value = candidates[0]?.id || '';
}

async function loadModels(source: AvailableAi, selectedModel: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#chat-model');
  if (!select) return;

  select.disabled = true;
  localOverrideModelKey = '';
  installInFlightKey = '';
  try {
    if (!source.apiKeyId) {
      await refreshLocalSnapshot();
      renderLocalModelOptions(source, selectedModel);
      await renderLocalSelectionState();
      return;
    }

    const models = await api().listModelsForApiKey(source.apiKeyId);
    select.innerHTML = models.length
      ? models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? 'selected' : ''}>${escapeHtml(model.name)}</option>`).join('')
      : `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || 'Nenhum modelo disponível')}</option>`;
    setSaveEnabled(Boolean(select.value));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível carregar os modelos';
    select.innerHTML = `<option value="${escapeHtml(selectedModel)}">${escapeHtml(selectedModel || message)}</option>`;
    setSaveEnabled(false);
  } finally {
    if (source.apiKeyId) select.disabled = false;
  }
}

function openAvailableAiSettings(chat: Chat, keys: SavedApiKey[], providers: ProviderSummary[]): void {
  const root = modalRoot();
  if (!root) return;
  installStyles();
  openChat = chat;
  availableAis = buildAvailableAis(keys, providers);
  localSnapshot = null;
  localOverrideModelKey = '';
  lastAcceptableModel = chat.model;
  installInFlightKey = '';

  const current = currentAiFor(chat, availableAis, keys);
  const options = availableAis.length
    ? availableAis.map((source) => `<option value="${escapeHtml(source.value)}" ${source.value === current?.value ? 'selected' : ''}>${escapeHtml(source.label)}</option>`).join('')
    : '<option value="">Nenhuma IA disponível</option>';

  root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><div class="eyebrow">CHAT</div><h2>Configurações do chat</h2><p>Escolha uma IA cloud salva ou um provider local disponível para esta conversa.</p></div><button class="modal-close" data-action="close-modal" title="Fechar" aria-label="Fechar"></button></div><label>IAs disponíveis<select id="chat-available-ai">${options}</select></label><label>Modelo<select id="chat-model"><option value="">${current ? 'Carregando modelos...' : 'Selecione uma IA'}</option></select></label><div class="chat-local-model-state" id="chat-local-model-state"></div><label>Nível de acesso<select id="chat-permission"><option value="read-only" ${chat.permissionLevel === 'read-only' ? 'selected' : ''}>Somente leitura</option><option value="safe" ${chat.permissionLevel === 'safe' ? 'selected' : ''}>Acesso seguro</option><option value="ask" ${chat.permissionLevel === 'ask' ? 'selected' : ''}>Acesso solicitado</option><option value="unrestricted" ${chat.permissionLevel === 'unrestricted' ? 'selected' : ''}>Acesso irrestrito</option></select></label><button class="primary-button" id="save-available-ai-settings" disabled>Salvar configurações</button></div></div>`;

  if (current) void loadModels(current, chat.model || current.selectedModel || '');
}

async function saveSettings(): Promise<void> {
  const chat = openChat;
  if (!chat) return;
  const aiSelect = document.querySelector<HTMLSelectElement>('#chat-available-ai');
  const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');
  const permissionSelect = document.querySelector<HTMLSelectElement>('#chat-permission');
  const saveButton = document.querySelector<HTMLButtonElement>('#save-available-ai-settings');
  if (!aiSelect || !modelSelect || !permissionSelect || !saveButton || saveButton.disabled) return;
  const source = availableAis.find((item) => item.value === aiSelect.value);
  if (!source || !modelSelect.value) return;

  if (!source.apiKeyId) {
    const model = currentLocalModel();
    if (!model?.installed || model.compatibility.level === 'blocked') return;
    if (model.compatibility.level === 'limit' && localOverrideModelKey !== modelKey(model.runtimeId, model.id)) return;
  }

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
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível salvar as configurações do chat.' }));
  }
}

async function installSelectedModel(key: string): Promise<void> {
  const bridge = localApi();
  const model = currentLocalModel();
  if (!bridge || !model || modelKey(model.runtimeId, model.id) !== key || model.compatibility.level === 'blocked') return;
  if (model.compatibility.level === 'limit' && localOverrideModelKey !== key) return;
  installInFlightKey = key;
  await renderLocalSelectionState();
  try {
    await bridge.install({ runtimeId: model.runtimeId, modelId: model.id });
  } catch (error) {
    installInFlightKey = '';
    await renderLocalSelectionState();
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível iniciar a instalação do modelo.' }));
  }
}

function restoreChatAfterReload(): void {
  const chatId = sessionStorage.getItem(RESTORE_CHAT_KEY);
  if (!chatId) return;
  const deadline = Date.now() + 10_000;
  const tryRestore = async (): Promise<void> => {
    if (Date.now() >= deadline) return;
    try {
      const state = await api().getState();
      const chat = state.chats.find((item) => item.id === chatId);
      const provider = chat ? state.providers.find((item) => item.id === chat.providerId) : undefined;
      const chatButton = document.querySelector<HTMLElement>(`.chat-item[data-chat="${CSS.escape(chatId)}"]`);
      if (chat && provider && chatButton) {
        chatButton.click();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
        const selected = document.querySelector<HTMLElement>(`.chat-item.selected[data-chat="${CSS.escape(chatId)}"]`);
        const headerText = document.querySelector<HTMLElement>('#chat-header')?.textContent || '';
        const chatText = selected?.textContent || '';
        if (selected && headerText.includes(provider.displayName) && chatText.includes(provider.displayName) && headerText.includes(chat.model)) {
          sessionStorage.removeItem(RESTORE_CHAT_KEY);
          return;
        }
      }
    } catch {}
    window.setTimeout((): void => { void tryRestore(); }, 80);
  };
  window.setTimeout((): void => { void tryRestore(); }, 0);
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
      openAvailableAiSettings(chat, await api().listApiKeys(), state.providers);
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
    return;
  }
  const back = target.closest<HTMLElement>('[data-local-model-back]');
  if (back) {
    event.preventDefault();
    const source = selectedAi();
    if (source) selectFallbackModel(source.providerId, back.dataset.localModelBack || '');
    return;
  }
  const override = target.closest<HTMLElement>('[data-local-model-override]');
  if (override?.dataset.localModelOverride) {
    event.preventDefault();
    localOverrideModelKey = override.dataset.localModelOverride;
    await renderLocalSelectionState();
    return;
  }
  const install = target.closest<HTMLElement>('[data-local-model-install]');
  if (install?.dataset.localModelInstall) {
    event.preventDefault();
    await installSelectedModel(install.dataset.localModelInstall);
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target) return;
  if (target.id === 'chat-available-ai') {
    event.stopImmediatePropagation();
    const source = availableAis.find((item) => item.value === target.value);
    const modelSelect = document.querySelector<HTMLSelectElement>('#chat-model');
    setSaveEnabled(false);
    if (!modelSelect) return;
    if (!source) {
      modelSelect.innerHTML = '<option value="">Selecione uma IA</option>';
      return;
    }
    modelSelect.innerHTML = '<option value="">Carregando modelos...</option>';
    void loadModels(source, source.selectedModel || '');
    return;
  }
  if (target.id === 'chat-model') {
    const source = selectedAi();
    if (!source) return;
    if (source.apiKeyId) setSaveEnabled(Boolean(target.value));
    else {
      localOverrideModelKey = '';
      void renderLocalSelectionState();
    }
  }
}, true);

const unsubscribeInstall = localApi()?.onInstallEvent((event) => {
  const selected = currentLocalModel();
  if (!selected || event.runtimeId !== selected.runtimeId || event.modelId !== selected.id) return;
  const key = modelKey(event.runtimeId, event.modelId);
  if (event.type === 'progress') {
    installInFlightKey = key;
    const button = document.querySelector<HTMLButtonElement>(`[data-local-model-install="${CSS.escape(key)}"]`);
    if (button) button.textContent = event.progress?.percent === undefined ? 'Instalando…' : `Instalando ${Math.round(event.progress.percent)}%`;
    return;
  }
  if (event.type === 'complete') {
    installInFlightKey = '';
    void refreshLocalSnapshot().then(() => renderLocalSelectionState());
    return;
  }
  if (event.type === 'cancelled' || event.type === 'error') {
    installInFlightKey = '';
    void renderLocalSelectionState();
    if (event.type === 'error' && event.error) window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: event.error }));
  }
});

window.addEventListener('beforeunload', () => unsubscribeInstall?.(), { once: true });
restoreChatAfterReload();
