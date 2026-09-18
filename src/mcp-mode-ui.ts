type LedgerState = 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'cancelled';
type LedgerCategory = 'execution' | 'tool' | 'approval' | 'plugin' | 'job' | 'artifact' | 'test' | 'web' | 'system';

type LedgerEvent = {
  eventId: string;
  sequence: number;
  timestamp: number;
  actor: string;
  category: LedgerCategory;
  state: LedgerState;
  summary: string;
  chatId?: string;
  runId?: string;
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  clientId?: string;
  pluginId?: string;
  toolCallId?: string;
  toolName?: string;
  jobId?: string;
  causationId?: string;
  artifactIds?: string[];
  resources?: string[];
  sourceRefs?: string[];
  diff?: { files: number; addedLines: number; removedLines: number };
  progress?: number;
  durationMs?: number;
  error?: string;
  details?: Record<string, string | number | boolean | null>;
};

type Approval = {
  id: string;
  chatId?: string;
  runId?: string;
  toolCall: { id: string; name: string };
};

type ModeFilter = 'all' | 'activity' | 'errors' | 'artifacts';
type GatewayStatus = { running: boolean; host: string; port: number; endpoint: string };
type TunnelStatus = { running: boolean; ready: boolean; version?: string; tunnelId?: string; localEndpoint?: string; healthUrl?: string; error?: string; credentialAvailable: boolean };

const MAX_RENDERED_EVENTS = 250;
const rootId = 'mcp-mode-root';
let active = false;
let loading = false;
let events: LedgerEvent[] = [];
let approvals: Approval[] = [];
let selectedScope = '';
let filter: ModeFilter = 'all';
let selectedArtifactId = '';
const expandedEvents = new Set<string>();
let unsubscribeLedger: (() => void) | undefined;
let gatewayStatus: GatewayStatus = { running: false, host: '127.0.0.1', port: 0, endpoint: '' };
let gatewayToken = '';
let tunnelStatus: TunnelStatus = { running: false, ready: false, credentialAvailable: false };
let tunnelDoctorResult = '';
let tunnelError = '';
let tunnelIdDraft = '';
let tunnelExecutableDraft = '';
let refreshSequence = 0;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]!));
}

function asLedgerEvent(value: unknown): LedgerEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.eventId !== 'string' || !Number.isInteger(item.sequence) || typeof item.timestamp !== 'number') return undefined;
  if (typeof item.category !== 'string' || typeof item.state !== 'string' || typeof item.summary !== 'string') return undefined;
  return value as LedgerEvent;
}

function scopeKey(event: LedgerEvent): string {
  if (event.sessionId) return `session:${event.sessionId}`;
  if (event.runId) return `run:${event.runId}`;
  if (event.chatId) return `chat:${event.chatId}`;
  return 'global';
}

function scopeLabel(event: LedgerEvent): string {
  if (event.clientId && event.clientId !== 'autocodez-chat') return event.clientId;
  if (event.pluginId === 'autocodez.roblox-studio-manager') return 'Roblox Studio';
  if (event.providerId) return event.providerId;
  if (event.runId) return 'Execução';
  return 'Sistema';
}

function stateLabel(state: LedgerState): string {
  if (state === 'success') return 'Concluído';
  if (state === 'failed') return 'Falhou';
  if (state === 'running') return 'Em execução';
  if (state === 'waiting' || state === 'pending') return 'Aguardando';
  return 'Cancelado';
}

function categoryLabel(category: LedgerCategory): string {
  const labels: Record<LedgerCategory, string> = {
    execution: 'Execução',
    tool: 'Ferramenta',
    approval: 'Aprovação',
    plugin: 'Plugin',
    job: 'Job',
    artifact: 'Artifact',
    test: 'Teste',
    web: 'Web',
    system: 'Sistema',
  };
  return labels[category];
}

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function visibleEvents(): LedgerEvent[] {
  let scoped = selectedScope ? events.filter((event) => scopeKey(event) === selectedScope) : events;
  if (selectedArtifactId) scoped = scoped.filter((event) => event.artifactIds?.includes(selectedArtifactId));
  if (filter === 'errors') return scoped.filter((event) => event.state === 'failed' || Boolean(event.error));
  if (filter === 'artifacts') return scoped.filter((event) => Boolean(event.artifactIds?.length));
  if (filter === 'activity') return scoped.filter((event) => event.category !== 'execution' && event.category !== 'system');
  return scoped;
}

function sessionEntries(): Array<{ key: string; latest: LedgerEvent; count: number }> {
  const grouped = new Map<string, { latest: LedgerEvent; count: number }>();
  for (const event of events) {
    const key = scopeKey(event);
    const current = grouped.get(key);
    if (!current) grouped.set(key, { latest: event, count: 1 });
    else {
      current.count += 1;
      if (event.sequence > current.latest.sequence) current.latest = event;
    }
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({ key, latest: value.latest, count: value.count }))
    .sort((left, right) => right.latest.sequence - left.latest.sequence)
    .slice(0, 50);
}

function currentEvents(): LedgerEvent[] {
  return selectedScope ? events.filter((event) => scopeKey(event) === selectedScope) : events;
}

function currentHeader(): { title: string; subtitle: string; state: LedgerState; provider?: string; project?: string; run?: string; chatId?: string; clientId?: string } {
  const scoped = currentEvents();
  const latest = scoped.at(-1) ?? events.at(-1);
  const context = [...scoped].reverse().find((event) => event.providerId || event.projectId || event.clientId) ?? latest;
  if (!latest) {
    return { title: 'MCP Mode', subtitle: 'Nenhuma atividade operacional registrada.', state: 'success' };
  }
  return {
    title: selectedScope ? scopeLabel(context ?? latest) : 'MCP Mode',
    subtitle: context?.clientId && context.clientId !== 'autocodez-chat'
      ? `Cliente externo · ${context.clientId}`
      : context?.providerId
        ? `${context.providerId}${context.details?.model ? ` · ${String(context.details.model)}` : ''}`
        : 'Ledger operacional autoritativo',
    state: latest.state,
    provider: context?.providerId,
    project: context?.projectId,
    run: context?.runId,
    chatId: context?.chatId,
    clientId: context?.clientId,
  };
}

function artifacts(): string[] {
  const output = new Set<string>();
  for (const event of currentEvents()) for (const id of event.artifactIds ?? []) output.add(id);
  return [...output].slice(-24).reverse();
}

function relevantApprovals(): Approval[] {
  if (!selectedScope) return approvals;
  const scoped = currentEvents();
  const runIds = new Set(scoped.map((event) => event.runId).filter(Boolean));
  const chatIds = new Set(scoped.map((event) => event.chatId).filter(Boolean));
  return approvals.filter((approval) => (approval.runId && runIds.has(approval.runId)) || (approval.chatId && chatIds.has(approval.chatId)));
}

function eventMeta(event: LedgerEvent): string {
  const parts = [categoryLabel(event.category)];
  if (event.toolName) parts.push(event.toolName);
  else if (event.pluginId) parts.push(event.pluginId);
  if (event.durationMs !== undefined) parts.push(formatDuration(event.durationMs));
  return parts.map(escapeHtml).join(' · ');
}

function eventDetails(event: LedgerEvent): string {
  const details: string[] = [];
  if (event.diff) details.push(`<span class="mcp-diff">+${event.diff.addedLines} −${event.diff.removedLines} · ${event.diff.files} arquivo${event.diff.files === 1 ? '' : 's'}</span>`);
  if (event.resources?.length) details.push(`<span>${escapeHtml(event.resources.slice(0, 4).join(' · '))}${event.resources.length > 4 ? ` · +${event.resources.length - 4}` : ''}</span>`);
  if (event.artifactIds?.length) details.push(`<span>${event.artifactIds.length} artifact${event.artifactIds.length === 1 ? '' : 's'}</span>`);
  if (event.sourceRefs?.length) details.push(`<span>${event.sourceRefs.length} fonte${event.sourceRefs.length === 1 ? '' : 's'}</span>`);
  if (event.progress !== undefined) details.push(`<span>${Math.round(event.progress * 100)}%</span>`);
  return details.length ? `<div class="mcp-event-details">${details.join('')}</div>` : '';
}

function expandedEventDetails(event: LedgerEvent): string {
  if (!expandedEvents.has(event.eventId)) return '';
  const rows: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(`<div><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>`);
  };
  add('eventId', event.eventId);
  add('sequence', event.sequence);
  add('actor', event.actor);
  add('chatId', event.chatId);
  add('runId', event.runId);
  add('sessionId', event.sessionId);
  add('projectId', event.projectId);
  add('providerId', event.providerId);
  add('clientId', event.clientId);
  add('pluginId', event.pluginId);
  add('toolCallId', event.toolCallId);
  add('toolName', event.toolName);
  add('jobId', event.jobId);
  add('causationId', event.causationId);
  if (event.resources?.length) add('resources', event.resources.join(' · '));
  if (event.artifactIds?.length) add('artifacts', event.artifactIds.join(' · '));
  if (event.sourceRefs?.length) add('sources', event.sourceRefs.join(' · '));
  if (event.details) for (const [key, value] of Object.entries(event.details)) add(`detail.${key}`, value);
  return rows.length ? `<div class="mcp-event-expanded">${rows.join('')}</div>` : '';
}

function artifactMetadata(id: string): { label: string; meta: string } {
  const event = [...events].reverse().find((item) => item.artifactIds?.includes(id));
  const kind = event?.details?.kind ? String(event.details.kind) : 'artifact';
  const mime = event?.details?.mimeType ? String(event.details.mimeType) : '';
  const bytes = typeof event?.details?.bytes === 'number' ? `${event.details.bytes} B` : '';
  return { label: kind, meta: [mime, bytes].filter(Boolean).join(' · ') };
}

function renderEvent(event: LedgerEvent): string {
  const expanded = expandedEvents.has(event.eventId);
  return `<article class="mcp-event state-${escapeHtml(event.state)} ${expanded ? 'expanded' : ''}" data-ledger-event="${escapeHtml(event.eventId)}">
    <button class="mcp-event-toggle" type="button" data-mcp-expand="${escapeHtml(event.eventId)}" aria-expanded="${expanded ? 'true' : 'false'}">
      <div class="mcp-event-line"><span class="mcp-event-dot"></span><span class="mcp-event-time">${escapeHtml(formatTime(event.timestamp))}</span><span class="mcp-event-meta">${eventMeta(event)}</span><span class="mcp-event-state">${escapeHtml(stateLabel(event.state))}</span></div>
      <div class="mcp-event-summary">${escapeHtml(event.summary)}</div>
      ${eventDetails(event)}
      ${event.error ? `<div class="mcp-event-error">${escapeHtml(event.error)}</div>` : ''}
    </button>
    ${expandedEventDetails(event)}
  </article>`;
}

function render(): void {
  const root = document.getElementById(rootId);
  if (!root) return;
  const sessions = sessionEntries();
  const header = currentHeader();
  const timeline = visibleEvents().slice(-MAX_RENDERED_EVENTS).reverse();
  const artifactIds = artifacts();
  const pending = relevantApprovals();

  root.innerHTML = `
    <aside class="mcp-mode-sidebar">
      <div class="mcp-mode-sidebar-head"><span class="mcp-mode-kicker">MCP MODE</span><strong>Sessões</strong></div>
      <button class="mcp-session-item ${selectedScope === '' ? 'active' : ''}" data-mcp-scope="">
        <span class="mcp-session-led"></span><span><strong>Todas as atividades</strong><small>${events.length} eventos</small></span>
      </button>
      <div class="mcp-session-list">
        ${sessions.map(({ key, latest, count }) => `<button class="mcp-session-item ${selectedScope === key ? 'active' : ''}" data-mcp-scope="${escapeHtml(key)}">
          <span class="mcp-session-led state-${escapeHtml(latest.state)}"></span>
          <span><strong>${escapeHtml(scopeLabel(latest))}</strong><small>${escapeHtml(latest.runId ? latest.runId.slice(0, 12) : latest.sessionId ? latest.sessionId.slice(0, 12) : 'atividade global')} · ${count}</small></span>
        </button>`).join('')}
      </div>
    </aside>
    <section class="mcp-mode-main">
      <header class="mcp-mode-header">
        <div>
          <div class="mcp-mode-title-row"><span class="mcp-live-dot state-${escapeHtml(header.state)}"></span><h1>${escapeHtml(header.title)}</h1><span class="mcp-header-state">${escapeHtml(stateLabel(header.state))}</span></div>
          <div class="mcp-mode-subtitle">${escapeHtml(header.subtitle)}${header.project ? ` · Projeto ${escapeHtml(header.project)}` : ''}${header.run ? ` · ${escapeHtml(header.run.slice(0, 16))}` : ''}</div>
        </div>
        <div class="mcp-header-actions">${header.clientId === 'autocodez-chat' && header.chatId && (header.state === 'running' || header.state === 'waiting' || header.state === 'pending') ? `<button class="mcp-stop-button" type="button" data-mcp-stop="${escapeHtml(header.chatId)}">■ Parar</button>` : ''}<button class="mcp-refresh-button" type="button" data-mcp-refresh>Atualizar</button></div>
      </header>
      <div class="mcp-mode-toolbar">
        <div class="mcp-filter-group">
          ${([['all','Tudo'],['activity','Atividade'],['errors','Erros'],['artifacts','Artifacts']] as Array<[ModeFilter,string]>).map(([value,label]) => `<button class="mcp-filter ${filter === value ? 'active' : ''}" data-mcp-filter="${value}">${label}</button>`).join('')}
        </div>
        <div class="mcp-mode-count">${timeline.length} de ${currentEvents().length} eventos</div>
      </div>
      <section class="mcp-gateway-card ${gatewayStatus.running ? 'running' : ''}">
        <div class="mcp-gateway-copy">
          <div class="mcp-section-label">MCP Gateway</div>
          <strong>${gatewayStatus.running ? 'Ativo somente em localhost' : 'Desligado'}</strong>
          <span>${gatewayStatus.running ? `${escapeHtml(gatewayStatus.endpoint)} · MCP 2026-07-28` : 'Nenhuma porta local é aberta até você iniciar explicitamente.'}</span>
          ${gatewayStatus.running && gatewayToken ? `<code>Bearer ${escapeHtml(gatewayToken)}</code>` : gatewayStatus.running ? '<small>Token não é persistido. Reinicie o Gateway para gerar e revelar uma nova credencial.</small>' : ''}
        </div>
        <div class="mcp-gateway-actions">
          ${gatewayStatus.running && gatewayToken ? '<button data-mcp-copy-gateway>Copiar conexão</button>' : ''}
          <button class="${gatewayStatus.running ? 'danger' : 'primary'}" data-mcp-gateway-toggle>${gatewayStatus.running ? 'Parar Gateway' : 'Iniciar Gateway'}</button>
        </div>
      </section>
      <section class="mcp-tunnel-card ${tunnelStatus.ready ? 'ready' : tunnelStatus.running ? 'running' : ''}">
        <div class="mcp-tunnel-copy">
          <div class="mcp-section-label">Secure MCP Tunnel</div>
          <strong>${tunnelStatus.ready ? 'Conectado e pronto' : tunnelStatus.running ? 'Inicializando…' : 'Opcional · desligado'}</strong>
          <span>${tunnelStatus.ready
            ? `${escapeHtml(tunnelStatus.tunnelId || '')}${tunnelStatus.version ? ` · tunnel-client ${escapeHtml(tunnelStatus.version)}` : ''}`
            : 'Use apenas para desenvolvimento privado com o ChatGPT. O Tunnel nunca substitui as políticas do Auto CodeZ.'}</span>
          ${tunnelDoctorResult ? `<small>${escapeHtml(tunnelDoctorResult)}</small>` : ''}
          ${tunnelStatus.error || tunnelError ? `<div class="mcp-tunnel-error">${escapeHtml(tunnelStatus.error || tunnelError)}</div>` : ''}
        </div>
        <div class="mcp-tunnel-controls">
          ${tunnelStatus.running
            ? '<button class="danger" type="button" data-mcp-tunnel-stop>Parar Tunnel</button>'
            : `<input type="text" maxlength="39" autocomplete="off" spellcheck="false" placeholder="tunnel_…" value="${escapeHtml(tunnelIdDraft)}" data-mcp-tunnel-id aria-label="Tunnel ID">
               <input type="text" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="tunnel-client (opcional)" value="${escapeHtml(tunnelExecutableDraft)}" data-mcp-tunnel-executable aria-label="Executável tunnel-client">
               <input type="password" maxlength="8192" autocomplete="new-password" placeholder="${tunnelStatus.credentialAvailable ? 'Credencial detectada no ambiente' : 'Chave do control plane (somente sessão)'}" data-mcp-tunnel-key aria-label="Chave do control plane">
               <button type="button" data-mcp-tunnel-doctor>Doctor</button>
               <button class="primary" type="button" data-mcp-tunnel-start ${gatewayStatus.running ? '' : 'disabled'}>Conectar</button>`}
        </div>
      </section>
      ${pending.length ? `<section class="mcp-approval-stack"><div class="mcp-section-label">Aguardando aprovação</div>${pending.map((approval) => `<div class="mcp-approval-card"><div><strong>${escapeHtml(approval.toolCall.name)}</strong><span>A execução está pausada até sua decisão.</span></div><div><button data-mcp-deny="${escapeHtml(approval.id)}">Rejeitar</button><button class="primary" data-mcp-approve="${escapeHtml(approval.id)}">Aceitar</button></div></div>`).join('')}</section>` : ''}
      ${artifactIds.length ? `<section class="mcp-artifact-strip"><div class="mcp-section-label">Artifacts</div><div class="mcp-artifact-row">${artifactIds.map((id) => { const info = artifactMetadata(id); return `<button class="mcp-artifact-chip ${selectedArtifactId === id ? 'active' : ''}" data-mcp-artifact="${escapeHtml(id)}"><span></span><b>${escapeHtml(info.label)}</b><small>${escapeHtml(info.meta || id.slice(0, 14))}</small></button>`; }).join('')}</div></section>` : ''}
      <section class="mcp-timeline">
        ${loading ? '<div class="mcp-empty">Carregando ledger operacional…</div>' : timeline.length ? timeline.map(renderEvent).join('') : '<div class="mcp-empty">Nenhum evento corresponde a este filtro.</div>'}
      </section>
    </section>`;
}

async function refresh(): Promise<void> {
  if (!active) return;
  const token = ++refreshSequence;
  loading = true;
  render();
  try {
    const [page, nextApprovals, nextGatewayStatus, nextTunnelStatus] = await Promise.all([
      window.autoCodez.listOperationalLedger({ limit: MAX_RENDERED_EVENTS, direction: 'backward' }),
      window.autoCodez.listApprovals(),
      window.autoCodez.mcpGatewayStatus(),
      window.autoCodez.mcpTunnelStatus(),
    ]);
    if (!active || token !== refreshSequence) return;
    events = page.events.map(asLedgerEvent).filter((event): event is LedgerEvent => Boolean(event)).reverse();
    approvals = nextApprovals as Approval[];
    gatewayStatus = nextGatewayStatus as GatewayStatus;
    tunnelStatus = nextTunnelStatus as TunnelStatus;
    if (!gatewayStatus.running) gatewayToken = '';
    if (selectedScope && !events.some((event) => scopeKey(event) === selectedScope)) selectedScope = '';
  } finally {
    if (token === refreshSequence) {
      loading = false;
      render();
    }
  }
}

function show(): void {
  active = true;
  document.body.classList.add('mcp-mode-active');
  document.querySelectorAll('.rail-button').forEach((button) => button.classList.toggle('active', button.hasAttribute('data-mcp-mode')));
  const root = document.getElementById(rootId);
  if (root) root.hidden = false;
  void refresh();
}

function hide(): void {
  if (!active) return;
  active = false;
  refreshSequence += 1;
  document.body.classList.remove('mcp-mode-active');
  const root = document.getElementById(rootId);
  if (root) root.hidden = true;
}

function installStyles(): void {
  if (document.getElementById('mcp-mode-styles')) return;
  const style = document.createElement('style');
  style.id = 'mcp-mode-styles';
  style.textContent = `
    .rail-button[data-mcp-mode]:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 5h16v3H4V5Zm0 5.5h11V14H4v-3.5ZM4 16.5h16V20H4v-3.5Z'/%3E%3C/svg%3E")}
    #${rootId}[hidden]{display:none!important}#${rootId}{position:absolute;inset:0 0 0 58px;z-index:70;display:grid;grid-template-columns:282px minmax(0,1fr);background:#090c11;color:#dce3ec}
    .body{position:relative}.mcp-mode-sidebar{min-width:0;border-right:1px solid #1b222c;background:#0c1016;padding:17px 10px;overflow:auto}.mcp-mode-sidebar-head{padding:0 9px 12px;display:flex;flex-direction:column;gap:4px}.mcp-mode-sidebar-head strong{font-size:13px}.mcp-mode-kicker,.mcp-section-label{font-size:8px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#657181}
    .mcp-session-list{margin-top:3px}.mcp-session-item{width:100%;display:grid;grid-template-columns:8px minmax(0,1fr);gap:9px;align-items:center;text-align:left;padding:9px;border:1px solid transparent;border-radius:8px;color:#9ba6b5}.mcp-session-item:hover,.mcp-session-item.active{background:#141a22;border-color:#232c38;color:#e9edf3}.mcp-session-item strong,.mcp-session-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mcp-session-item strong{font-size:10px;font-weight:600}.mcp-session-item small{margin-top:3px;font-size:8px;color:#687486}.mcp-session-led,.mcp-live-dot{display:block;border-radius:50%;background:#566273}.mcp-session-led{width:6px;height:6px}.mcp-live-dot{width:7px;height:7px}.state-running{--mcp-state:#69a7ff}.state-success{--mcp-state:#6fd49a}.state-failed{--mcp-state:#e87f87}.state-waiting,.state-pending{--mcp-state:#ddb86c}.state-cancelled{--mcp-state:#778191}.mcp-session-led[class*="state-"],.mcp-live-dot[class*="state-"]{background:var(--mcp-state,#566273)}
    .mcp-mode-main{min-width:0;display:flex;flex-direction:column;overflow:hidden}.mcp-mode-header{height:69px;flex:none;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1b222c;background:#0a0e13}.mcp-mode-title-row{display:flex;align-items:center;gap:8px}.mcp-mode-title-row h1{margin:0;font-size:14px;font-weight:650}.mcp-header-state{padding:4px 7px;border:1px solid #283343;border-radius:999px;color:#8d99aa;font-size:8px}.mcp-mode-subtitle{margin-top:5px;color:#667283;font-size:8px}.mcp-header-actions{display:flex;gap:7px}.mcp-refresh-button,.mcp-stop-button{height:30px;padding:0 10px;border:1px solid #293341;border-radius:7px;color:#9ca8b8;font-size:9px;background:#11161d}.mcp-refresh-button:hover{color:#eef2f7;border-color:#3b4859}.mcp-stop-button{border-color:#57333a;color:#d58a91;background:#1b1013}.mcp-stop-button:hover{border-color:#7b454f;color:#f0a8af}
    .mcp-mode-toolbar{height:47px;flex:none;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #171e27}.mcp-gateway-card{flex:none;margin:12px 24px 0;padding:11px 12px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #24303d;border-radius:9px;background:#0d131a}.mcp-gateway-card.running{border-color:#2e493d;background:#0e1714}.mcp-gateway-copy{min-width:0}.mcp-gateway-copy strong,.mcp-gateway-copy span,.mcp-gateway-copy code,.mcp-gateway-copy small{display:block}.mcp-gateway-copy strong{margin-top:4px;font-size:10px}.mcp-gateway-copy span,.mcp-gateway-copy small{margin-top:3px;color:#6e7a8a;font-size:8px}.mcp-gateway-copy code{margin-top:6px;max-width:640px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#90a8bf;font:8px/1.4 Consolas,monospace}.mcp-gateway-actions{display:flex;gap:6px;flex:none}.mcp-gateway-actions button{height:29px;padding:0 9px;border:1px solid #304052;border-radius:6px;color:#9bacbf;font-size:8px}.mcp-gateway-actions button.primary{border-color:#365b49;color:#9dd3b4;background:#102019}.mcp-gateway-actions button.danger{border-color:#59343a;color:#d28c93;background:#1a1012}.mcp-tunnel-card{flex:none;margin:8px 24px 0;padding:11px 12px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #202a36;border-radius:9px;background:#0c1117}.mcp-tunnel-card.running,.mcp-tunnel-card.ready{border-color:#34485b}.mcp-tunnel-card.ready{background:#0d1715;border-color:#315142}.mcp-tunnel-copy{min-width:0;flex:1}.mcp-tunnel-copy strong,.mcp-tunnel-copy span,.mcp-tunnel-copy small{display:block}.mcp-tunnel-copy strong{margin-top:4px;font-size:10px}.mcp-tunnel-copy span,.mcp-tunnel-copy small{margin-top:3px;color:#6e7a8a;font-size:8px}.mcp-tunnel-error{margin-top:6px;color:#d58a91;font-size:8px}.mcp-tunnel-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:58%}.mcp-tunnel-controls input{height:29px;min-width:132px;padding:0 8px;border:1px solid #293746;border-radius:6px;background:#0a0f15;color:#aab5c4;font-size:8px;outline:none}.mcp-tunnel-controls input:focus{border-color:#45627f}.mcp-tunnel-controls button{height:29px;padding:0 9px;border:1px solid #304052;border-radius:6px;color:#9bacbf;font-size:8px}.mcp-tunnel-controls button.primary{border-color:#365b49;color:#9dd3b4;background:#102019}.mcp-tunnel-controls button.danger{border-color:#59343a;color:#d28c93;background:#1a1012}.mcp-tunnel-controls button:disabled{opacity:.45;cursor:not-allowed}.mcp-filter-group{display:flex;gap:4px}.mcp-filter{padding:6px 9px;border-radius:6px;color:#6d7888;font-size:9px}.mcp-filter:hover,.mcp-filter.active{background:#151b23;color:#dce3ec}.mcp-mode-count{font-size:8px;color:#5d6877}
    .mcp-approval-stack,.mcp-artifact-strip{flex:none;padding:13px 24px;border-bottom:1px solid #171e27}.mcp-approval-stack{display:flex;flex-direction:column;gap:7px}.mcp-approval-card{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 11px;border:1px solid #594b2b;border-radius:8px;background:#18150d}.mcp-approval-card strong,.mcp-approval-card span{display:block}.mcp-approval-card strong{font-size:10px}.mcp-approval-card span{margin-top:3px;color:#93866a;font-size:8px}.mcp-approval-card>div:last-child{display:flex;gap:5px}.mcp-approval-card button{padding:6px 9px;border:1px solid #3a3426;border-radius:6px;color:#b3a88d;font-size:8px}.mcp-approval-card button.primary{background:#6e5722;border-color:#8d7132;color:#fff2c9}
    .mcp-artifact-strip{display:flex;flex-direction:column;gap:8px}.mcp-artifact-row{display:flex;gap:6px;overflow:auto}.mcp-artifact-chip{display:grid;grid-template-columns:8px auto;grid-template-rows:auto auto;column-gap:6px;flex:none;padding:7px 9px;border:1px solid #263141;border-radius:7px;color:#8794a6;background:#10151c;text-align:left}.mcp-artifact-chip.active{border-color:#496584;background:#131d28}.mcp-artifact-chip span{grid-row:1/3;width:8px;height:8px;margin-top:2px;border-radius:2px;background:#53657b}.mcp-artifact-chip b{font-size:8px;font-weight:600;color:#a8b4c4}.mcp-artifact-chip small{font:7px/1.2 Consolas,monospace;color:#617084}
    .mcp-timeline{min-height:0;flex:1;overflow:auto;padding:20px 24px 50px}.mcp-event{position:relative;margin:0 0 8px;padding:0 12px 10px 20px;border:1px solid #1c2530;border-radius:8px;background:#0e1319}.mcp-event-toggle{display:block;width:100%;padding:10px 0 0;text-align:left;color:inherit}.mcp-event.expanded{border-color:#2d3948;background:#10161e}.mcp-event:before{content:"";position:absolute;left:9px;top:14px;bottom:-14px;width:1px;background:#1c2631}.mcp-event:last-child:before{display:none}.mcp-event-line{display:flex;align-items:center;gap:8px;min-width:0}.mcp-event-dot{position:absolute;left:6px;top:13px;width:7px;height:7px;border-radius:50%;background:var(--mcp-state,#536071);box-shadow:0 0 0 3px #0e1319}.mcp-event-time{font:8px/1 Consolas,monospace;color:#596474}.mcp-event-meta{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#748194;font-size:8px}.mcp-event-state{font-size:8px;color:var(--mcp-state,#718096)}.mcp-event-summary{margin-top:7px;color:#d7dde6;font-size:10px;line-height:1.45}.mcp-event-details{display:flex;gap:7px;flex-wrap:wrap;margin-top:6px}.mcp-event-details span{padding:3px 5px;border-radius:4px;background:#151c24;color:#788597;font-size:8px}.mcp-event-details .mcp-diff{color:#92b7a1}.mcp-event-error{margin-top:7px;padding:7px 8px;border-left:2px solid #a8525a;background:#1a1013;color:#d79096;font:8px/1.5 Consolas,monospace}.mcp-event-expanded{margin:9px 0 0;padding:8px 0 0;border-top:1px solid #1d2732;display:grid;gap:5px}.mcp-event-expanded div{display:grid;grid-template-columns:95px minmax(0,1fr);gap:9px}.mcp-event-expanded span{font-size:7px;color:#596678;text-transform:uppercase;letter-spacing:.08em}.mcp-event-expanded code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f9daf;font:8px/1.4 Consolas,monospace}.mcp-empty{padding:60px 20px;text-align:center;color:#606b79;font-size:9px}
    @media(max-width:900px){#${rootId}{grid-template-columns:220px minmax(0,1fr)}}
  `;
  document.head.appendChild(style);
}

function install(): void {
  const rail = document.querySelector<HTMLElement>('.rail');
  const body = document.querySelector<HTMLElement>('.body');
  const spacer = rail?.querySelector<HTMLElement>('.rail-spacer');
  if (!rail || !body || !spacer || document.querySelector('[data-mcp-mode]')) return;

  installStyles();

  const button = document.createElement('button');
  button.className = 'rail-button';
  button.type = 'button';
  button.setAttribute('data-mcp-mode', '');
  button.title = 'MCP Mode';
  button.setAttribute('aria-label', 'MCP Mode');
  rail.insertBefore(button, spacer);

  const root = document.createElement('section');
  root.id = rootId;
  root.hidden = true;
  root.setAttribute('aria-label', 'MCP Mode');
  body.appendChild(root);

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (active) hide();
    else show();
  });

  rail.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-mcp-mode]')) return;
    if (target.closest('[data-panel],[data-action]')) hide();
  }, true);

  root.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-mcp-tunnel-id]')) tunnelIdDraft = target.value;
    if (target.matches('[data-mcp-tunnel-executable]')) tunnelExecutableDraft = target.value;
  });

  root.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const scope = target.closest<HTMLElement>('[data-mcp-scope]');
    if (scope) {
      selectedScope = scope.dataset.mcpScope ?? '';
      selectedArtifactId = '';
      render();
      return;
    }
    const nextFilter = target.closest<HTMLElement>('[data-mcp-filter]')?.dataset.mcpFilter as ModeFilter | undefined;
    if (nextFilter) {
      filter = nextFilter;
      if (nextFilter !== 'artifacts') selectedArtifactId = '';
      render();
      return;
    }
    const artifact = target.closest<HTMLElement>('[data-mcp-artifact]')?.dataset.mcpArtifact;
    if (artifact) {
      selectedArtifactId = selectedArtifactId === artifact ? '' : artifact;
      filter = selectedArtifactId ? 'artifacts' : filter;
      render();
      return;
    }
    const expand = target.closest<HTMLElement>('[data-mcp-expand]')?.dataset.mcpExpand;
    if (expand) {
      if (expandedEvents.has(expand)) expandedEvents.delete(expand);
      else expandedEvents.add(expand);
      render();
      return;
    }
    const stopChat = target.closest<HTMLElement>('[data-mcp-stop]')?.dataset.mcpStop;
    if (stopChat) {
      await window.autoCodez.stopChat(stopChat).catch((): undefined => undefined);
      await refresh();
      return;
    }
    if (target.closest('[data-mcp-tunnel-doctor]')) {
      tunnelError = '';
      const executable = tunnelExecutableDraft.trim();
      try {
        const result = await window.autoCodez.doctorMcpTunnel(executable ? { executable } : undefined);
        tunnelDoctorResult = `Doctor OK · ${result.executable} · v${result.version}`;
      } catch (error) {
        tunnelDoctorResult = '';
        tunnelError = error instanceof Error ? error.message : String(error);
      }
      render();
      return;
    }
    if (target.closest('[data-mcp-tunnel-start]')) {
      tunnelError = '';
      const tunnelIdInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-id]');
      const executableInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-executable]');
      const keyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
      const tunnelId = (tunnelIdInput?.value ?? tunnelIdDraft).trim();
      const executable = (executableInput?.value ?? tunnelExecutableDraft).trim();
      tunnelIdDraft = tunnelId;
      tunnelExecutableDraft = executable;
      let controlPlaneApiKey = keyInput?.value ?? '';
      if (keyInput) keyInput.value = '';
      try {
        await window.autoCodez.startMcpTunnel({
          tunnelId,
          ...(executable ? { executable } : {}),
          ...(controlPlaneApiKey.trim() ? { controlPlaneApiKey } : {}),
        });
        tunnelDoctorResult = '';
      } catch (error) {
        tunnelError = error instanceof Error ? error.message : String(error);
      } finally {
        controlPlaneApiKey = '';
      }
      await refresh();
      return;
    }
    if (target.closest('[data-mcp-tunnel-stop]')) {
      tunnelError = '';
      await window.autoCodez.stopMcpTunnel().catch((error: unknown) => {
        tunnelError = error instanceof Error ? error.message : String(error);
      });
      await refresh();
      return;
    }
    if (target.closest('[data-mcp-gateway-toggle]')) {
      if (gatewayStatus.running) {
        await window.autoCodez.stopMcpGateway();
        gatewayToken = '';
      } else {
        const started = await window.autoCodez.startMcpGateway();
        gatewayStatus = { running: true, host: started.host, port: started.port, endpoint: started.endpoint };
        gatewayToken = started.bearerToken;
      }
      await refresh();
      return;
    }
    if (target.closest('[data-mcp-copy-gateway]') && gatewayStatus.running && gatewayToken) {
      const value = `Endpoint: ${gatewayStatus.endpoint}\nAuthorization: Bearer ${gatewayToken}`;
      await navigator.clipboard.writeText(value).catch((): undefined => undefined);
      return;
    }
    if (target.closest('[data-mcp-refresh]')) {
      await refresh();
      return;
    }
    const approve = target.closest<HTMLElement>('[data-mcp-approve]')?.dataset.mcpApprove;
    if (approve) {
      await window.autoCodez.approveTool(approve).catch((): undefined => undefined);
      await refresh();
      return;
    }
    const deny = target.closest<HTMLElement>('[data-mcp-deny]')?.dataset.mcpDeny;
    if (deny) {
      await window.autoCodez.denyTool(deny).catch((): undefined => undefined);
      await refresh();
    }
  });

  unsubscribeLedger = window.autoCodez.onOperationalLedgerEvent((value) => {
    const event = asLedgerEvent(value);
    if (!event) return;
    events = [...events.filter((item) => item.eventId !== event.eventId), event]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_RENDERED_EVENTS);
    if (!active) return;
    if (event.state === 'waiting' || event.category === 'approval') {
      void refresh();
      return;
    }
    render();
  });

  window.addEventListener('beforeunload', () => unsubscribeLedger?.(), { once: true });
}

install();

export {};
