type CompatibilityLevel = 'excellent' | 'compatible' | 'limit' | 'blocked';
type Compatibility = { level: CompatibilityLevel; reasons: string[]; requirements: { estimatedRamBytes?: number; minimumFreeDiskBytes?: number } };
type HardwareSnapshot = {
  totalRamBytes: number;
  availableRamBytes: number;
  freeDiskBytes?: number;
  totalVramBytes?: number;
  availableVramBytes?: number;
  architecture?: string;
  cpuModel?: string;
  gpuName?: string;
};
type RuntimeOperations = { install: boolean; cancelInstall: boolean; remove: boolean };
type RuntimeInfo = { id: string; displayName: string; available: boolean; endpoint?: string; operations: RuntimeOperations };
type ManagedModel = {
  id: string;
  name: string;
  runtimeId: string;
  installed: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  compatibility: Compatibility;
};
type LocalAiSnapshot = {
  hardware: HardwareSnapshot;
  runtimes: RuntimeInfo[];
  installed: ManagedModel[];
  catalog: ManagedModel[];
};
type LocalModelBridge = {
  snapshot: () => Promise<LocalAiSnapshot>;
  remove: (input: { runtimeId: string; modelId: string }) => Promise<{ removed: boolean }>;
};

const localBridge = (window as unknown as { autoCodezLocalAi?: LocalModelBridge }).autoCodezLocalAi;
const pendingRemoval = new Set<string>();
let renderToken = 0;

function installKey(runtimeId: string, modelId: string): string {
  return `${runtimeId}:${modelId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function badge(value: string, tone = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}">${escapeHtml(value)}</span>`;
}

function row(label: string, description: string, control: string, extra = ''): string {
  return `<div class="settings-row"${extra}><div class="settings-row-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span></div><div class="settings-row-value">${control}</div></div>`;
}

function actionButton(label: string, action: string, runtimeId?: string, modelId?: string, disabled = false): string {
  const data = `${runtimeId ? ` data-runtime-id="${escapeHtml(runtimeId)}"` : ''}${modelId ? ` data-model-id="${escapeHtml(modelId)}"` : ''}`;
  return `<button class="settings-action-button" type="button" data-local-ai-action="${escapeHtml(action)}"${data}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

function localAiIcon(): string {
  return '<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M12 2v3M15 2v3M9 19v3M12 19v3M15 19v3M2 9h3M2 12h3M2 15h3M19 9h3M19 12h3M19 15h3"/><circle cx="12" cy="12" r="2"/></svg>';
}

function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 'Não detectado';
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${gib >= 10 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
  return `${Math.round(value / 1024 ** 2)} MB`;
}

function compatibilityLabel(level: CompatibilityLevel): string {
  if (level === 'excellent') return 'Excelente';
  if (level === 'compatible') return 'Compatível';
  if (level === 'limit') return 'No limite';
  return 'Bloqueado';
}

function compatibilityTone(level: CompatibilityLevel): string {
  if (level === 'excellent' || level === 'compatible') return 'good';
  if (level === 'blocked') return 'locked';
  return '';
}

function runtimeFor(snapshot: LocalAiSnapshot, runtimeId: string): RuntimeInfo | undefined {
  return snapshot.runtimes.find((runtime) => runtime.id === runtimeId);
}

function runtimeOperationDescription(runtime: RuntimeInfo): string {
  if (!runtime.available) return 'O runtime não respondeu. Inicie-o antes de selecionar modelos locais no chat.';
  const supported = ['inventário'];
  if (runtime.operations.install) supported.push('download pelo chat');
  if (runtime.operations.cancelInstall) supported.push('cancelamento');
  if (runtime.operations.remove) supported.push('remoção');
  const endpoint = runtime.endpoint ? ` Endpoint: ${runtime.endpoint}.` : '';
  return `Operações confirmadas: ${supported.join(', ')}.${endpoint}`;
}

function removalControl(model: ManagedModel, runtime?: RuntimeInfo): string {
  if (runtime?.operations.remove !== true) return badge('Remoção externa');
  const key = installKey(model.runtimeId, model.id);
  if (!pendingRemoval.has(key)) return actionButton('Remover', 'remove', model.runtimeId, model.id);
  return `${badge('Confirmar remoção', 'locked')} ${actionButton('Manter', 'cancel-remove', model.runtimeId, model.id)} ${actionButton('Remover agora', 'confirm-remove', model.runtimeId, model.id)}`;
}

function installLocalAiNavigation(): void {
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const nav = overlay?.querySelector<HTMLElement>('.settings-nav');
  if (!overlay || !nav || nav.querySelector('[data-local-ai-settings]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-nav-item';
  button.dataset.localAiSettings = '';
  button.innerHTML = `<span class="settings-nav-icon">${localAiIcon()}</span><span><strong>IA Local</strong><small>Diagnóstico e runtimes</small></span>`;
  const aiButton = nav.querySelector<HTMLElement>('[data-settings-section="ai"]');
  if (aiButton) aiButton.insertAdjacentElement('afterend', button);
  else nav.appendChild(button);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    nav.querySelectorAll('.settings-nav-item').forEach((item) => item.classList.toggle('active', item === button));
    void renderLocalAi();
  });
}

function renderHardware(snapshot: LocalAiSnapshot): string {
  const hardware = snapshot.hardware;
  const rows = [
    row('Memória RAM', `${formatBytes(hardware.availableRamBytes)} disponíveis de ${formatBytes(hardware.totalRamBytes)}.`, badge(formatBytes(hardware.totalRamBytes))),
    row('Armazenamento livre', 'Espaço disponível no volume usado pelos modelos locais.', badge(formatBytes(hardware.freeDiskBytes), hardware.freeDiskBytes === undefined ? 'locked' : 'good')),
    row('Processador', hardware.cpuModel || 'Modelo do processador não informado pelo sistema.', badge(hardware.architecture || 'Desconhecido')),
  ];
  if (hardware.gpuName || hardware.totalVramBytes !== undefined) {
    rows.push(row('GPU', hardware.gpuName || 'GPU detectada.', badge(hardware.totalVramBytes === undefined ? 'VRAM não detectada' : `${formatBytes(hardware.totalVramBytes)} VRAM`)));
  }
  return `<section class="settings-card local-ai-hardware-card"><div class="local-ai-card-heading"><div><strong>Seu computador</strong><span>Este diagnóstico alimenta as recomendações e bloqueios mostrados diretamente nas configurações de cada chat.</span></div>${badge('Análise local', 'good')}</div>${rows.join('')}</section>`;
}

function renderRuntimes(snapshot: LocalAiSnapshot): string {
  const available = snapshot.runtimes.filter((runtime) => runtime.available).length;
  const rows = snapshot.runtimes.map((runtime) => row(
    runtime.displayName,
    runtimeOperationDescription(runtime),
    badge(runtime.available ? 'Conectado' : 'Não detectado', runtime.available ? 'good' : 'locked'),
    ` data-local-ai-runtime="${escapeHtml(runtime.id)}"`,
  ));
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Runtimes locais</strong><span>Diagnóstico de conexão e capacidades. A escolha e instalação de modelos acontece no chat.</span></div>${badge(`${available}/${snapshot.runtimes.length}`, available ? 'good' : 'locked')}</div>${rows.join('')}${row('Atualizar diagnóstico', 'Refaz a leitura de hardware, runtimes e inventário sem reiniciar o aplicativo.', actionButton('Verificar novamente', 'retry'))}</section>`;
}

function renderInstalled(snapshot: LocalAiSnapshot): string {
  if (!snapshot.installed.length) {
    return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Modelos no computador</strong><span>Nenhum modelo de texto instalado foi encontrado. Escolha Ollama ou LM Studio nas configurações de um chat para ver modelos e recomendações.</span></div>${badge('0')}</div></section>`;
  }
  const rows = snapshot.installed.map((model) => {
    const runtime = runtimeFor(snapshot, model.runtimeId);
    const source = runtime?.displayName || model.runtimeId;
    return row(
      model.name || model.id,
      `${source} · ${model.parameterSize || 'Tamanho de parâmetros não informado'}${model.quantization ? ` · ${model.quantization}` : ''}${model.sizeBytes ? ` · ${formatBytes(model.sizeBytes)}` : ''}`,
      `<div class="local-ai-model-actions">${badge(source)}${badge(compatibilityLabel(model.compatibility.level), compatibilityTone(model.compatibility.level))}${badge('Pronto', 'good')}${removalControl(model, runtime)}</div>`,
      ` data-local-ai-installed-model="${escapeHtml(installKey(model.runtimeId, model.id))}"`,
    );
  });
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Modelos no computador</strong><span>Inventário e remoção avançada. Instalação e compatibilidade de novos modelos ficam no fluxo do chat.</span></div>${badge(String(snapshot.installed.length), 'good')}</div>${rows.join('')}</section>`;
}

function renderChatFlowHint(snapshot: LocalAiSnapshot): string {
  const safeModels = snapshot.catalog.filter((model) => model.compatibility.level === 'excellent' || model.compatibility.level === 'compatible').length;
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Escolher um modelo local</strong><span>Abra as configurações de um chat, selecione Ollama ou LM Studio e escolha o modelo. O Auto CodeZ mostra recomendação, compatibilidade, avisos e instalação antes de liberar Salvar.</span></div>${badge(`${safeModels} opção${safeModels === 1 ? '' : 'ões'} segura${safeModels === 1 ? '' : 's'}`, safeModels ? 'good' : 'locked')}</div></section>`;
}

async function renderLocalAi(): Promise<void> {
  const token = ++renderToken;
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const body = overlay?.querySelector<HTMLElement>('.settings-body');
  const localButton = overlay?.querySelector<HTMLElement>('[data-local-ai-settings]');
  if (!overlay || !body || !localButton?.classList.contains('active')) return;

  body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Diagnóstico do computador e dos runtimes locais.</p></header><section class="settings-card"><div class="settings-loading">Analisando hardware e runtimes…</div></section>';
  try {
    if (!localBridge?.snapshot) throw new Error('Infraestrutura de IA local indisponível.');
    const snapshot = await localBridge.snapshot();
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Diagnóstico, runtimes e modelos já presentes no computador. A seleção e instalação de novos modelos acontece no chat.</p></header>'
      + renderChatFlowHint(snapshot)
      + renderHardware(snapshot)
      + renderRuntimes(snapshot)
      + renderInstalled(snapshot)
      + '<div class="settings-footnote">Os bloqueios de hardware são calculados localmente. GPU/VRAM só entram no cálculo quando puderem ser detectadas com confiança.</div>';
  } catch (error) {
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    const message = error instanceof Error ? error.message : 'A IA Local não respondeu.';
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Diagnóstico do computador e dos runtimes locais.</p></header>'
      + `<section class="settings-card">${row('Diagnóstico local', message, badge('Indisponível', 'locked'))}${row('Tentar novamente', 'Repete a inicialização do gerenciador local.', actionButton('Verificar novamente', 'retry'))}</section>`;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-settings-section]')) {
    document.querySelector<HTMLElement>('[data-local-ai-settings]')?.classList.remove('active');
    return;
  }
  const actionTarget = target.closest<HTMLElement>('[data-local-ai-action]');
  const action = actionTarget?.dataset.localAiAction;
  if (action === 'retry') {
    void renderLocalAi();
    return;
  }
  if (!actionTarget || !localBridge) return;
  const runtimeId = actionTarget.dataset.runtimeId;
  const modelId = actionTarget.dataset.modelId;
  if (!runtimeId || !modelId) return;
  const key = installKey(runtimeId, modelId);
  if (action === 'remove') {
    pendingRemoval.add(key);
    void renderLocalAi();
    return;
  }
  if (action === 'cancel-remove') {
    pendingRemoval.delete(key);
    void renderLocalAi();
    return;
  }
  if (action !== 'confirm-remove') return;
  actionTarget.setAttribute('disabled', '');
  void localBridge.remove({ runtimeId, modelId })
    .then(() => {
      pendingRemoval.delete(key);
      return renderLocalAi();
    })
    .catch((error) => {
      pendingRemoval.delete(key);
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível remover o modelo.' }));
      void renderLocalAi();
    });
}, true);

const observer = new MutationObserver(() => installLocalAiNavigation());
observer.observe(document.body, { childList: true, subtree: true });
installLocalAiNavigation();
