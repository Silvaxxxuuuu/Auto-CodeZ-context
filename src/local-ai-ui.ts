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
  installing?: boolean;
  recommended?: boolean;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  capabilities?: string[];
  contextWindow?: number;
  description?: string;
  recommendedFor?: string[];
  compatibility: Compatibility;
};
type ModelRecommendation = {
  runtimeId: string;
  modelId: string;
  compatibility: Compatibility;
  reason: string;
};
type LocalAiSnapshot = {
  hardware: HardwareSnapshot;
  runtimes: RuntimeInfo[];
  installed: ManagedModel[];
  catalog: ManagedModel[];
  recommendation?: ModelRecommendation;
};
type InstallProgress = { status: string; completedBytes?: number; totalBytes?: number; percent?: number; done: boolean };
type InstallEvent = {
  type: 'progress' | 'complete' | 'cancelled' | 'error';
  runtimeId: string;
  modelId: string;
  progress?: InstallProgress;
  error?: string;
};
type LocalModelBridge = {
  snapshot: () => Promise<LocalAiSnapshot>;
  install: (input: { runtimeId: string; modelId: string }) => Promise<{ started: boolean }>;
  cancelInstall: (input: { runtimeId: string; modelId: string }) => Promise<{ cancelled: boolean }>;
  remove: (input: { runtimeId: string; modelId: string }) => Promise<{ removed: boolean }>;
  onInstallEvent: (listener: (event: InstallEvent) => void) => () => void;
};

const localBridge = (window as unknown as { autoCodezLocalAi?: LocalModelBridge }).autoCodezLocalAi;
const installProgress = new Map<string, InstallEvent>();
const pendingRemoval = new Set<string>();
let renderToken = 0;

function installKey(runtimeId: string, modelId: string): string {
  return `${runtimeId}:${modelId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function badge(value: string, tone = '', extra = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}"${extra}>${escapeHtml(value)}</span>`;
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
  if (!runtime.available) return 'O runtime não respondeu. Nenhuma operação é presumida enquanto ele estiver indisponível.';
  const supported = ['inventário'];
  if (runtime.operations.install) supported.push('download');
  if (runtime.operations.cancelInstall) supported.push('cancelamento');
  if (runtime.operations.remove) supported.push('remoção');
  const external: string[] = [];
  if (!runtime.operations.cancelInstall) external.push('cancelamento');
  if (!runtime.operations.remove) external.push('remoção');
  const endpoint = runtime.endpoint ? ` Endpoint: ${runtime.endpoint}.` : '';
  const limitations = external.length ? ` ${external.join(' e ')} permanecem externos a este runtime.` : '';
  return `Operações detectadas: ${supported.join(', ')}.${limitations}${endpoint}`;
}

function installControl(model: ManagedModel, runtime?: RuntimeInfo): string {
  const current = installProgress.get(installKey(model.runtimeId, model.id));
  const runtimeAvailable = runtime?.available === true;
  const installSupported = runtime?.operations.install === true;
  if (model.installed) return badge('Instalado', 'good');
  if (current?.type === 'error') {
    return `${badge('Falhou', 'locked')} ${actionButton('Tentar novamente', 'install', model.runtimeId, model.id, model.compatibility.level === 'blocked' || !runtimeAvailable || !installSupported)}`;
  }
  if (current?.type === 'cancelled') {
    return actionButton('Instalar', 'install', model.runtimeId, model.id, model.compatibility.level === 'blocked' || !runtimeAvailable || !installSupported);
  }
  if (model.installing || current?.type === 'progress') {
    const percent = current?.progress?.percent;
    const progressText = percent === undefined ? current?.progress?.status || 'Instalando…' : `${Math.round(percent)}%`;
    const cancelControl = runtime?.operations.cancelInstall === true
      ? actionButton('Cancelar', 'cancel', model.runtimeId, model.id)
      : badge('Sem cancelamento');
    return `<div class="local-ai-install-control" data-local-ai-progress="${escapeHtml(installKey(model.runtimeId, model.id))}">${badge(progressText)}${cancelControl}</div>`;
  }
  if (model.compatibility.level === 'blocked') return badge('Hardware insuficiente', 'locked');
  if (!installSupported) return badge('Instalação externa');
  return actionButton('Instalar', 'install', model.runtimeId, model.id, !runtimeAvailable);
}

function removalControl(model: ManagedModel, runtime?: RuntimeInfo): string {
  if (runtime?.operations.remove !== true) return badge('Remoção externa');
  const key = installKey(model.runtimeId, model.id);
  if (!pendingRemoval.has(key)) return actionButton('Remover', 'remove', model.runtimeId, model.id);
  return `${badge('Confirmar remoção', 'locked')} ${actionButton('Manter', 'cancel-remove', model.runtimeId, model.id)} ${actionButton('Remover agora', 'confirm-remove', model.runtimeId, model.id)}`;
}

function installDescription(model: ManagedModel, snapshot: LocalAiSnapshot): string {
  const reason = model.compatibility.reasons[0] || 'Compatibilidade calculada localmente.';
  const estimate = model.compatibility.requirements.estimatedRamBytes
    ? ` RAM estimada: ${formatBytes(model.compatibility.requirements.estimatedRamBytes)}.`
    : '';
  const uses = model.recommendedFor?.length ? ` Ideal para ${model.recommendedFor.join(', ')}.` : '';
  const alternative = model.compatibility.level === 'blocked' && snapshot.recommendation
    ? snapshot.catalog.find((candidate) => candidate.runtimeId === snapshot.recommendation?.runtimeId && candidate.id === snapshot.recommendation.modelId)
    : undefined;
  const alternativeText = alternative ? ` Alternativa indicada para este computador: ${alternative.name}.` : '';
  return `${model.description || reason}${uses} ${reason}${estimate}${alternativeText}`.trim();
}

function installLocalAiNavigation(): void {
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const nav = overlay?.querySelector<HTMLElement>('.settings-nav');
  if (!overlay || !nav || nav.querySelector('[data-local-ai-settings]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-nav-item';
  button.dataset.localAiSettings = '';
  button.innerHTML = `<span class="settings-nav-icon">${localAiIcon()}</span><span><strong>IA Local</strong><small>Hardware, modelos e instalação</small></span>`;
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
  return `<section class="settings-card local-ai-hardware-card"><div class="local-ai-card-heading"><div><strong>Seu computador</strong><span>O Auto CodeZ usa estes dados para impedir downloads claramente incompatíveis.</span></div>${badge('Análise local', 'good')}</div>${rows.join('')}</section>`;
}

function renderRuntimes(snapshot: LocalAiSnapshot): string {
  const available = snapshot.runtimes.filter((runtime) => runtime.available).length;
  const rows = snapshot.runtimes.map((runtime) => row(
    runtime.displayName,
    runtimeOperationDescription(runtime),
    badge(runtime.available ? 'Conectado' : 'Não detectado', runtime.available ? 'good' : 'locked'),
    ` data-local-ai-runtime="${escapeHtml(runtime.id)}"`,
  ));
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Runtimes locais</strong><span>Cada runtime expõe somente as operações que o Auto CodeZ confirmou de forma nativa.</span></div>${badge(`${available}/${snapshot.runtimes.length}`, available ? 'good' : 'locked')}</div>${rows.join('')}${row('Atualizar diagnóstico', 'Refaz a leitura de hardware, runtimes e inventário sem reiniciar o aplicativo.', actionButton('Verificar novamente', 'retry'))}</section>`;
}

function renderRecommendation(snapshot: LocalAiSnapshot): string {
  const recommendation = snapshot.recommendation;
  if (!recommendation) {
    return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Recomendação automática</strong><span>Nenhum modelo do catálogo atual cabe com segurança no hardware detectado.</span></div>${badge('Sem opção segura', 'locked')}</div></section>`;
  }
  const model = snapshot.catalog.find((candidate) => candidate.runtimeId === recommendation.runtimeId && candidate.id === recommendation.modelId);
  if (!model) return '';
  const runtime = runtimeFor(snapshot, model.runtimeId);
  const control = model.installed ? badge('Já instalado', 'good') : installControl(model, runtime);
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Recomendado para este computador</strong><span>${escapeHtml(recommendation.reason)}</span></div>${badge(compatibilityLabel(recommendation.compatibility.level), compatibilityTone(recommendation.compatibility.level))}</div>${row(model.name, `${runtime?.displayName || model.runtimeId} · ${model.parameterSize || 'Modelo local'} · ${formatBytes(model.sizeBytes)}${model.capabilities?.includes('tools') ? ' · tools' : ''}${model.capabilities?.includes('reasoning') ? ' · raciocínio' : ''}`, control)}</section>`;
}

function renderInstalled(snapshot: LocalAiSnapshot): string {
  if (!snapshot.installed.length) {
    return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Modelos no computador</strong><span>Nenhum modelo de texto instalado foi encontrado nos runtimes detectados.</span></div>${badge('0')}</div></section>`;
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
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Modelos no computador</strong><span>Inventário agregado por runtime. A origem e as operações disponíveis permanecem explícitas.</span></div>${badge(String(snapshot.installed.length), 'good')}</div>${rows.join('')}</section>`;
}

function renderCatalog(snapshot: LocalAiSnapshot): string {
  const rows = snapshot.catalog.map((model) => {
    const runtime = runtimeFor(snapshot, model.runtimeId);
    return row(
      `${model.name}${model.parameterSize ? ` · ${model.parameterSize}` : ''}`,
      installDescription(model, snapshot),
      `<div class="local-ai-model-actions">${model.recommended ? badge('Recomendado', 'good') : ''}${badge(runtime?.displayName || model.runtimeId)}${badge(formatBytes(model.sizeBytes))}${badge(compatibilityLabel(model.compatibility.level), compatibilityTone(model.compatibility.level))}${installControl(model, runtime)}</div>`,
      ` data-local-ai-model="${escapeHtml(installKey(model.runtimeId, model.id))}"`,
    );
  });
  return `<section class="settings-card"><div class="local-ai-card-heading"><div><strong>Catálogo local</strong><span>Modelos versionados pelo Auto CodeZ, avaliados antes do download e gerenciados somente pelas operações realmente suportadas pelo runtime.</span></div>${badge(String(snapshot.catalog.length))}</div>${rows.join('')}</section>`;
}

async function renderLocalAi(): Promise<void> {
  const token = ++renderToken;
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const body = overlay?.querySelector<HTMLElement>('.settings-body');
  const localButton = overlay?.querySelector<HTMLElement>('[data-local-ai-settings]');
  if (!overlay || !body || !localButton?.classList.contains('active')) return;

  body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Escolha modelos que rodam no seu computador, com análise de hardware antes da instalação.</p></header><section class="settings-card"><div class="settings-loading">Analisando hardware e runtimes…</div></section>';

  try {
    if (!localBridge?.snapshot) throw new Error('Infraestrutura de IA local indisponível.');
    const snapshot = await localBridge.snapshot();
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Modelos locais com compatibilidade calculada antes do download e capacidades declaradas por runtime.</p></header>'
      + renderHardware(snapshot)
      + renderRuntimes(snapshot)
      + renderRecommendation(snapshot)
      + renderInstalled(snapshot)
      + renderCatalog(snapshot)
      + '<div class="settings-footnote">Bloqueios usam RAM e armazenamento detectados localmente. GPU/VRAM só entram no cálculo quando puderem ser identificadas com confiança. O Auto CodeZ não inventa VRAM ausente nem operações ausentes do runtime.</div>';
  } catch (error) {
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    const message = error instanceof Error ? error.message : 'A IA Local não respondeu.';
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Escolha modelos que rodam no seu computador, com análise de hardware antes da instalação.</p></header>'
      + `<section class="settings-card">${row('Diagnóstico local', message, badge('Indisponível', 'locked'))}${row('Tentar novamente', 'Repete a inicialização do gerenciador local.', actionButton('Verificar novamente', 'retry'))}</section>`;
  }
}

function updateProgressInPlace(event: InstallEvent): void {
  const key = installKey(event.runtimeId, event.modelId);
  const host = document.querySelector<HTMLElement>(`[data-local-ai-model="${CSS.escape(key)}"]`);
  if (!host) return;
  const control = host.querySelector<HTMLElement>('[data-local-ai-progress]');
  if (!control || event.type !== 'progress') return;
  const badgeElement = control.querySelector<HTMLElement>('.settings-value-badge');
  if (badgeElement) badgeElement.textContent = event.progress?.percent === undefined ? event.progress?.status || 'Instalando…' : `${Math.round(event.progress.percent)}%`;
}

localBridge?.onInstallEvent((event) => {
  installProgress.set(installKey(event.runtimeId, event.modelId), event);
  if (event.type === 'progress') {
    updateProgressInPlace(event);
    return;
  }
  if (document.querySelector('[data-local-ai-settings].active')) void renderLocalAi();
});

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
  if (action === 'confirm-remove') {
    actionTarget.setAttribute('disabled', '');
    void localBridge.remove({ runtimeId, modelId })
      .then(() => {
        pendingRemoval.delete(key);
        installProgress.delete(key);
        return renderLocalAi();
      })
      .catch((error) => {
        pendingRemoval.delete(key);
        window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível remover o modelo.' }));
        void renderLocalAi();
      });
    return;
  }
  if (action !== 'install' && action !== 'cancel') return;

  actionTarget.setAttribute('disabled', '');
  if (action === 'install') {
    installProgress.set(key, { type: 'progress', runtimeId, modelId, progress: { status: 'Iniciando…', done: false } });
    void localBridge.install({ runtimeId, modelId })
      .then(() => renderLocalAi())
      .catch((error) => {
        installProgress.set(key, { type: 'error', runtimeId, modelId, error: error instanceof Error ? error.message : String(error) });
        window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível instalar o modelo.' }));
        void renderLocalAi();
      });
    return;
  }
  void localBridge.cancelInstall({ runtimeId, modelId })
    .then(() => renderLocalAi())
    .catch((error) => {
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível cancelar a instalação.' }));
      void renderLocalAi();
    });
}, true);

const observer = new MutationObserver(() => installLocalAiNavigation());
observer.observe(document.body, { childList: true, subtree: true });
installLocalAiNavigation();