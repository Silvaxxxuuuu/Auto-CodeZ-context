import { PluginSandboxManager } from './plugins/plugin-sandbox-ui';

type PluginHealth = { pluginId: string; state: 'inactive' | 'starting' | 'healthy' | 'degraded' | 'failed'; message?: string; updatedAt: number };
type PluginSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  homepage?: string;
  state: 'registered' | 'enabled' | 'disabled' | 'failed';
  contributions: string[];
  requestedPermissions: string[];
  grantedPermissions: string[];
  missingPermissions: string[];
  hasMain: boolean;
  health: PluginHealth;
  failureReason?: string;
};
type PluginSnapshot = { plugins: PluginSummary[]; failures: Array<{ directory: string; reason: string }> };
type PluginActivity = { pluginId: string; message: string; status: string; updatedAt: number };
type PluginJob = { id: string; pluginId: string; label: string; state: string; progress?: number; activity?: string; error?: string; updatedAt: number };
type SandboxCall = { id: string; pluginId: string; method: string; input?: unknown };

type PluginBridge = {
  snapshot(): Promise<PluginSnapshot>;
  refresh(): Promise<PluginSnapshot>;
  installFromFolder(): Promise<PluginSnapshot | null>;
  uninstall(pluginId: string): Promise<PluginSnapshot>;
  grant(pluginId: string, permissions: string[]): Promise<PluginSummary>;
  enable(pluginId: string): Promise<PluginSummary>;
  disable(pluginId: string): Promise<PluginSummary>;
  revoke(pluginId: string, permission: string): Promise<PluginSummary>;
  source(pluginId: string): Promise<string>;
  invoke(pluginId: string, request: { id: string; method: string; input?: unknown }): Promise<{ id: string; ok: boolean; value?: unknown; error?: string }>;
  markHealthy(pluginId: string, message?: string): Promise<PluginSummary>;
  markFailed(pluginId: string, reason: string): Promise<PluginSummary>;
  respondSandboxCall(result: { id: string; value?: unknown; error?: string }): Promise<boolean>;
  onSandboxCall(listener: (call: SandboxCall) => void): () => void;
  onActivity(listener: (activity: PluginActivity) => void): () => void;
  onJob(listener: (job: PluginJob) => void): () => void;
};

declare global {
  interface Window { autoCodezPlugins?: PluginBridge; }
}

const permissionLabels: Record<string, string> = {
  'workspace:read': 'Ler workspace',
  'workspace:write': 'Alterar workspace',
  'terminal:execute': 'Executar terminal',
  'git:read': 'Ler Git',
  'git:write': 'Alterar Git',
  'network:fetch': 'Acessar Internet pública',
  'network:localhost': 'Conectar a apps locais',
  'secrets:use': 'Usar credenciais autorizadas',
  'background:run': 'Executar jobs em segundo plano',
  'ai:provider': 'Adicionar provider de IA',
  'ai:tool': 'Adicionar tools para a IA',
  'ui:contribute': 'Adicionar interface',
};

const stateLabels: Record<string, string> = {
  registered: 'Aguardando configuração',
  enabled: 'Ativo',
  disabled: 'Desativado',
  failed: 'Falhou',
};

const bridge = window.autoCodezPlugins;
const sandboxes = bridge ? new PluginSandboxManager(bridge) : undefined;
let snapshot: PluginSnapshot = { plugins: [], failures: [] };
let loading = false;
let rendering = false;
const activeSandboxIds = new Set<string>();
const activities = new Map<string, PluginActivity>();
const jobs = new Map<string, PluginJob>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function isPluginPanel(): boolean {
  const panel = document.querySelector<HTMLElement>('#nav-panel');
  return Boolean(panel && panel.querySelector('.panel-title')?.textContent?.trim() === 'Plugins');
}

function replacePluginSummary(updated: PluginSummary): void {
  snapshot = {
    ...snapshot,
    plugins: snapshot.plugins.map((plugin) => plugin.id === updated.id ? updated : plugin),
  };
}

function currentWork(pluginId: string): string | undefined {
  const activeJobs = [...jobs.values()].filter((job) => job.pluginId === pluginId && (job.state === 'queued' || job.state === 'running'));
  activeJobs.sort((a, b) => b.updatedAt - a.updatedAt);
  const job = activeJobs[0];
  if (job) {
    const percent = typeof job.progress === 'number' ? ` · ${Math.round(job.progress * 100)}%` : '';
    return `${job.activity || job.label}${percent}`;
  }
  return activities.get(pluginId)?.message;
}

function pluginCard(plugin: PluginSummary): string {
  const work = currentWork(plugin.id);
  const status = plugin.state === 'enabled' ? plugin.health.state : plugin.state;
  const missing = plugin.missingPermissions.length;
  const action = plugin.state === 'enabled'
    ? `<button class="plugin-platform-button secondary" data-plugin-disable="${escapeHtml(plugin.id)}">Desativar</button>`
    : missing
      ? `<button class="plugin-platform-button" data-plugin-permissions="${escapeHtml(plugin.id)}">Revisar permissões</button>`
      : `<button class="plugin-platform-button" data-plugin-enable="${escapeHtml(plugin.id)}">Ativar</button>`;
  return `<article class="plugin-platform-item" data-plugin-id="${escapeHtml(plugin.id)}">
    <div class="plugin-platform-item-head"><div><strong>${escapeHtml(plugin.name)}</strong><span>${escapeHtml(plugin.version)}${plugin.publisher ? ` · ${escapeHtml(plugin.publisher)}` : ''}</span></div><span class="plugin-platform-status ${escapeHtml(status)}">${escapeHtml(stateLabels[plugin.state] || status)}</span></div>
    ${plugin.description ? `<p>${escapeHtml(plugin.description)}</p>` : ''}
    ${plugin.failureReason ? `<div class="plugin-platform-error">${escapeHtml(plugin.failureReason)}</div>` : ''}
    ${work ? `<div class="plugin-platform-activity"><span></span>${escapeHtml(work)}</div>` : ''}
    <div class="plugin-platform-meta">${plugin.contributions.length ? escapeHtml(plugin.contributions.join(' · ')) : 'Sem contribuições de UI'}${plugin.requestedPermissions.length ? ` · ${plugin.grantedPermissions.length}/${plugin.requestedPermissions.length} permissões` : ' · sem permissões externas'}</div>
    <div class="plugin-platform-actions">${action}<button class="plugin-platform-button ghost" data-plugin-permissions="${escapeHtml(plugin.id)}">Permissões</button><button class="plugin-platform-button danger" data-plugin-uninstall="${escapeHtml(plugin.id)}">Remover</button></div>
  </article>`;
}

function render(): void {
  if (!isPluginPanel()) return;
  const panel = document.querySelector<HTMLElement>('#nav-panel');
  if (!panel) return;
  rendering = true;
  panel.innerHTML = `<div class="panel-title plugin-platform-title"><span>Plugins</span><button class="plugin-platform-icon-button" data-plugin-refresh title="Atualizar plugins" aria-label="Atualizar plugins">↻</button></div>
    <button class="new-item plugin-platform-install" data-plugin-install><span class="new-item-icon plugin-extension-icon" aria-hidden="true"></span><span>Instalar da pasta</span></button>
    <div class="plugin-platform-summary"><strong>Plugin Platform v1</strong><span>${snapshot.plugins.length} instalado${snapshot.plugins.length === 1 ? '' : 's'} · sandbox + capabilities</span></div>
    ${loading ? '<div class="empty-panel">Atualizando plugins…</div>' : snapshot.plugins.map(pluginCard).join('') || '<div class="empty-panel">Nenhum plugin instalado.<br>Instale um pacote local com plugin.json para começar.</div>'}
    ${snapshot.failures.length ? `<div class="plugin-platform-failures"><strong>${snapshot.failures.length} pacote(s) ignorado(s)</strong>${snapshot.failures.slice(0, 4).map((failure) => `<span>${escapeHtml(failure.directory)}: ${escapeHtml(failure.reason)}</span>`).join('')}</div>` : ''}`;
  panel.dataset.pluginPlatformRendered = 'true';
  rendering = false;
}

function showPermissionModal(plugin: PluginSummary): void {
  const root = document.querySelector<HTMLElement>('#modal-root');
  if (!root) return;
  const granted = new Set(plugin.grantedPermissions);
  root.innerHTML = `<div class="modal-backdrop"><section class="modal plugin-permission-modal" role="dialog" aria-modal="true" aria-label="Permissões de ${escapeHtml(plugin.name)}">
    <div class="modal-kicker">PLUGIN</div><button class="modal-close" data-plugin-modal-close aria-label="Fechar"></button>
    <h2>${escapeHtml(plugin.name)}</h2><p>O plugin só recebe capabilities marcadas aqui. Alterar grants pode desativá-lo imediatamente.</p>
    <div class="plugin-permission-list">${plugin.requestedPermissions.map((permission) => `<label><input type="checkbox" data-plugin-permission-value="${escapeHtml(permission)}" ${granted.has(permission) ? 'checked' : ''}><span><strong>${escapeHtml(permissionLabels[permission] || permission)}</strong><small>${escapeHtml(permission)}</small></span></label>`).join('') || '<div class="empty-panel">Este plugin não solicita permissões externas.</div>'}</div>
    <div class="plugin-permission-footer"><button class="plugin-platform-button secondary" data-plugin-modal-close>Cancelar</button><button class="plugin-platform-button" data-plugin-save-permissions="${escapeHtml(plugin.id)}">Salvar permissões</button></div>
  </section></div>`;
}

async function syncSandboxes(refreshSnapshot = true): Promise<void> {
  if (!bridge || !sandboxes) return;
  const desired = new Set(snapshot.plugins.filter((plugin) => plugin.state === 'enabled' && plugin.hasMain).map((plugin) => plugin.id));
  for (const pluginId of [...activeSandboxIds]) {
    if (!desired.has(pluginId)) {
      await sandboxes.deactivate(pluginId);
      activeSandboxIds.delete(pluginId);
    }
  }
  for (const plugin of snapshot.plugins) {
    if (plugin.state !== 'enabled') continue;
    if (!plugin.hasMain) {
      if (plugin.health.state !== 'healthy') {
        const updated = await bridge.markHealthy(plugin.id, 'Plugin declarativo ativo.').catch((): undefined => undefined);
        if (updated) replacePluginSummary(updated);
      }
      continue;
    }
    if (activeSandboxIds.has(plugin.id)) continue;
    try {
      const source = await bridge.source(plugin.id);
      await sandboxes.activate(plugin.id, source);
      activeSandboxIds.add(plugin.id);
    } catch (error) {
      const updated = await bridge.markFailed(plugin.id, error instanceof Error ? error.message : String(error)).catch((): undefined => undefined);
      if (updated) replacePluginSummary(updated);
    }
  }
  if (refreshSnapshot) snapshot = await bridge.snapshot();
  render();
}

async function refresh(useRescan = false): Promise<void> {
  if (!bridge || loading) return;
  loading = true;
  render();
  try {
    snapshot = useRescan ? await bridge.refresh() : await bridge.snapshot();
    await syncSandboxes();
  } finally {
    loading = false;
    render();
  }
}

async function act(action: () => Promise<unknown>): Promise<void> {
  if (!bridge || loading) return;
  loading = true;
  render();
  try {
    await action();
    snapshot = await bridge.snapshot();
    await syncSandboxes();
  } catch (error) {
    console.error('Falha na operação de plugin.', error);
  } finally {
    loading = false;
    render();
  }
}

async function savePermissions(pluginId: string, selected: string[]): Promise<void> {
  if (!bridge || loading) return;
  loading = true;
  render();
  try {
    const updated = await bridge.grant(pluginId, selected);
    replacePluginSummary(updated);
    const root = document.querySelector<HTMLElement>('#modal-root');
    if (root) root.innerHTML = '';
    await syncSandboxes(false);
  } catch (error) {
    console.error('Falha ao salvar permissões do plugin.', error);
  } finally {
    loading = false;
    render();
  }
}

async function handleSandboxCall(call: SandboxCall): Promise<void> {
  if (!bridge || !sandboxes || !call?.id || !call.pluginId || !call.method) return;
  try {
    if (!sandboxes.has(call.pluginId)) throw new Error(`Plugin '${call.pluginId}' não está ativo no sandbox.`);
    const value = await sandboxes.call(call.pluginId, call.method, call.input);
    await bridge.respondSandboxCall({ id: call.id, value });
  } catch (error) {
    await bridge.respondSandboxCall({ id: call.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }).catch((): undefined => undefined);
  }
}

function installStyles(): void {
  if (document.querySelector('#plugin-platform-styles')) return;
  const style = document.createElement('style');
  style.id = 'plugin-platform-styles';
  style.textContent = `
    .plugin-platform-title{display:flex;align-items:center;justify-content:space-between}.plugin-platform-icon-button{border:0;background:transparent;color:#768398;font-size:18px;cursor:pointer}.plugin-platform-summary{margin:8px 12px 12px;padding:12px;border:1px solid #26303c;border-radius:10px;background:#10161e;display:flex;flex-direction:column;gap:3px}.plugin-platform-summary strong{font-size:12px}.plugin-platform-summary span,.plugin-platform-item-head span,.plugin-platform-meta{font-size:10px;color:#758195}.plugin-platform-item{margin:8px 10px;padding:12px;border:1px solid #27313d;border-radius:10px;background:#0e141b;display:flex;flex-direction:column;gap:9px}.plugin-platform-item-head{display:flex;justify-content:space-between;gap:8px}.plugin-platform-item-head>div{display:flex;min-width:0;flex-direction:column;gap:2px}.plugin-platform-item-head strong{font-size:12px}.plugin-platform-item p{margin:0;color:#9da7b5;font-size:11px;line-height:1.45}.plugin-platform-status{font-size:9px!important;text-transform:uppercase;letter-spacing:.08em}.plugin-platform-status.healthy,.plugin-platform-status.enabled{color:#72d69b}.plugin-platform-status.failed{color:#f08c8c}.plugin-platform-status.starting{color:#e1bd72}.plugin-platform-activity{display:flex;align-items:center;gap:7px;color:#b9c7dc;font-size:10px}.plugin-platform-activity span{width:6px;height:6px;border-radius:50%;background:#7396d8;box-shadow:0 0 0 3px #7396d820}.plugin-platform-actions{display:flex;gap:5px;flex-wrap:wrap}.plugin-platform-button{border:1px solid #43699d;background:#234b79;color:#e7eef8;border-radius:6px;padding:6px 8px;font-size:10px;cursor:pointer}.plugin-platform-button.secondary{background:#171e27;border-color:#354252}.plugin-platform-button.ghost{background:transparent;border-color:#303b49;color:#9aa7b7}.plugin-platform-button.danger{margin-left:auto;background:transparent;border-color:#543036;color:#cb8188}.plugin-platform-error,.plugin-platform-failures{color:#e8a0a5;font-size:10px}.plugin-platform-failures{margin:10px 12px;display:flex;flex-direction:column;gap:4px}.plugin-permission-modal{max-width:560px}.plugin-permission-list{display:flex;flex-direction:column;gap:7px;margin:18px 0;max-height:340px;overflow:auto}.plugin-permission-list label{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid #2a3440;border-radius:8px}.plugin-permission-list label span{display:flex;flex-direction:column;gap:2px}.plugin-permission-list small{color:#758195}.plugin-permission-footer{display:flex;justify-content:flex-end;gap:8px}
  `;
  document.head.appendChild(style);
}

installStyles();

if (bridge) {
  bridge.onActivity((activity) => { activities.set(activity.pluginId, activity); render(); });
  bridge.onJob((job) => { jobs.set(job.id, job); render(); });
  bridge.onSandboxCall((call) => { void handleSandboxCall(call); });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-plugin-install],[data-plugin-refresh],[data-plugin-enable],[data-plugin-disable],[data-plugin-permissions],[data-plugin-uninstall],[data-plugin-modal-close],[data-plugin-save-permissions]');
    if (!button) return;
    if (button.hasAttribute('data-plugin-modal-close')) {
      const root = document.querySelector<HTMLElement>('#modal-root');
      if (root) root.innerHTML = '';
      return;
    }
    if (button.hasAttribute('data-plugin-install')) {
      void act(async () => { await bridge.installFromFolder(); });
      return;
    }
    if (button.hasAttribute('data-plugin-refresh')) { void refresh(true); return; }
    const pluginId = button.getAttribute('data-plugin-enable') || button.getAttribute('data-plugin-disable') || button.getAttribute('data-plugin-permissions') || button.getAttribute('data-plugin-uninstall') || button.getAttribute('data-plugin-save-permissions');
    if (!pluginId) return;
    const plugin = snapshot.plugins.find((item) => item.id === pluginId);
    if (!plugin) return;
    if (button.hasAttribute('data-plugin-permissions')) { showPermissionModal(plugin); return; }
    if (button.hasAttribute('data-plugin-enable')) { void act(() => bridge.enable(pluginId)); return; }
    if (button.hasAttribute('data-plugin-disable')) { void act(async () => { await sandboxes?.deactivate(pluginId); activeSandboxIds.delete(pluginId); await bridge.disable(pluginId); }); return; }
    if (button.hasAttribute('data-plugin-uninstall')) {
      if (!window.confirm(`Remover o plugin ${plugin.name}?`)) return;
      void act(async () => { await sandboxes?.deactivate(pluginId); activeSandboxIds.delete(pluginId); await bridge.uninstall(pluginId); });
      return;
    }
    if (button.hasAttribute('data-plugin-save-permissions')) {
      const selected = [...document.querySelectorAll<HTMLInputElement>('[data-plugin-permission-value]:checked')]
        .map((input) => input.getAttribute('data-plugin-permission-value')!)
        .filter(Boolean);
      void savePermissions(pluginId, selected);
    }
  });

  const observer = new MutationObserver(() => {
    if (rendering || !isPluginPanel()) return;
    const panel = document.querySelector<HTMLElement>('#nav-panel');
    if (panel?.dataset.pluginPlatformRendered === 'true') return;
    render();
  });
  const panel = document.querySelector<HTMLElement>('#nav-panel');
  if (panel) observer.observe(panel, { childList: true, subtree: true });
  void refresh();
}
