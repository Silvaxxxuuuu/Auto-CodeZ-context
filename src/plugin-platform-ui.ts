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

declare global { interface Window { autoCodezPlugins?: PluginBridge; } }

const permissionLabels: Record<string, string> = {
  'workspace:read': 'Ler workspace', 'workspace:write': 'Alterar workspace', 'terminal:execute': 'Executar terminal',
  'git:read': 'Ler Git', 'git:write': 'Alterar Git', 'network:fetch': 'Acessar Internet pública',
  'network:localhost': 'Conectar a apps locais', 'secrets:use': 'Usar credenciais autorizadas',
  'background:run': 'Executar jobs em segundo plano', 'ai:provider': 'Adicionar provider de IA',
  'ai:tool': 'Adicionar tools para a IA', 'ui:contribute': 'Adicionar interface',
};
const stateLabels: Record<string, string> = { registered: 'Configuração necessária', enabled: 'Ativo', disabled: 'Desativado', failed: 'Falhou' };
const bridge = window.autoCodezPlugins;
const sandboxes = bridge ? new PluginSandboxManager(bridge) : undefined;
let snapshot: PluginSnapshot = { plugins: [], failures: [] };
let loading = false;
let rendering = false;
let selectedPluginId: string | null = null;
const activeSandboxIds = new Set<string>();
const activities = new Map<string, PluginActivity>();
const jobs = new Map<string, PluginJob>();

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
function isPluginPanel(): boolean { const panel = document.querySelector<HTMLElement>('#nav-panel'); return Boolean(panel && panel.querySelector('.panel-title')?.textContent?.includes('Plugins')); }
function replacePluginSummary(updated: PluginSummary): void { snapshot = { ...snapshot, plugins: snapshot.plugins.map((plugin) => plugin.id === updated.id ? updated : plugin) }; }
function currentWork(pluginId: string): string | undefined {
  const activeJobs = [...jobs.values()].filter((job) => job.pluginId === pluginId && (job.state === 'queued' || job.state === 'running')).sort((a, b) => b.updatedAt - a.updatedAt);
  const job = activeJobs[0];
  if (job) return `${job.activity || job.label}${typeof job.progress === 'number' ? ` · ${Math.round(job.progress * 100)}%` : ''}`;
  return activities.get(pluginId)?.message;
}
function compactPlugin(plugin: PluginSummary): string {
  const status = plugin.state === 'enabled' ? plugin.health.state : plugin.state;
  return `<button class="plugin-list-item" type="button" data-plugin-open="${escapeHtml(plugin.id)}" data-plugin-id="${escapeHtml(plugin.id)}"><span class="plugin-list-icon" aria-hidden="true"></span><span class="plugin-list-copy"><strong>${escapeHtml(plugin.name)}</strong><span>${escapeHtml(plugin.description || 'Plugin do Auto CodeZ')}</span></span><span class="plugin-list-state ${escapeHtml(status)}" title="${escapeHtml(stateLabels[plugin.state] || status)}"></span></button>`;
}
function detailView(plugin: PluginSummary): string {
  const status = plugin.state === 'enabled' ? plugin.health.state : plugin.state;
  const work = currentWork(plugin.id);
  const canEnable = plugin.missingPermissions.length === 0 && plugin.state !== 'enabled';
  return `<div data-plugin-platform-owned><div class="panel-title plugin-platform-title"><button class="plugin-back" type="button" data-plugin-back aria-label="Voltar para plugins">‹</button><span>Plugins</span></div><section class="plugin-detail" data-plugin-detail="${escapeHtml(plugin.id)}"><div class="plugin-detail-heading"><div class="plugin-detail-icon" aria-hidden="true"></div><div class="plugin-detail-title"><h2>${escapeHtml(plugin.name)}</h2><span>${escapeHtml(plugin.publisher || 'Plugin local')} · v${escapeHtml(plugin.version)}</span></div></div><p class="plugin-detail-description">${escapeHtml(plugin.description || 'Plugin do Auto CodeZ.')}</p><div class="plugin-detail-status"><span class="plugin-platform-status ${escapeHtml(status)}">${escapeHtml(stateLabels[plugin.state] || status)}</span>${work ? `<span class="plugin-detail-work">${escapeHtml(work)}</span>` : ''}</div>${plugin.failureReason ? `<div class="plugin-platform-error">${escapeHtml(plugin.failureReason)}</div>` : ''}<div class="plugin-detail-actions"><button class="plugin-platform-button" data-plugin-permissions="${escapeHtml(plugin.id)}">Configurar</button>${plugin.state === 'enabled' ? `<button class="plugin-platform-button secondary" data-plugin-disable="${escapeHtml(plugin.id)}">Desativar</button>` : canEnable ? `<button class="plugin-platform-button secondary" data-plugin-enable="${escapeHtml(plugin.id)}">Ativar</button>` : ''}<button class="plugin-platform-button danger" data-plugin-uninstall="${escapeHtml(plugin.id)}">Desinstalar</button></div><div class="plugin-detail-section"><strong>Permissões</strong><span>${plugin.grantedPermissions.length}/${plugin.requestedPermissions.length} autorizadas</span></div><div class="plugin-detail-section"><strong>Contribuições</strong><span>${escapeHtml(plugin.contributions.join(' · ') || 'Nenhuma contribuição declarada')}</span></div></section></div>`;
}
function listView(): string {
  const list = snapshot.plugins.length ? `<div class="plugin-list">${snapshot.plugins.map(compactPlugin).join('')}</div>` : '<div class="empty-panel">Nenhum plugin instalado.<br>Instale um pacote local para começar.</div>';
  return `<div data-plugin-platform-owned><div class="panel-title plugin-platform-title"><span>Plugins</span><button class="plugin-platform-icon-button" data-plugin-refresh title="Atualizar plugins" aria-label="Atualizar plugins">↻</button></div><button class="new-item plugin-platform-install" data-plugin-install><span class="new-item-icon plugin-extension-icon" aria-hidden="true"></span><span>Instalar da pasta</span></button>${loading ? '<div class="empty-panel">Atualizando plugins…</div>' : list}${snapshot.failures.length ? `<div class="plugin-platform-failures"><strong>${snapshot.failures.length} pacote(s) ignorado(s)</strong>${snapshot.failures.slice(0, 4).map((failure) => `<span>${escapeHtml(failure.directory)}: ${escapeHtml(failure.reason)}</span>`).join('')}</div>` : ''}</div>`;
}
function render(): void {
  if (!isPluginPanel()) return;
  const panel = document.querySelector<HTMLElement>('#nav-panel'); if (!panel) return;
  rendering = true;
  const selected = selectedPluginId ? snapshot.plugins.find((plugin) => plugin.id === selectedPluginId) : undefined;
  if (selectedPluginId && !selected) selectedPluginId = null;
  panel.innerHTML = selected ? detailView(selected) : listView();
  rendering = false;
}
function showPermissionModal(plugin: PluginSummary): void {
  const root = document.querySelector<HTMLElement>('#modal-root'); if (!root) return;
  const granted = new Set(plugin.grantedPermissions);
  root.innerHTML = `<div class="modal-backdrop"><section class="modal plugin-permission-modal" role="dialog" aria-modal="true" aria-label="Configurar ${escapeHtml(plugin.name)}"><div class="modal-kicker">CONFIGURAR PLUGIN</div><button class="modal-close" data-plugin-modal-close aria-label="Fechar"></button><h2>${escapeHtml(plugin.name)}</h2><p>Escolha as permissões que este plugin pode usar. Permissões removidas desativam o plugin imediatamente.</p><div class="plugin-permission-list">${plugin.requestedPermissions.map((permission) => `<label><input type="checkbox" data-plugin-permission-value="${escapeHtml(permission)}" ${granted.has(permission) ? 'checked' : ''}><span><strong>${escapeHtml(permissionLabels[permission] || permission)}</strong><small>${escapeHtml(permission)}</small></span></label>`).join('') || '<div class="empty-panel">Este plugin não solicita permissões externas.</div>'}</div><div class="plugin-permission-footer"><button class="plugin-platform-button secondary" data-plugin-modal-close>Cancelar</button><button class="plugin-platform-button" data-plugin-save-permissions="${escapeHtml(plugin.id)}">Salvar</button></div></section></div>`;
}
async function syncSandboxes(refreshSnapshot = true): Promise<void> {
  if (!bridge || !sandboxes) return;
  const desired = new Set(snapshot.plugins.filter((plugin) => plugin.state === 'enabled' && plugin.hasMain).map((plugin) => plugin.id));
  for (const pluginId of [...activeSandboxIds]) if (!desired.has(pluginId)) { await sandboxes.deactivate(pluginId); activeSandboxIds.delete(pluginId); }
  for (const plugin of snapshot.plugins) {
    if (plugin.state !== 'enabled') continue;
    if (!plugin.hasMain) { if (plugin.health.state !== 'healthy') { const updated = await bridge.markHealthy(plugin.id, 'Plugin declarativo ativo.').catch((): undefined => undefined); if (updated) replacePluginSummary(updated); } continue; }
    if (activeSandboxIds.has(plugin.id)) continue;
    try { const source = await bridge.source(plugin.id); await sandboxes.activate(plugin.id, source); activeSandboxIds.add(plugin.id); }
    catch (error) { const updated = await bridge.markFailed(plugin.id, error instanceof Error ? error.message : String(error)).catch((): undefined => undefined); if (updated) replacePluginSummary(updated); }
  }
  if (refreshSnapshot) snapshot = await bridge.snapshot(); render();
}
async function refresh(useRescan = false): Promise<void> {
  if (!bridge || loading) return; loading = true; render();
  try { snapshot = useRescan ? await bridge.refresh() : await bridge.snapshot(); await syncSandboxes(); }
  finally { loading = false; render(); }
}
async function act(action: () => Promise<unknown>): Promise<void> {
  if (!bridge || loading) return; loading = true; render();
  try { await action(); snapshot = await bridge.snapshot(); await syncSandboxes(false); }
  catch (error) { console.error('Falha na operação de plugin.', error); }
  finally { loading = false; render(); }
}
async function savePermissions(pluginId: string, selected: string[]): Promise<void> {
  if (!bridge || loading) return; loading = true; render();
  try { await bridge.grant(pluginId, selected); snapshot = await bridge.snapshot(); const root = document.querySelector<HTMLElement>('#modal-root'); if (root) root.innerHTML = ''; await syncSandboxes(false); }
  catch (error) { console.error('Falha ao salvar permissões do plugin.', error); }
  finally { loading = false; render(); }
}
async function handleSandboxCall(call: SandboxCall): Promise<void> {
  if (!bridge || !sandboxes || !call?.id || !call.pluginId || !call.method) return;
  try { if (!sandboxes.has(call.pluginId)) throw new Error(`Plugin '${call.pluginId}' não está ativo no sandbox.`); const value = await sandboxes.call(call.pluginId, call.method, call.input); await bridge.respondSandboxCall({ id: call.id, value }); }
  catch (error) { await bridge.respondSandboxCall({ id: call.id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }).catch((): undefined => undefined); }
}
function installStyles(): void {
  if (document.querySelector('#plugin-platform-styles')) return;
  const style = document.createElement('style'); style.id = 'plugin-platform-styles';
  style.textContent = `.plugin-platform-title{display:flex;align-items:center;gap:8px;justify-content:space-between}.plugin-platform-icon-button,.plugin-back{border:0;background:transparent;color:#768398;cursor:pointer}.plugin-platform-icon-button{font-size:18px}.plugin-back{font-size:24px;line-height:16px;padding:0 2px}.plugin-platform-title .plugin-back+span{margin-right:auto}.plugin-list{display:flex;flex-direction:column;padding:2px 6px}.plugin-list-item{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;padding:8px 7px;cursor:pointer}.plugin-list-item:hover{background:#151c25}.plugin-list-icon,.plugin-detail-icon{flex:0 0 auto;border:1px solid #344253;background:#121a24;position:relative}.plugin-list-icon{width:27px;height:27px;border-radius:6px}.plugin-detail-icon{width:44px;height:44px;border-radius:9px}.plugin-list-icon:after,.plugin-detail-icon:after{content:'+';position:absolute;inset:0;display:grid;place-items:center;color:#71829a;font-size:16px}.plugin-list-copy{min-width:0;display:flex;flex:1;flex-direction:column;gap:2px}.plugin-list-copy strong,.plugin-list-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plugin-list-copy strong{font-size:12px;font-weight:600;color:#e4e9ef}.plugin-list-copy span{font-size:10px;color:#7f8a99}.plugin-list-state{width:6px;height:6px;border-radius:50%;background:#526071}.plugin-list-state.healthy,.plugin-list-state.enabled{background:#72d69b}.plugin-list-state.failed{background:#e27f87}.plugin-list-state.starting{background:#e1bd72}.plugin-detail{padding:10px 12px;display:flex;flex-direction:column;gap:13px}.plugin-detail-heading{display:flex;gap:10px;align-items:center}.plugin-detail-title{min-width:0}.plugin-detail-title h2{font-size:15px;line-height:1.2;margin:0 0 3px;color:#edf1f6}.plugin-detail-title span{font-size:10px;color:#758195}.plugin-detail-description{margin:0;color:#9da7b5;font-size:11px;line-height:1.45}.plugin-detail-status{display:flex;align-items:center;gap:8px}.plugin-platform-status{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#8793a4}.plugin-platform-status.healthy,.plugin-platform-status.enabled{color:#72d69b}.plugin-platform-status.failed{color:#f08c8c}.plugin-platform-status.starting{color:#e1bd72}.plugin-detail-work{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#9aabc0}.plugin-detail-actions{display:flex;gap:6px;flex-wrap:wrap}.plugin-platform-button{border:1px solid #43699d;background:#234b79;color:#e7eef8;border-radius:6px;padding:6px 9px;font-size:10px;cursor:pointer}.plugin-platform-button.secondary{background:#171e27;border-color:#354252}.plugin-platform-button.danger{background:transparent;border-color:#543036;color:#cb8188}.plugin-detail-section{padding-top:10px;border-top:1px solid #202936;display:flex;flex-direction:column;gap:3px}.plugin-detail-section strong{font-size:10px;color:#c7d0dc}.plugin-detail-section span{font-size:10px;color:#748195}.plugin-platform-error,.plugin-platform-failures{color:#e8a0a5;font-size:10px}.plugin-platform-failures{margin:10px 12px;display:flex;flex-direction:column;gap:4px}.plugin-permission-modal{max-width:560px}.plugin-permission-list{display:flex;flex-direction:column;gap:7px;margin:18px 0;max-height:340px;overflow:auto}.plugin-permission-list label{display:flex;align-items:flex-start;gap:10px;border:1px solid #26313e;border-radius:8px;padding:10px;background:#10161e}.plugin-permission-list input{margin-top:3px}.plugin-permission-list span{display:flex;flex-direction:column;gap:2px}.plugin-permission-list strong{font-size:11px}.plugin-permission-list small{font-size:9px;color:#748195}.plugin-permission-footer{display:flex;justify-content:flex-end;gap:7px}.plugin-platform-install{margin-bottom:4px}`;
  document.head.appendChild(style);
}
export function initializePluginPlatformUi(): void {
  if (!bridge) return; installStyles();
  bridge.onSandboxCall((call) => { void handleSandboxCall(call); });
  bridge.onActivity((activity) => { activities.set(activity.pluginId, activity); render(); });
  bridge.onJob((job) => { jobs.set(job.id, job); render(); });
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-plugin-install],[data-plugin-refresh],[data-plugin-open],[data-plugin-back],[data-plugin-enable],[data-plugin-disable],[data-plugin-permissions],[data-plugin-uninstall],[data-plugin-modal-close],[data-plugin-save-permissions]'); if (!button) return;
    if (button.hasAttribute('data-plugin-modal-close')) { const root = document.querySelector<HTMLElement>('#modal-root'); if (root) root.innerHTML = ''; return; }
    if (button.hasAttribute('data-plugin-back')) { selectedPluginId = null; render(); return; }
    const openId = button.getAttribute('data-plugin-open'); if (openId) { selectedPluginId = openId; render(); return; }
    if (button.hasAttribute('data-plugin-install')) { void act(async () => { await bridge.installFromFolder(); }); return; }
    if (button.hasAttribute('data-plugin-refresh')) { void refresh(true); return; }
    const pluginId = button.getAttribute('data-plugin-enable') || button.getAttribute('data-plugin-disable') || button.getAttribute('data-plugin-permissions') || button.getAttribute('data-plugin-uninstall') || button.getAttribute('data-plugin-save-permissions'); if (!pluginId) return;
    const plugin = snapshot.plugins.find((item) => item.id === pluginId); if (!plugin) return;
    if (button.hasAttribute('data-plugin-permissions')) { showPermissionModal(plugin); return; }
    if (button.hasAttribute('data-plugin-enable')) { void act(() => bridge.enable(pluginId)); return; }
    if (button.hasAttribute('data-plugin-disable')) { void act(async () => { await sandboxes?.deactivate(pluginId); activeSandboxIds.delete(pluginId); await bridge.disable(pluginId); }); return; }
    if (button.hasAttribute('data-plugin-uninstall')) { if (!window.confirm(`Desinstalar o plugin ${plugin.name}?`)) return; void act(async () => { await sandboxes?.deactivate(pluginId); activeSandboxIds.delete(pluginId); await bridge.uninstall(pluginId); selectedPluginId = null; }); return; }
    if (button.hasAttribute('data-plugin-save-permissions')) { const modal = button.closest<HTMLElement>('.plugin-permission-modal'); const checked = modal ? [...modal.querySelectorAll<HTMLInputElement>('[data-plugin-permission-value]:checked')].map((input) => input.getAttribute('data-plugin-permission-value')).filter((permission): permission is string => Boolean(permission)) : []; const selected = plugin.requestedPermissions.filter((permission) => checked.includes(permission)); void savePermissions(pluginId, selected); }
  });
  const observer = new MutationObserver(() => { if (rendering || !isPluginPanel()) return; const panel = document.querySelector<HTMLElement>('#nav-panel'); if (!panel || panel.querySelector('[data-plugin-platform-owned]')) return; selectedPluginId = null; render(); });
  observer.observe(document.body, { childList: true, subtree: true });
  void refresh();
}
