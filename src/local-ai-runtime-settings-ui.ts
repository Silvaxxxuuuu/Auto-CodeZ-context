import './local-ai-runtime-settings-ui.css';

type LocalRuntimeSettingsSummary = {
  runtimeId: string;
  displayName: string;
  endpoint: string;
  tokenSupported: boolean;
  tokenConfigured: boolean;
};

type LocalRuntimeSettingsBridge = {
  listSettings: () => Promise<LocalRuntimeSettingsSummary[]>;
  saveSettings: (input: { runtimeId: string; endpoint: string; apiToken?: string; clearToken?: boolean }) => Promise<unknown>;
};

const bridge = (window as unknown as { autoCodezLocalAi?: LocalRuntimeSettingsBridge }).autoCodezLocalAi;
let renderGeneration = 0;
let scheduled = false;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function isLocalAiActive(): boolean {
  return document.querySelector<HTMLElement>('[data-local-ai-settings]')?.classList.contains('active') === true;
}

function runtimeRow(settings: LocalRuntimeSettingsSummary): string {
  const runtimeId = escapeHtml(settings.runtimeId);
  const endpoint = escapeHtml(settings.endpoint);
  const tokenState = settings.tokenConfigured ? 'Token protegido configurado.' : 'Nenhum token configurado.';
  const tokenControls = settings.tokenSupported
    ? `<input class="local-runtime-settings-input" type="password" autocomplete="new-password" spellcheck="false" data-runtime-token="${runtimeId}" placeholder="${settings.tokenConfigured ? 'Novo token (opcional)' : 'Token (opcional)'}" aria-label="Token de ${escapeHtml(settings.displayName)}"><div class="local-runtime-settings-actions"><button class="settings-action-button" type="button" data-runtime-settings-save="${runtimeId}">Salvar</button>${settings.tokenConfigured ? `<button class="settings-action-button" type="button" data-runtime-settings-clear-token="${runtimeId}">Limpar token</button>` : ''}</div>`
    : `<div class="local-runtime-settings-actions"><button class="settings-action-button" type="button" data-runtime-settings-save="${runtimeId}">Salvar</button></div>`;
  return `<div class="settings-row" data-runtime-settings-row="${runtimeId}"><div class="settings-row-copy"><strong>${escapeHtml(settings.displayName)}</strong><span>Somente endpoints HTTP/HTTPS de loopback são aceitos. Alterações passam a valer para inventário e chat sem reiniciar o Auto CodeZ.</span>${settings.tokenSupported ? `<small class="local-runtime-token-state${settings.tokenConfigured ? ' configured' : ''}">${escapeHtml(tokenState)}</small>` : ''}<small class="local-runtime-token-state" data-runtime-settings-error hidden></small></div><div class="settings-row-value"><div class="local-runtime-settings-controls${settings.tokenSupported ? '' : ' no-token'}"><input class="local-runtime-settings-input" type="url" spellcheck="false" data-runtime-endpoint="${runtimeId}" value="${endpoint}" aria-label="Endpoint de ${escapeHtml(settings.displayName)}">${tokenControls}</div></div></div>`;
}

function buildCard(settings: LocalRuntimeSettingsSummary[]): HTMLElement {
  const card = document.createElement('section');
  card.className = 'settings-card local-runtime-settings-card';
  card.dataset.localRuntimeSettingsCard = '';
  card.innerHTML = `<div class="local-ai-card-heading"><div><strong>Conexão dos runtimes</strong><span>Endpoints ficam em configuração local. Tokens opcionais são criptografados pelo sistema e nunca retornam ao renderer.</span></div><span class="settings-value-badge good">Protegido</span></div>${settings.map(runtimeRow).join('')}`;
  return card;
}

async function renderRuntimeSettings(): Promise<void> {
  if (!bridge?.listSettings || !isLocalAiActive()) return;
  const body = document.querySelector<HTMLElement>('.settings-overlay .settings-body');
  if (!body || body.querySelector('[data-local-runtime-settings-card]')) return;
  const generation = ++renderGeneration;
  try {
    const settings = await bridge.listSettings();
    if (generation !== renderGeneration || !body.isConnected || !isLocalAiActive() || body.querySelector('[data-local-runtime-settings-card]')) return;
    const card = buildCard(settings);
    const cards = body.querySelectorAll<HTMLElement>(':scope > .settings-card');
    if (cards[1]) cards[1].insertAdjacentElement('afterend', card);
    else body.appendChild(card);
  } catch (error) {
    if (generation !== renderGeneration || !body.isConnected || !isLocalAiActive() || body.querySelector('[data-local-runtime-settings-card]')) return;
    const card = document.createElement('section');
    card.className = 'settings-card local-runtime-settings-card';
    card.dataset.localRuntimeSettingsCard = '';
    const message = error instanceof Error ? error.message : 'Não foi possível carregar a configuração dos runtimes.';
    card.innerHTML = `<div class="local-ai-card-heading"><div><strong>Conexão dos runtimes</strong><span>${escapeHtml(message)}</span></div><span class="settings-value-badge locked">Indisponível</span></div>`;
    body.appendChild(card);
  }
}

function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void renderRuntimeSettings();
  });
}

function showRowError(row: HTMLElement, message: string): void {
  const target = row.querySelector<HTMLElement>('[data-runtime-settings-error]');
  if (!target) return;
  target.hidden = false;
  target.textContent = message;
}

function setRowBusy(row: HTMLElement, busy: boolean): void {
  row.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = busy; });
  row.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = busy; });
}

function refreshLocalAi(): void {
  document.querySelector<HTMLButtonElement>('[data-local-ai-action="retry"]')?.click();
  scheduleRender();
}

async function saveRuntimeSettings(row: HTMLElement, runtimeId: string, clearToken: boolean): Promise<void> {
  if (!bridge?.saveSettings) throw new Error('Configuração dos runtimes locais indisponível.');
  const endpoint = row.querySelector<HTMLInputElement>(`[data-runtime-endpoint="${CSS.escape(runtimeId)}"]`)?.value.trim();
  if (!endpoint) throw new Error('Informe o endpoint local do runtime.');
  const token = row.querySelector<HTMLInputElement>(`[data-runtime-token="${CSS.escape(runtimeId)}"]`)?.value.trim();
  await bridge.saveSettings({
    runtimeId,
    endpoint,
    ...(clearToken ? { clearToken: true } : token ? { apiToken: token } : {}),
  });
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const save = target.closest<HTMLElement>('[data-runtime-settings-save]');
  const clear = target.closest<HTMLElement>('[data-runtime-settings-clear-token]');
  const action = save ?? clear;
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  const runtimeId = save?.dataset.runtimeSettingsSave ?? clear?.dataset.runtimeSettingsClearToken;
  const row = action.closest<HTMLElement>('[data-runtime-settings-row]');
  if (!runtimeId || !row) return;
  setRowBusy(row, true);
  void saveRuntimeSettings(row, runtimeId, Boolean(clear))
    .then(() => refreshLocalAi())
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Não foi possível salvar a configuração do runtime.';
      showRowError(row, message);
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: message }));
      setRowBusy(row, false);
    });
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
  const row = event.target.closest<HTMLElement>('[data-runtime-settings-row]');
  const save = row?.querySelector<HTMLButtonElement>('[data-runtime-settings-save]');
  if (!row || !save) return;
  event.preventDefault();
  save.click();
});

const observer = new MutationObserver(() => scheduleRender());
observer.observe(document.body, { childList: true, subtree: true });
scheduleRender();
