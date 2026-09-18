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
  builtIn: boolean;
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
const contributionLabels: Record<string, string> = { tool: 'Tools do agente', provider: 'Provider de IA', ui: 'Interface', command: 'Comandos', job: 'Jobs em segundo plano' };
const healthLabels: Record<string, string> = { inactive: 'Inativo', starting: 'Inicializando', healthy: 'Operacional', degraded: 'Atenção necessária', failed: 'Falha no runtime' };
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
  const permissions = plugin.requestedPermissions.length
    ? plugin.requestedPermissions.map((permission) => `<div class="plugin-detail-permission"><span>${escapeHtml(permissionLabels[permission] || permission)}</span><small>${plugin.grantedPermissions.includes(permission) ? 'Autorizada' : 'Não autorizada'}</small></div>`).join('')
    : '<div class="plugin-detail-empty">Este plugin não solicita acesso adicional.</div>';
  const contributions = plugin.contributions.length
    ? plugin.contributions.map((item) => `<span class="plugin-detail-chip">${escapeHtml(contributionLabels[item] || item)}</span>`).join('')
    : '<span class="plugin-detail-muted">Nenhuma contribuição declarada no manifesto.</span>';
  const runtime = plugin.hasMain ? 'Sandbox isolado' : 'Declarativo';
  const publisher = plugin.publisher || 'Autor não informado';
  return `<section class="plugin-detail-overlay" data-plugin-detail="${escapeHtml(plugin.id)}" aria-label="Detalhes de ${escapeHtml(plugin.name)}">
    <div class="plugin-detail-page">
      <header class="plugin-detail-header">
        <button class="plugin-detail-back" type="button" data-plugin-back aria-label="Voltar para a lista de plugins"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span>Plugins</span></button>
        <button class="plugin-detail-close" type="button" data-plugin-back aria-label="Fechar detalhes do plugin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </header>
      <main class="plugin-detail-content">
        <section class="plugin-detail-hero">
          <div class="plugin-detail-icon" aria-hidden="true"></div>
          <div class="plugin-detail-identity">
            <div class="plugin-detail-eyebrow">${plugin.builtIn ? 'PLUGIN INTEGRADO' : 'PLUGIN INSTALADO'}</div>
            <h1>${escapeHtml(plugin.name)}</h1>
            <div class="plugin-detail-byline"><span>${escapeHtml(publisher)}</span><span>v${escapeHtml(plugin.version)}</span><code>${escapeHtml(plugin.id)}</code></div>
            <p>${escapeHtml(plugin.description || 'O autor não forneceu uma descrição para este plugin.')}</p>
            <div class="plugin-detail-status-row"><span class="plugin-platform-status ${escapeHtml(status)}">${escapeHtml(plugin.state === 'enabled' ? (healthLabels[plugin.health.state] || plugin.health.state) : (stateLabels[plugin.state] || status))}</span>${work ? `<span class="plugin-detail-work">${escapeHtml(work)}</span>` : ''}</div>
          </div>
          <div class="plugin-detail-actions"><button class="plugin-platform-button" data-plugin-permissions="${escapeHtml(plugin.id)}">Configurar</button>${plugin.state === 'enabled' ? `<button class="plugin-platform-button secondary" data-plugin-disable="${escapeHtml(plugin.id)}">Desativar</button>` : canEnable ? `<button class="plugin-platform-button secondary" data-plugin-enable="${escapeHtml(plugin.id)}">Ativar</button>` : ''}${plugin.builtIn ? '' : `<button class="plugin-platform-button danger" data-plugin-uninstall="${escapeHtml(plugin.id)}">Desinstalar</button>`}</div>
        </section>
        ${plugin.failureReason ? `<div class="plugin-platform-error plugin-detail-alert"><strong>Falha registrada</strong><span>${escapeHtml(plugin.failureReason)}</span></div>` : ''}
        <div class="plugin-detail-grid">
          <section class="plugin-detail-card plugin-detail-about"><div class="plugin-detail-card-heading"><div><span>VISÃO GERAL</span><h2>Sobre este plugin</h2></div></div><p>${escapeHtml(plugin.description || 'O manifesto não inclui uma descrição do plugin.')}</p><dl><div><dt>Desenvolvedor</dt><dd>${escapeHtml(publisher)}</dd></div><div><dt>Versão</dt><dd>${escapeHtml(plugin.version)}</dd></div><div><dt>Identificador</dt><dd><code>${escapeHtml(plugin.id)}</code></dd></div>${plugin.homepage ? `<div><dt>Homepage</dt><dd>${escapeHtml(plugin.homepage)}</dd></div>` : ''}</dl></section>
          <section class="plugin-detail-card"><div class="plugin-detail-card-heading"><div><span>EXECUÇÃO</span><h2>Estado e diagnóstico</h2></div></div><div class="plugin-detail-facts"><div><span>Estado</span><strong>${escapeHtml(stateLabels[plugin.state] || plugin.state)}</strong></div><div><span>Runtime</span><strong>${runtime}</strong></div><div><span>Saúde</span><strong>${escapeHtml(healthLabels[plugin.health.state] || plugin.health.state)}</strong></div><div><span>Última atualização</span><strong>${new Date(plugin.health.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></div></div>${plugin.health.message ? `<div class="plugin-detail-runtime-message">${escapeHtml(plugin.health.message)}</div>` : ''}</section>
          <section class="plugin-detail-card"><div class="plugin-detail-card-heading"><div><span>SEGURANÇA</span><h2>Acesso solicitado</h2></div><strong>${plugin.grantedPermissions.length}/${plugin.requestedPermissions.length} autorizadas</strong></div><div class="plugin-detail-permissions">${permissions}</div></section>
          <section class="plugin-detail-card"><div class="plugin-detail-card-heading"><div><span>CAPACIDADES</span><h2>Integrações declaradas</h2></div></div><div class="plugin-detail-chips">${contributions}</div><p class="plugin-detail-note">Somente capacidades declaradas pelo manifesto e autorizadas pelo Auto CodeZ podem ser usadas pelo runtime.</p></section>
        </div>
      </main>
    </div>
  </section>`;
}
function listView(): string {
  const list = snapshot.plugins.length ? `<div class="plugin-list">${snapshot.plugins.map(compactPlugin).join('')}</div>` : '<div class="empty-panel">Nenhum plugin instalado.<br>Instale um pacote local para começar.</div>';
  return `<div data-plugin-platform-owned><div class="panel-title plugin-platform-title"><span>Plugins</span><button class="plugin-platform-icon-button" data-plugin-refresh title="Atualizar plugins" aria-label="Atualizar plugins">↻</button></div><button class="new-item plugin-platform-install" data-plugin-install><span class="new-item-icon plugin-extension-icon" aria-hidden="true"></span><span>Instalar da pasta</span></button>${loading ? '<div class="empty-panel">Atualizando plugins…</div>' : list}${snapshot.failures.length ? `<div class="plugin-platform-failures"><strong>${snapshot.failures.length} pacote(s) ignorado(s)</strong>${snapshot.failures.slice(0, 4).map((failure) => `<span>${escapeHtml(failure.directory)}: ${escapeHtml(failure.reason)}</span>`).join('')}</div>` : ''}</div>`;
}
function renderDetail(): void {
  document.querySelector('.plugin-detail-overlay')?.remove();
  if (!selectedPluginId) return;
  const plugin = snapshot.plugins.find((item) => item.id === selectedPluginId);
  if (!plugin) { selectedPluginId = null; return; }
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!shell) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = detailView(plugin);
  const overlay = wrapper.firstElementChild;
  if (overlay) shell.appendChild(overlay);
}
function render(): void {
  const panel = document.querySelector<HTMLElement>('#nav-panel');
  if (isPluginPanel() && panel) {
    rendering = true;
    panel.innerHTML = listView();
    rendering = false;
  }
  renderDetail();
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
    try { const source = await bridge.source(plugin.id); await sandboxes.activate(plugin.id, source); activeSandboxIds.add(plugin.id); const updated = await bridge.snapshot(); const current = updated.plugins.find((item) => item.id === plugin.id); if (current) replacePluginSummary(current); }
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
  style.textContent = `.plugin-platform-title{display:flex;align-items:center;gap:8px;justify-content:space-between}.plugin-platform-icon-button{border:0;background:transparent;color:#768398;cursor:pointer;font-size:18px}.plugin-list{display:flex;flex-direction:column;padding:2px 6px}.plugin-list-item{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;padding:8px 7px;cursor:pointer}.plugin-list-item:hover{background:#151c25}.plugin-list-icon,.plugin-detail-icon{flex:0 0 auto;border:1px solid #344253;background:#121a24;position:relative}.plugin-list-icon{width:27px;height:27px;border-radius:6px}.plugin-detail-icon{width:72px;height:72px;border-radius:14px}.plugin-list-icon:after,.plugin-detail-icon:after{content:'+';position:absolute;inset:0;display:grid;place-items:center;color:#71829a;font-size:20px}.plugin-list-copy{min-width:0;display:flex;flex:1;flex-direction:column;gap:2px}.plugin-list-copy strong,.plugin-list-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plugin-list-copy strong{font-size:12px;font-weight:600;color:#e4e9ef}.plugin-list-copy span{font-size:10px;color:#7f8a99}.plugin-list-state{width:6px;height:6px;border-radius:50%;background:#526071}.plugin-list-state.healthy,.plugin-list-state.enabled{background:#72d69b}.plugin-list-state.failed{background:#e27f87}.plugin-list-state.starting{background:#e1bd72}.plugin-platform-status{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8793a4}.plugin-platform-status.healthy,.plugin-platform-status.enabled{color:#72d69b}.plugin-platform-status.failed{color:#f08c8c}.plugin-platform-status.starting{color:#e1bd72}.plugin-platform-button{border:1px solid #43699d;background:#234b79;color:#e7eef8;border-radius:7px;padding:8px 12px;font-size:11px;font-weight:600;cursor:pointer}.plugin-platform-button.secondary{background:#171e27;border-color:#354252}.plugin-platform-button.danger{background:transparent;border-color:#543036;color:#cb8188}.plugin-platform-error,.plugin-platform-failures{color:#e8a0a5;font-size:10px}.plugin-platform-failures{margin:10px 12px;display:flex;flex-direction:column;gap:4px}.plugin-platform-install{margin-bottom:4px}.plugin-detail-overlay{position:absolute;inset:0;z-index:80;background:#090d12;color:#dce3ec;overflow:auto}#modal-root{z-index:100}.plugin-detail-page{min-height:100%;max-width:1180px;margin:0 auto;padding:0 42px 52px}.plugin-detail-header{height:64px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1d2631}.plugin-detail-back,.plugin-detail-close{display:flex;align-items:center;gap:8px;border:0;background:transparent;color:#8794a6;cursor:pointer}.plugin-detail-back{font-size:12px;font-weight:600}.plugin-detail-back svg,.plugin-detail-close svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.plugin-detail-close{padding:8px}.plugin-detail-content{padding-top:38px}.plugin-detail-hero{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:22px;align-items:start;padding-bottom:34px;border-bottom:1px solid #1d2631}.plugin-detail-identity{min-width:0}.plugin-detail-eyebrow,.plugin-detail-card-heading span{font-size:9px;font-weight:700;letter-spacing:.13em;color:#66758a}.plugin-detail-identity h1{margin:5px 0 7px;font-size:28px;line-height:1.15;color:#f1f4f8;font-weight:650}.plugin-detail-byline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:#8491a3}.plugin-detail-byline code,.plugin-detail-about code{font:10px/1.4 Consolas,monospace;color:#9cabbf;background:#111820;border:1px solid #222e3b;border-radius:4px;padding:2px 5px}.plugin-detail-identity>p{max-width:760px;margin:16px 0 13px;color:#a8b2bf;font-size:13px;line-height:1.65}.plugin-detail-status-row{display:flex;align-items:center;gap:12px}.plugin-detail-work{font-size:11px;color:#9aabc0}.plugin-detail-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;max-width:320px}.plugin-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:24px}.plugin-detail-card{min-width:0;border:1px solid #202a36;background:#0d131a;border-radius:10px;padding:20px}.plugin-detail-card-heading{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:17px}.plugin-detail-card-heading h2{margin:3px 0 0;font-size:15px;color:#e5ebf2}.plugin-detail-card-heading>strong{font-size:10px;color:#8290a2;font-weight:500}.plugin-detail-about>p{margin:0 0 18px;color:#9da9b8;font-size:12px;line-height:1.6}.plugin-detail-about dl{margin:0;display:grid;gap:9px}.plugin-detail-about dl div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px}.plugin-detail-about dt{font-size:10px;color:#657386}.plugin-detail-about dd{margin:0;font-size:11px;color:#b7c1cd;overflow-wrap:anywhere}.plugin-detail-facts{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#202a36;border:1px solid #202a36;border-radius:7px;overflow:hidden}.plugin-detail-facts div{background:#0a1016;padding:11px 12px;display:flex;flex-direction:column;gap:3px}.plugin-detail-facts span{font-size:9px;color:#66758a}.plugin-detail-facts strong{font-size:11px;color:#c7d0db;font-weight:550}.plugin-detail-runtime-message{margin-top:12px;padding:9px 11px;border-left:2px solid #365d88;background:#0a1016;color:#91a0b3;font-size:10px}.plugin-detail-permissions{display:grid;gap:7px}.plugin-detail-permission{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 10px;border:1px solid #202a36;border-radius:6px;background:#0a1016}.plugin-detail-permission span{font-size:11px;color:#b9c3cf}.plugin-detail-permission small{font-size:9px;color:#748397}.plugin-detail-empty,.plugin-detail-muted,.plugin-detail-note{font-size:10px;color:#718094}.plugin-detail-chips{display:flex;flex-wrap:wrap;gap:7px}.plugin-detail-chip{border:1px solid #293746;background:#111923;color:#aab7c6;border-radius:999px;padding:5px 8px;font-size:10px}.plugin-detail-note{margin:15px 0 0;line-height:1.55}.plugin-detail-alert{margin-top:18px;border:1px solid #553238;background:#1a1013;border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}.plugin-permission-modal{max-width:560px}.plugin-permission-list{display:flex;flex-direction:column;gap:7px;margin:18px 0;max-height:340px;overflow:auto}.plugin-permission-list label{display:flex;align-items:flex-start;gap:10px;border:1px solid #26313e;border-radius:8px;padding:10px;background:#10161e}.plugin-permission-list input{margin-top:3px}.plugin-permission-list span{display:flex;flex-direction:column;gap:2px}.plugin-permission-list strong{font-size:11px}.plugin-permission-list small{font-size:9px;color:#748195}.plugin-permission-footer{display:flex;justify-content:flex-end;gap:7px}@media(max-width:900px){.plugin-detail-page{padding:0 24px 36px}.plugin-detail-hero{grid-template-columns:58px minmax(0,1fr)}.plugin-detail-icon{width:58px;height:58px}.plugin-detail-actions{grid-column:1/-1;justify-content:flex-start;max-width:none}.plugin-detail-grid{grid-template-columns:1fr}}`;
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
    if (button.hasAttribute('data-plugin-back')) { selectedPluginId = null; renderDetail(); return; }
    const openId = button.getAttribute('data-plugin-open'); if (openId) { selectedPluginId = openId; renderDetail(); return; }
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
  const panel = document.querySelector<HTMLElement>('#nav-panel'); if (panel) observer.observe(panel, { childList: true, subtree: true });
  void refresh();
}

initializePluginPlatformUi();
