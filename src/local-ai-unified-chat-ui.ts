import {
  buildUnifiedLocalModelChoices,
  findUnifiedLocalChoice,
  type UnifiedLocalModelChoice,
  type UnifiedLocalModelInput,
} from './ai/local-model-unified-selection';
import type { ManagedLocalRuntimeInfo } from './ai/local-model-manager';

const LOCAL_OPTION_VALUE = 'local:unified';
const LOCAL_PROVIDER_IDS = new Set(['auto-codez-local', 'ollama', 'lm-studio']);
const LOCAL_STYLE_ID = 'auto-codez-unified-local-chat-style';
const RESTORE_CHAT_KEY = 'auto-codez.restore-chat-after-settings';

type Chat = {
  id: string;
  providerId: string;
  model: string;
  intelligence: string;
  permissionLevel: string;
};

type LocalSnapshot = {
  runtimes: ManagedLocalRuntimeInfo[];
  installed: UnifiedLocalModelInput[];
  catalog: UnifiedLocalModelInput[];
};

type InstallEvent = {
  type: 'progress' | 'complete' | 'cancelled' | 'error';
  runtimeId: string;
  modelId: string;
  progress?: { percent?: number; done: boolean };
  error?: string;
};

type LocalBridge = {
  snapshot: () => Promise<LocalSnapshot>;
  install: (input: { runtimeId: string; modelId: string }) => Promise<{ started: boolean }>;
  onInstallEvent: (listener: (event: InstallEvent) => void) => () => void;
};

type AppBridge = {
  getState: () => Promise<{ chats: Chat[] }>;
  updateChatSettings: (input: {
    chatId: string;
    providerId: string;
    model: string;
    intelligence: string;
    permissionLevel: string;
  }) => Promise<Chat>;
};

let activeModalChatId = '';
let activeChat: Chat | undefined;
let localSnapshot: LocalSnapshot | undefined;
let localChoices: UnifiedLocalModelChoice[] = [];
let localOverrideChoiceId = '';
let lastAcceptableChoiceId = '';
let installInFlightKey = '';
let renderScheduled = false;
let snapshotInFlight: Promise<void> | undefined;

function appApi(): AppBridge {
  return window.autoCodez as unknown as AppBridge;
}

function localApi(): LocalBridge | undefined {
  return (window as unknown as { autoCodezLocalAi?: LocalBridge }).autoCodezLocalAi;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '';
  const gib = value / 1024 ** 3;
  return gib >= 1 ? `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}

function installStyles(): void {
  if (document.getElementById(LOCAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = LOCAL_STYLE_ID;
  style.textContent = `
    #chat-available-ai.local-unified-selected{border-color:#436f9e;box-shadow:0 0 0 1px rgba(67,111,158,.18) inset;background:#101722}
    .chat-local-unified-note{font:10px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;color:#697789;margin-top:5px}
    .chat-local-unified-runtime{display:inline-flex;align-items:center;gap:5px;margin-top:5px;font:9.5px/1.4 Inter,ui-sans-serif,system-ui,sans-serif;color:#708094}
  `;
  document.head.appendChild(style);
}

function aiSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('#chat-available-ai');
}

function modelSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('#chat-model');
}

function stateRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#chat-local-model-state');
}

function saveButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('#save-available-ai-settings');
}

function isUnifiedLocalSelected(): boolean {
  return aiSelect()?.value === LOCAL_OPTION_VALUE;
}

function setSaveEnabled(enabled: boolean): void {
  const button = saveButton();
  if (button) button.disabled = !enabled;
}

function optionIsLocalProvider(option: HTMLOptionElement): boolean {
  if (!option.value.startsWith('provider:')) return false;
  return LOCAL_PROVIDER_IDS.has(option.value.slice('provider:'.length));
}

function ensureUnifiedLocalOption(): boolean {
  const select = aiSelect();
  if (!select) return false;
  const selectedWasLocal = [...select.options].some((option) => option.selected && optionIsLocalProvider(option));
  for (const option of [...select.options]) {
    if (optionIsLocalProvider(option)) option.remove();
  }
  let unified = [...select.options].find((option) => option.value === LOCAL_OPTION_VALUE);
  if (!unified) {
    unified = document.createElement('option');
    unified.value = LOCAL_OPTION_VALUE;
    unified.textContent = 'Usar IA local · recomendado';
    select.insertBefore(unified, select.firstChild);
  }
  if (selectedWasLocal) select.value = LOCAL_OPTION_VALUE;
  select.classList.toggle('local-unified-selected', select.value === LOCAL_OPTION_VALUE);
  return selectedWasLocal || select.value === LOCAL_OPTION_VALUE;
}

function buildChoices(snapshot: LocalSnapshot): UnifiedLocalModelChoice[] {
  return buildUnifiedLocalModelChoices([...snapshot.catalog, ...snapshot.installed], snapshot.runtimes);
}

async function refreshSnapshot(): Promise<void> {
  const bridge = localApi();
  if (!bridge) {
    localSnapshot = undefined;
    localChoices = [];
    return;
  }
  localSnapshot = await bridge.snapshot();
  localChoices = buildChoices(localSnapshot);
}

async function ensureSnapshot(): Promise<void> {
  if (localSnapshot) return;
  if (!snapshotInFlight) {
    snapshotInFlight = refreshSnapshot().finally(() => {
      snapshotInFlight = undefined;
    });
  }
  await snapshotInFlight;
}

async function loadActiveChat(): Promise<void> {
  if (!activeModalChatId) return;
  try {
    const state = await appApi().getState();
    activeChat = state.chats.find((chat) => chat.id === activeModalChatId);
  } catch {
    activeChat = undefined;
  }
}

function currentChoice(): UnifiedLocalModelChoice | undefined {
  const id = modelSelect()?.value;
  return id ? localChoices.find((choice) => choice.id === id) : undefined;
}

function compatibilityExplanation(choice: UnifiedLocalModelChoice): string {
  const model = choice.selected;
  const reason = model.compatibility.reasons.join(' ') || model.description || 'Compatibilidade calculada localmente pelo Auto CodeZ.';
  const ram = formatBytes(model.compatibility.requirements.estimatedRamBytes);
  return `${reason}${ram ? ` RAM estimada para uso: ${ram}.` : ''}`.trim();
}

function initialChoiceId(): string {
  const select = modelSelect();
  if (select && localChoices.some((choice) => choice.id === select.value)) return select.value;
  if (activeChat && LOCAL_PROVIDER_IDS.has(activeChat.providerId)) {
    return findUnifiedLocalChoice(localChoices, activeChat.providerId, activeChat.model)?.id || '';
  }
  return localChoices[0]?.id || '';
}

function renderModelOptions(): void {
  const select = modelSelect();
  if (!select) return;
  const selected = initialChoiceId();
  if (!localChoices.length) {
    select.innerHTML = '<option value="">Nenhum modelo local disponível</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = localChoices.map((choice) => {
    const selectedVariant = choice.selected;
    const tags = [
      choice.installed ? 'instalado' : '',
      choice.recommended ? 'recomendado' : '',
      selectedVariant.parameterSize || '',
    ].filter(Boolean).join(' · ');
    return `<option value="${escapeHtml(choice.id)}" ${choice.id === selected ? 'selected' : ''}>${escapeHtml(choice.name)}${tags ? ` · ${escapeHtml(tags)}` : ''}</option>`;
  }).join('');
  if (!select.value) select.value = localChoices[0]?.id || '';
}

function selectFallback(blockedChoiceId: string): void {
  const select = modelSelect();
  if (!select) return;
  const candidates = localChoices.filter((choice) => choice.id !== blockedChoiceId && choice.selected.compatibility.level !== 'blocked');
  const preferred = candidates.find((choice) => choice.id === lastAcceptableChoiceId)
    || candidates.find((choice) => choice.installed && choice.selected.compatibility.level !== 'limit')
    || candidates.find((choice) => choice.recommended)
    || candidates[0];
  select.value = preferred?.id || '';
  localOverrideChoiceId = '';
  renderSelectionState();
  select.focus();
}

function renderSelectionState(): void {
  const root = stateRoot();
  const choice = currentChoice();
  if (!root || !isUnifiedLocalSelected()) return;
  root.innerHTML = '';
  setSaveEnabled(false);
  if (!choice) {
    root.innerHTML = '<div class="chat-local-notice warning"><strong>Selecione um modelo local</strong><span>O Auto CodeZ verifica hardware, instalação e disponibilidade antes de liberar este chat.</span></div>';
    return;
  }

  const model = choice.selected;
  const runtime = model.runtime;
  const compatibility = model.compatibility.level;
  if (compatibility === 'blocked') {
    root.innerHTML = `<div class="chat-local-notice blocked"><strong>Este modelo é pesado demais para este computador</strong><span>${escapeHtml(compatibilityExplanation(choice))} O Auto CodeZ bloqueia esta seleção porque a chance de travamentos ou uso praticamente inviável é alta.</span><div class="chat-local-actions"><button class="chat-local-button" type="button" data-unified-local-back="${escapeHtml(choice.id)}">Voltar para modelos</button></div></div>`;
    return;
  }
  if (compatibility === 'limit' && localOverrideChoiceId !== choice.id) {
    root.innerHTML = `<div class="chat-local-notice warning"><strong>Este modelo pode funcionar com ressalvas</strong><span>${escapeHtml(compatibilityExplanation(choice))} O desempenho pode oscilar e o sistema pode ficar sob pressão durante inferências maiores.</span><div class="chat-local-actions"><button class="chat-local-button" type="button" data-unified-local-back="${escapeHtml(choice.id)}">Voltar para modelos</button><button class="chat-local-button primary" type="button" data-unified-local-override="${escapeHtml(choice.id)}">Usar mesmo assim</button></div></div>`;
    return;
  }

  lastAcceptableChoiceId = choice.id;
  if (!runtime?.available) {
    const details = [model.parameterSize, formatBytes(model.sizeBytes), model.quantization].filter(Boolean).join(' · ');
    root.innerHTML = `<div class="chat-local-notice warning"><strong>O mecanismo local ainda não está disponível</strong><span>O Auto CodeZ encontrou este modelo, mas nenhum backend configurado para ele está respondendo agora. Inicie um runtime local configurado e tente novamente. O runtime próprio do Auto CodeZ será priorizado automaticamente quando estiver disponível.</span><div class="chat-local-actions"><button class="chat-local-button" type="button" data-unified-local-retry>Tentar novamente</button></div></div>${choice.installed ? '' : `<div class="chat-local-install"><div class="chat-local-install-copy"><strong>${escapeHtml(choice.name)} ainda não está no computador</strong><span>${escapeHtml(details || 'Download local aguardando um backend disponível.')}</span></div><button class="chat-local-button primary" type="button" disabled>Instalar modelo</button></div>`}`;
    return;
  }

  if (choice.installed && model.installed) {
    setSaveEnabled(true);
    return;
  }

  if (!runtime.operations.install) {
    root.innerHTML = '<div class="chat-local-notice warning"><strong>Modelo ainda não está instalado</strong><span>O backend disponível consegue executar modelos locais, mas não oferece instalação controlável pelo Auto CodeZ para esta opção.</span></div>';
    return;
  }

  const installKey = `${model.runtimeId}::${model.id}`;
  const progress = installInFlightKey === installKey ? 'Instalando…' : 'Instalar modelo';
  const details = [model.parameterSize, formatBytes(model.sizeBytes), model.quantization].filter(Boolean).join(' · ');
  root.innerHTML = `<div class="chat-local-install"><div class="chat-local-install-copy"><strong>${escapeHtml(choice.name)} ainda não está no computador</strong><span>${escapeHtml(details || 'Download gerenciado pelo Auto CodeZ.')}</span><span class="chat-local-unified-runtime">Backend selecionado automaticamente: ${escapeHtml(runtime.displayName)}</span></div><button class="chat-local-button primary" type="button" data-unified-local-install="${escapeHtml(choice.id)}" ${installInFlightKey === installKey ? 'disabled' : ''}>${escapeHtml(progress)}</button></div>`;
}

async function renderUnifiedLocal(): Promise<void> {
  if (!isUnifiedLocalSelected()) return;
  await Promise.all([ensureSnapshot(), loadActiveChat()]);
  if (!isUnifiedLocalSelected()) return;
  renderModelOptions();
  renderSelectionState();
  aiSelect()?.classList.add('local-unified-selected');
}

function scheduleEnhancement(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  window.setTimeout(() => {
    renderScheduled = false;
    installStyles();
    const localSelected = ensureUnifiedLocalOption();
    if (localSelected) void renderUnifiedLocal();
  }, 0);
}

async function retryRuntime(): Promise<void> {
  localSnapshot = undefined;
  await refreshSnapshot();
  renderModelOptions();
  renderSelectionState();
}

async function installCurrentChoice(choiceId: string): Promise<void> {
  const choice = localChoices.find((item) => item.id === choiceId);
  const bridge = localApi();
  if (!choice || !bridge) return;
  const model = choice.selected;
  if (model.compatibility.level === 'blocked') return;
  if (model.compatibility.level === 'limit' && localOverrideChoiceId !== choice.id) return;
  if (!model.runtime?.available || !model.runtime.operations.install) return;
  installInFlightKey = `${model.runtimeId}::${model.id}`;
  renderSelectionState();
  try {
    await bridge.install({ runtimeId: model.runtimeId, modelId: model.id });
  } catch (error) {
    installInFlightKey = '';
    renderSelectionState();
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível iniciar a instalação local.' }));
  }
}

async function saveUnifiedLocal(): Promise<void> {
  const button = saveButton();
  const permission = document.querySelector<HTMLSelectElement>('#chat-permission');
  const choice = currentChoice();
  if (!button || button.disabled || !permission || !choice) return;
  const model = choice.selected;
  if (!model.installed || !model.runtime?.available || model.compatibility.level === 'blocked') return;
  if (model.compatibility.level === 'limit' && localOverrideChoiceId !== choice.id) return;

  if (!activeChat || activeChat.id !== activeModalChatId) await loadActiveChat();
  if (!activeChat) return;
  button.disabled = true;
  button.textContent = 'Salvando...';
  try {
    const updated = await appApi().updateChatSettings({
      chatId: activeChat.id,
      providerId: model.runtimeId,
      model: model.id,
      intelligence: activeChat.intelligence,
      permissionLevel: permission.value,
    });
    document.querySelector('#modal-root')?.replaceChildren();
    window.dispatchEvent(new CustomEvent('auto-codez-chat-settings-updated', { detail: updated }));
    sessionStorage.setItem(RESTORE_CHAT_KEY, updated.id);
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Salvar configurações';
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível salvar a IA local.' }));
  }
}

const observer = new MutationObserver(scheduleEnhancement);
observer.observe(document.documentElement, { subtree: true, childList: true });

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const settings = target.closest<HTMLElement>('[data-chat-settings]');
  if (settings?.dataset.chatSettings) {
    activeModalChatId = settings.dataset.chatSettings;
    activeChat = undefined;
    localOverrideChoiceId = '';
    lastAcceptableChoiceId = '';
    return;
  }
  if (!isUnifiedLocalSelected()) return;
  if (target.closest('#save-available-ai-settings')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void saveUnifiedLocal();
    return;
  }
  const back = target.closest<HTMLElement>('[data-unified-local-back]');
  if (back?.dataset.unifiedLocalBack) {
    event.preventDefault();
    event.stopImmediatePropagation();
    selectFallback(back.dataset.unifiedLocalBack);
    return;
  }
  const override = target.closest<HTMLElement>('[data-unified-local-override]');
  if (override?.dataset.unifiedLocalOverride) {
    event.preventDefault();
    event.stopImmediatePropagation();
    localOverrideChoiceId = override.dataset.unifiedLocalOverride;
    renderSelectionState();
    return;
  }
  const install = target.closest<HTMLElement>('[data-unified-local-install]');
  if (install?.dataset.unifiedLocalInstall) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void installCurrentChoice(install.dataset.unifiedLocalInstall);
    return;
  }
  if (target.closest('[data-unified-local-retry]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void retryRuntime();
  }
}, true);

document.addEventListener('change', (event) => {
  const target = event.target instanceof HTMLSelectElement ? event.target : null;
  if (!target) return;
  if (target.id === 'chat-available-ai') {
    target.classList.toggle('local-unified-selected', target.value === LOCAL_OPTION_VALUE);
    if (target.value !== LOCAL_OPTION_VALUE) return;
    event.stopImmediatePropagation();
    setSaveEnabled(false);
    localOverrideChoiceId = '';
    void renderUnifiedLocal();
    return;
  }
  if (target.id === 'chat-model' && isUnifiedLocalSelected()) {
    event.stopImmediatePropagation();
    localOverrideChoiceId = '';
    renderSelectionState();
  }
}, true);

const unsubscribeInstall = localApi()?.onInstallEvent((event) => {
  if (!isUnifiedLocalSelected()) return;
  const choice = currentChoice();
  if (!choice || !choice.variants.some((variant) => variant.runtimeId === event.runtimeId && variant.id === event.modelId)) return;
  const key = `${event.runtimeId}::${event.modelId}`;
  if (event.type === 'progress') {
    installInFlightKey = key;
    const button = document.querySelector<HTMLButtonElement>('[data-unified-local-install]');
    if (button) button.textContent = event.progress?.percent === undefined ? 'Instalando…' : `Instalando ${Math.round(event.progress.percent)}%`;
    return;
  }
  installInFlightKey = '';
  if (event.type === 'complete') {
    localSnapshot = undefined;
    void refreshSnapshot().then(() => {
      renderModelOptions();
      renderSelectionState();
    });
    return;
  }
  renderSelectionState();
  if (event.type === 'error' && event.error) {
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: event.error }));
  }
});

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  unsubscribeInstall?.();
}, { once: true });

scheduleEnhancement();
