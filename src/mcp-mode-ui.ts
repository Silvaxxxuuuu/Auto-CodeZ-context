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
type GatewayPreflight = { ok: true; protocolVersion: string; toolCount: number; writeToolCount: number };
type TunnelStatus = { running: boolean; ready: boolean; version?: string; tunnelId?: string; localEndpoint?: string; healthUrl?: string; error?: string; credentialAvailable: boolean };
type McpRuntimeStatus = { platform: string; arch: string; supported: boolean; ready: boolean; version: string; executable?: string; managed: boolean; error?: string };
type OnboardingStep = 'activation' | 'clients' | 'instructions' | 'operational';
type McpClientId = 'chatgpt' | 'codex' | 'claude-desktop' | 'claude-code' | 'cursor' | 'other';

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
let unsubscribeTunnel: (() => void) | undefined;
let gatewayStatus: GatewayStatus = { running: false, host: '127.0.0.1', port: 0, endpoint: '' };
let gatewayToken = '';
let gatewayPreflight: GatewayPreflight | undefined;
let gatewayPreflightError = '';
let tunnelStatus: TunnelStatus = { running: false, ready: false, credentialAvailable: false };
let tunnelDoctorResult = '';
let tunnelError = '';
let tunnelIdDraft = '';
let tunnelKeyDraft = '';
let refreshSequence = 0;
let runtimeStatus: McpRuntimeStatus = { platform: '', arch: '', supported: true, ready: false, version: '0.0.14', managed: false };
let onboardingStep: OnboardingStep = (() => {
  try { return localStorage.getItem('auto-codez:mcp-onboarding') === 'complete' ? 'operational' : 'activation'; } catch { return 'activation'; }
})();
let activationBusy = false;
let activationMessage = '';
let activationError = '';
const selectedClients = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem('auto-codez:mcp-clients') || '[]') as unknown;
    if (Array.isArray(stored)) {
      const allowed = new Set<McpClientId>(['chatgpt', 'codex', 'claude-desktop', 'claude-code', 'cursor', 'other']);
      const valid = stored.filter((value): value is McpClientId => typeof value === 'string' && allowed.has(value as McpClientId));
      if (valid.length) return new Set<McpClientId>(valid);
    }
  } catch {}
  return new Set<McpClientId>(['chatgpt']);
})();
let showAdvanced = false;

const MCP_CLIENTS: Array<{ id: McpClientId; name: string; detail: string; badge: string }> = [
  { id: 'chatgpt', name: 'ChatGPT', detail: 'Plugin com Secure MCP Tunnel', badge: 'Configuração guiada' },
  { id: 'codex', name: 'ChatGPT Codex', detail: 'MCP local no app, CLI ou extensão', badge: 'Conexão local' },
  { id: 'claude-desktop', name: 'Claude Desktop', detail: 'Integração local MCP no aplicativo', badge: 'Configuração guiada' },
  { id: 'claude-code', name: 'Claude Code', detail: 'MCP local pelo ambiente de desenvolvimento', badge: 'Conexão local' },
  { id: 'cursor', name: 'Cursor', detail: 'Servidor MCP no editor', badge: 'Conexão local' },
  { id: 'other', name: 'Outro cliente MCP', detail: 'Use com clientes compatíveis com MCP', badge: 'Configuração manual' },
];

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
  if (event.chatId?.startsWith('mcp:')) return `chat:${event.chatId}`;
  if (event.sessionId) return `session:${event.sessionId}`;
  if (event.runId) return `run:${event.runId}`;
  if (event.chatId) return `chat:${event.chatId}`;
  return 'global';
}

function isExternalMcpClientId(value: string | undefined): value is string {
  return Boolean(value && value !== 'autocodez-chat' && !value.startsWith('autocodez-'));
}

function mcpActivityEvents(): LedgerEvent[] {
  const direct = events.filter((event) => isExternalMcpClientId(event.clientId));
  if (!direct.length) return [];

  const runIds = new Set(direct.map((event) => event.runId).filter((value): value is string => Boolean(value)));
  const chatIds = new Set(direct.map((event) => event.chatId).filter((value): value is string => Boolean(value)));
  const sessionIds = new Set(direct.map((event) => event.sessionId).filter((value): value is string => Boolean(value)));
  const causationIds = new Set(direct.map((event) => event.causationId).filter((value): value is string => Boolean(value)));
  const toolCallIds = new Set(direct.map((event) => event.toolCallId).filter((value): value is string => Boolean(value)));

  return events.filter((event) =>
    isExternalMcpClientId(event.clientId)
    || Boolean(event.runId && runIds.has(event.runId))
    || Boolean(event.chatId && chatIds.has(event.chatId))
    || Boolean(event.sessionId && sessionIds.has(event.sessionId))
    || Boolean(event.causationId && causationIds.has(event.causationId))
    || Boolean(event.toolCallId && toolCallIds.has(event.toolCallId))
  );
}

function scopeLabel(event: LedgerEvent): string {
  if (isExternalMcpClientId(event.clientId)) return event.clientId;
  const key = scopeKey(event);
  const external = [...events].reverse().find((item) => scopeKey(item) === key && isExternalMcpClientId(item.clientId));
  if (external?.clientId) return external.clientId;
  if (event.pluginId === 'autocodez.roblox-studio-manager') return 'Roblox Studio';
  if (event.providerId) return event.providerId;
  if (event.runId) return 'Execução MCP';
  return 'MCP';
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
  const mcpEvents = mcpActivityEvents();
  let scoped = selectedScope ? mcpEvents.filter((event) => scopeKey(event) === selectedScope) : mcpEvents;
  if (selectedArtifactId) scoped = scoped.filter((event) => event.artifactIds?.includes(selectedArtifactId));
  if (filter === 'errors') return scoped.filter((event) => event.state === 'failed' || Boolean(event.error));
  if (filter === 'artifacts') return scoped.filter((event) => Boolean(event.artifactIds?.length));
  if (filter === 'activity') return scoped.filter((event) => event.category !== 'execution' && event.category !== 'system');
  return scoped;
}

function sessionEntries(): Array<{ key: string; latest: LedgerEvent; count: number }> {
  const grouped = new Map<string, { latest: LedgerEvent; count: number }>();
  for (const event of mcpActivityEvents()) {
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
  const mcpEvents = mcpActivityEvents();
  return selectedScope ? mcpEvents.filter((event) => scopeKey(event) === selectedScope) : mcpEvents;
}

function currentHeader(): { title: string; subtitle: string; state: LedgerState; provider?: string; project?: string; run?: string; chatId?: string; clientId?: string } {
  const scoped = currentEvents();
  const latest = scoped.at(-1);
  const context = [...scoped].reverse().find((event) => event.providerId || event.projectId || event.clientId) ?? latest;
  if (!latest) {
    return { title: 'Nenhuma sessão conectada', subtitle: 'O MCP está pronto. Conecte uma IA para acompanhar a atividade aqui.', state: 'success' };
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
  const scoped = currentEvents();
  const runIds = new Set(scoped.map((event) => event.runId).filter((value): value is string => Boolean(value)));
  const chatIds = new Set(scoped.map((event) => event.chatId).filter((value): value is string => Boolean(value)));
  if (!runIds.size && !chatIds.size) return [];
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
  const event = [...mcpActivityEvents()].reverse().find((item) => item.artifactIds?.includes(id));
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


function persistClientSelection(): void {
  try { localStorage.setItem('auto-codez:mcp-clients', JSON.stringify([...selectedClients])); } catch {}
}

function persistOnboardingComplete(): void {
  try {
    localStorage.setItem('auto-codez:mcp-onboarding', 'complete');
    persistClientSelection();
  } catch {}
}

function renderClientInstructions(client: McpClientId): string {
  if (client === 'chatgpt') {
    return `<article class="mcp-guide-card featured">
      <div class="mcp-guide-head"><span class="mcp-client-mark">C</span><div><strong>ChatGPT</strong><small>Plugin · Secure MCP Tunnel</small></div></div>
      <ol>
        <li>Abra <b>Configurações → Segurança e login</b> e ative <b>Modo de desenvolvedor</b>.</li>
        <li>Abra <b>Plugins</b>, clique em <b>+</b> e crie um novo plugin chamado <b>Auto CodeZ</b>.</li>
        <li>Em <b>Conexão</b>, escolha <b>Túnel</b>. O ChatGPT pedirá um Tunnel ID válido.</li>
        <li>Volte ao Auto CodeZ e abra <b>Configuração avançada</b> somente para informar o Tunnel ID e a chave da sessão. Depois, o Auto CodeZ valida e conecta.</li>
      </ol>
      <div class="mcp-guide-note">O Auto CodeZ cuida do servidor local, runtime e segurança. Você só conclui a autorização que pertence à sua conta do ChatGPT.</div>
    </article>`;
  }
  if (client === 'codex') {
    return `<article class="mcp-guide-card">
      <div class="mcp-guide-head"><span class="mcp-client-mark">X</span><div><strong>ChatGPT Codex</strong><small>App · CLI · extensão</small></div></div>
      <p>O Codex suporta servidores MCP locais. Abra <b>Configurações → Servidores MCP</b>, adicione <b>Auto CodeZ</b> e use a conexão local exibida em <b>Configuração avançada</b>.</p>
      <div class="mcp-copy-line"><code>Use o MCP do Auto CodeZ para trabalhar neste projeto.</code><button data-mcp-copy-text="Use o MCP do Auto CodeZ para trabalhar neste projeto.">Copiar</button></div>
    </article>`;
  }
  if (client === 'claude-desktop') {
    return `<article class="mcp-guide-card"><div class="mcp-guide-head"><span class="mcp-client-mark">A</span><div><strong>Claude Desktop</strong><small>Aplicativo desktop · MCP local</small></div></div><p>Abra as configurações de integrações/extensões do Claude Desktop e adicione o Auto CodeZ como servidor MCP local. O Auto CodeZ manterá os dados técnicos em <b>Configuração avançada</b>.</p><div class="mcp-guide-note">A configuração exata varia conforme a versão do Claude Desktop. O Auto CodeZ não altera sua conta nem instala extensões sem sua confirmação.</div></article>`;
  }
  if (client === 'claude-code') {
    return `<article class="mcp-guide-card"><div class="mcp-guide-head"><span class="mcp-client-mark">CC</span><div><strong>Claude Code</strong><small>MCP local</small></div></div><p>Adicione o servidor MCP do Auto CodeZ nas configurações MCP do Claude Code. Depois peça:</p><div class="mcp-copy-line"><code>Conecte-se ao MCP do Auto CodeZ e use as ferramentas disponíveis.</code><button data-mcp-copy-text="Conecte-se ao MCP do Auto CodeZ e use as ferramentas disponíveis.">Copiar</button></div></article>`;
  }
  if (client === 'cursor') {
    return `<article class="mcp-guide-card"><div class="mcp-guide-head"><span class="mcp-client-mark">⌁</span><div><strong>Cursor</strong><small>Servidor MCP no editor</small></div></div><p>Abra as configurações MCP do Cursor, adicione <b>Auto CodeZ</b> e use a conexão local mostrada em <b>Configuração avançada</b>.</p></article>`;
  }
  return `<article class="mcp-guide-card"><div class="mcp-guide-head"><span class="mcp-client-mark">M</span><div><strong>Outro cliente MCP</strong><small>Configuração manual</small></div></div><p>Adicione um servidor MCP usando os dados de conexão local mostrados em <b>Configuração avançada</b>. Se o seu cliente exigir um formato específico, consulte a documentação dele.</p></article>`;
}

function renderOnboarding(root: HTMLElement): void {
  if (onboardingStep === 'activation') {
    const platform = runtimeStatus.platform ? `${escapeHtml(runtimeStatus.platform)} · ${escapeHtml(runtimeStatus.arch)}` : 'Seu computador';
    root.innerHTML = `<section class="mcp-onboarding">
      <div class="mcp-onboarding-glow"></div>
      <div class="mcp-onboarding-card">
        <div class="mcp-onboarding-icon"><span></span><span></span><span></span></div>
        <div class="mcp-onboarding-kicker">AUTO CODEZ · MCP</div>
        <h1>O modo MCP não está ativado.</h1>
        <p>Conecte ChatGPT, Codex, Claude e outros clientes ao Auto CodeZ. A preparação local é automática e mantém operações sensíveis sob sua aprovação.</p>
        <div class="mcp-onboarding-points"><span>✓ Detecta ${platform}</span><span>✓ Prepara dependências</span><span>✓ Mantém writes sob aprovação</span></div>
        ${activationMessage ? `<div class="mcp-onboarding-progress"><span></span>${escapeHtml(activationMessage)}</div>` : ''}
        ${activationError ? `<div class="mcp-onboarding-error">${escapeHtml(activationError)}</div>` : ''}
        <button class="mcp-onboarding-primary" data-mcp-activate ${activationBusy ? 'disabled' : ''}>${activationBusy ? 'Preparando…' : 'Ativar MCP'}</button>
        <small>Nenhuma porta pública é aberta. Configurações técnicas ficam ocultas por padrão.</small>
      </div>
    </section>`;
    return;
  }
  if (onboardingStep === 'clients') {
    root.innerHTML = `<section class="mcp-onboarding">
      <div class="mcp-onboarding-card wide">
        <div class="mcp-ready-mark">✓</div>
        <div class="mcp-onboarding-kicker">MCP PRONTO</div>
        <h1>Onde você quer usar o Auto CodeZ?</h1>
        <p>Escolha um ou mais clientes. Mostraremos somente os passos necessários para cada um.</p>
        <div class="mcp-client-grid">${MCP_CLIENTS.map((client) => `<button class="mcp-client-option ${selectedClients.has(client.id) ? 'selected' : ''}" data-mcp-client="${client.id}"><span class="mcp-client-check">${selectedClients.has(client.id) ? '✓' : ''}</span><span><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(client.detail)}</small></span><em>${escapeHtml(client.badge)}</em></button>`).join('')}</div>
        ${activationMessage ? `<div class="mcp-onboarding-progress"><span></span>${escapeHtml(activationMessage)}</div>` : ''}
        ${activationError ? `<div class="mcp-onboarding-error">${escapeHtml(activationError)}</div>` : ''}
        <div class="mcp-onboarding-actions"><button class="mcp-onboarding-secondary" data-mcp-onboarding-back ${activationBusy ? 'disabled' : ''}>Voltar</button><button class="mcp-onboarding-primary" data-mcp-onboarding-next ${selectedClients.size && !activationBusy ? '' : 'disabled'}>${activationBusy ? 'Preparando…' : 'Avançar'}</button></div>
      </div>
    </section>`;
    return;
  }
  root.innerHTML = `<section class="mcp-onboarding instructions">
    <div class="mcp-instructions-shell">
      <header><div><div class="mcp-onboarding-kicker">ÚLTIMO PASSO</div><h1>Conecte seus clientes</h1><p>Siga os blocos abaixo. Você não precisa entender portas, tokens ou protocolo MCP.</p></div><button class="mcp-onboarding-secondary" data-mcp-advanced>Configuração avançada</button></header>
      <div class="mcp-guide-list">${[...selectedClients].map(renderClientInstructions).join('')}</div>
      ${showAdvanced ? `<section class="mcp-inline-advanced">
        <div><strong>Conexão local</strong><span>${gatewayStatus.running ? escapeHtml(gatewayStatus.endpoint) : 'Gateway não iniciado'}</span>${gatewayPreflight ? `<small>Validado · MCP ${escapeHtml(gatewayPreflight.protocolVersion)} · ${gatewayPreflight.toolCount} tools</small>` : ''}</div>
        <button data-mcp-copy-gateway ${gatewayStatus.running && gatewayToken ? '' : 'disabled'}>Copiar conexão</button>
      </section>` : ''}
      <div class="mcp-onboarding-actions sticky"><button class="mcp-onboarding-secondary" data-mcp-onboarding-clients>Alterar seleção</button><button class="mcp-onboarding-primary" data-mcp-onboarding-finish>Finalizar</button></div>
    </div>
  </section>`;
}

function render(): void {
  const root = document.getElementById(rootId);
  if (!root) return;
  if (onboardingStep !== 'operational') { root.classList.remove('show-advanced'); renderOnboarding(root); return; }
  root.classList.toggle('show-advanced', showAdvanced);
  const sessions = sessionEntries();
  const header = currentHeader();
  const timeline = visibleEvents().slice(-MAX_RENDERED_EVENTS).reverse();
  const artifactIds = artifacts();
  const pending = relevantApprovals();

  root.innerHTML = `
    <aside class="mcp-mode-sidebar">
      <div class="mcp-mode-sidebar-head"><span class="mcp-mode-kicker">MCP MODE</span><strong>Sessões</strong></div>
      ${sessions.length ? `<button class="mcp-session-item ${selectedScope === '' ? 'active' : ''}" data-mcp-scope="">
        <span class="mcp-session-led"></span><span><strong>Todas as sessões</strong><small>${mcpActivityEvents().length} eventos MCP</small></span>
      </button>
      <div class="mcp-session-list">
        ${sessions.map(({ key, latest, count }) => `<button class="mcp-session-item ${selectedScope === key ? 'active' : ''}" data-mcp-scope="${escapeHtml(key)}">
          <span class="mcp-session-led state-${escapeHtml(latest.state)}"></span>
          <span><strong>${escapeHtml(scopeLabel(latest))}</strong><small>${escapeHtml(latest.runId ? latest.runId.slice(0, 12) : latest.sessionId ? latest.sessionId.slice(0, 12) : 'sessão externa')} · ${count}</small></span>
        </button>`).join('')}
      </div>` : '<div class="mcp-sidebar-empty">Nenhuma IA conectada ainda.</div>'}
    </aside>
    <section class="mcp-mode-main">
      <header class="mcp-mode-header">
        <div>
          <div class="mcp-mode-title-row"><span class="mcp-live-dot state-${escapeHtml(header.state)}"></span><h1>${escapeHtml(header.title)}</h1>${mcpActivityEvents().length ? `<span class="mcp-header-state">${escapeHtml(stateLabel(header.state))}</span>` : ''}</div>
          <div class="mcp-mode-subtitle">${escapeHtml(header.subtitle)}${header.project ? ` · Projeto ${escapeHtml(header.project)}` : ''}${header.run ? ` · ${escapeHtml(header.run.slice(0, 16))}` : ''}</div>
        </div>
        <div class="mcp-header-actions">${header.clientId === 'autocodez-chat' && header.chatId && (header.state === 'running' || header.state === 'waiting' || header.state === 'pending') ? `<button class="mcp-stop-button" type="button" data-mcp-stop="${escapeHtml(header.chatId)}">■ Parar</button>` : ''}<button class="mcp-refresh-button" type="button" data-mcp-clients>Clientes</button><button class="mcp-refresh-button" type="button" data-mcp-advanced>${showAdvanced ? 'Ocultar técnico' : 'Avançado'}</button><button class="mcp-refresh-button" type="button" data-mcp-refresh>Atualizar</button></div>
      </header>
      <div class="mcp-mode-toolbar">
        <div class="mcp-filter-group">
          ${([['all','Tudo'],['activity','Atividade'],['errors','Erros'],['artifacts','Artifacts']] as Array<[ModeFilter,string]>).map(([value,label]) => `<button class="mcp-filter ${filter === value ? 'active' : ''}" data-mcp-filter="${value}">${label}</button>`).join('')}
        </div>
        <div class="mcp-mode-count">${timeline.length} de ${currentEvents().length} eventos</div>
      </div>
      <section class="mcp-connection-summary">
        <span class="mcp-connection-dot ${gatewayStatus.running && gatewayPreflight ? 'ready' : ''}"></span>
        <div><strong>${gatewayStatus.running && gatewayPreflight ? 'MCP ativo e protegido' : 'MCP local indisponível'}</strong><small>${gatewayPreflight ? `${gatewayPreflight.toolCount} ferramentas · ${gatewayPreflight.writeToolCount} com escrita · aprovação local ativa` : 'Abra Avançado para diagnosticar a conexão local.'}</small></div>
        <span class="mcp-connection-client">${tunnelStatus.ready ? 'Tunnel conectado' : 'Aguardando cliente'}</span>
      </section>
      <section class="mcp-gateway-card ${gatewayStatus.running ? 'running' : ''}">
        <div class="mcp-gateway-copy">
          <div class="mcp-section-label">MCP Gateway</div>
          <strong>${gatewayStatus.running ? 'Ativo somente em localhost' : 'Desligado'}</strong>
          <span>${gatewayStatus.running ? `${escapeHtml(gatewayStatus.endpoint)} · MCP 2026-07-28` : 'Nenhuma porta local é aberta até você iniciar explicitamente.'}</span>
          ${gatewayStatus.running && gatewayToken ? `<code>Bearer ${escapeHtml(gatewayToken)}</code>` : gatewayStatus.running ? '<small>Token não é persistido. Reinicie o Gateway para gerar e revelar uma nova credencial.</small>' : ''}
          ${gatewayPreflight ? `<small class="mcp-gateway-preflight-ok">Preflight OK · MCP ${escapeHtml(gatewayPreflight.protocolVersion)} · ${gatewayPreflight.toolCount} tools · ${gatewayPreflight.writeToolCount} write</small>` : ''}
          ${gatewayPreflightError ? `<div class="mcp-gateway-preflight-error">${escapeHtml(gatewayPreflightError)}</div>` : ''}
        </div>
        <div class="mcp-gateway-actions">
          ${gatewayStatus.running ? '<button data-mcp-gateway-preflight>Preflight</button>' : ''}
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
               <input type="password" maxlength="8192" autocomplete="new-password" placeholder="${tunnelStatus.credentialAvailable ? 'Credencial detectada no ambiente' : 'Chave do control plane (somente sessão)'}" data-mcp-tunnel-key aria-label="Chave do control plane">
               <button type="button" data-mcp-tunnel-doctor ${gatewayStatus.running ? '' : 'disabled'}>Doctor real</button>
               <button class="primary" type="button" data-mcp-tunnel-start ${gatewayStatus.running ? '' : 'disabled'}>Conectar</button>`}
        </div>
      </section>
      ${pending.length ? `<section class="mcp-approval-stack"><div class="mcp-section-label">Aguardando aprovação</div>${pending.map((approval) => `<div class="mcp-approval-card"><div><strong>${escapeHtml(approval.toolCall.name)}</strong><span>A execução está pausada até sua decisão.</span></div><div><button data-mcp-deny="${escapeHtml(approval.id)}">Rejeitar</button><button class="primary" data-mcp-approve="${escapeHtml(approval.id)}">Aceitar</button></div></div>`).join('')}</section>` : ''}
      ${artifactIds.length ? `<section class="mcp-artifact-strip"><div class="mcp-section-label">Artifacts</div><div class="mcp-artifact-row">${artifactIds.map((id) => { const info = artifactMetadata(id); return `<button class="mcp-artifact-chip ${selectedArtifactId === id ? 'active' : ''}" data-mcp-artifact="${escapeHtml(id)}"><span></span><b>${escapeHtml(info.label)}</b><small>${escapeHtml(info.meta || id.slice(0, 14))}</small></button>`; }).join('')}</div></section>` : ''}
      <section class="mcp-timeline">
        ${loading ? '<div class="mcp-empty">Carregando sessões MCP…</div>' : timeline.length ? timeline.map(renderEvent).join('') : mcpActivityEvents().length ? '<div class="mcp-empty">Nenhum evento corresponde a este filtro.</div>' : '<div class="mcp-empty mcp-empty-session"><strong>Nenhuma sessão conectada.</strong><span>Quando ChatGPT, Codex ou outro cliente usar o Auto CodeZ, cada ação aparecerá aqui em tempo real.</span></div>'}
      </section>
    </section>`;
  const tunnelKeyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
  if (tunnelKeyInput && tunnelKeyDraft) tunnelKeyInput.value = tunnelKeyDraft;
}

async function ensureOperationalRuntime(): Promise<void> {
  if (!active || onboardingStep !== 'operational' || gatewayStatus.running || activationBusy) return;
  activationBusy = true;
  gatewayPreflightError = '';
  try {
    if (selectedClients.has('chatgpt')) runtimeStatus = await window.autoCodez.prepareMcpRuntime() as McpRuntimeStatus;
    const started = await window.autoCodez.startMcpGateway();
    gatewayStatus = { running: true, host: started.host, port: started.port, endpoint: started.endpoint };
    gatewayToken = started.bearerToken;
    gatewayPreflight = await window.autoCodez.preflightMcpGateway();
  } catch (error) {
    gatewayPreflight = undefined;
    gatewayPreflightError = error instanceof Error ? error.message : String(error);
  } finally {
    activationBusy = false;
    if (active) render();
  }
}

async function refresh(): Promise<void> {
  if (!active) return;
  const token = ++refreshSequence;
  loading = true;
  render();
  try {
    const [page, nextApprovals, nextGatewayStatus, nextTunnelStatus, nextRuntimeStatus] = await Promise.all([
      window.autoCodez.listOperationalLedger({ limit: MAX_RENDERED_EVENTS, direction: 'backward' }),
      window.autoCodez.listApprovals(),
      window.autoCodez.mcpGatewayStatus(),
      window.autoCodez.mcpTunnelStatus(),
      window.autoCodez.mcpRuntimeStatus(),
    ]);
    if (!active || token !== refreshSequence) return;
    events = page.events.map(asLedgerEvent).filter((event): event is LedgerEvent => Boolean(event)).reverse();
    approvals = nextApprovals as Approval[];
    gatewayStatus = nextGatewayStatus as GatewayStatus;
    tunnelStatus = nextTunnelStatus as TunnelStatus;
    runtimeStatus = nextRuntimeStatus as McpRuntimeStatus;
    if (!gatewayStatus.running) {
      gatewayToken = '';
      gatewayPreflight = undefined;
      gatewayPreflightError = '';
    }
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
  void refresh().then(() => ensureOperationalRuntime());
}

function hide(): void {
  if (!active) return;
  tunnelKeyDraft = '';
  const root = document.getElementById(rootId);
  const tunnelKeyInput = root?.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
  if (tunnelKeyInput) tunnelKeyInput.value = '';
  active = false;
  refreshSequence += 1;
  document.body.classList.remove('mcp-mode-active');
  const rootAfterHide = document.getElementById(rootId);
  if (rootAfterHide) rootAfterHide.hidden = true;
}

function installStyles(): void {
  if (document.getElementById('mcp-mode-styles')) return;
  const style = document.createElement('style');
  style.id = 'mcp-mode-styles';
  style.textContent = `
    .mcp-onboarding{grid-column:1/-1;position:relative;min-width:0;min-height:0;display:grid;place-items:center;overflow:auto;padding:42px;background:radial-gradient(circle at 50% 18%,#122238 0,#0b1119 30%,#080b10 72%)}.mcp-onboarding-glow{position:absolute;width:520px;height:260px;top:6%;left:50%;transform:translateX(-50%);background:radial-gradient(ellipse,#3478d522,transparent 68%);pointer-events:none}.mcp-onboarding-card{position:relative;width:min(590px,92vw);padding:38px 42px;border:1px solid #253140;border-radius:22px;background:linear-gradient(145deg,rgba(17,23,32,.98),rgba(10,14,20,.98));box-shadow:0 34px 90px #0008;text-align:center}.mcp-onboarding-card.wide{width:min(900px,94vw)}.mcp-onboarding-icon{width:62px;height:62px;margin:0 auto 20px;border:1px solid #33445a;border-radius:19px;background:linear-gradient(145deg,#172233,#101720);display:flex;align-items:center;justify-content:center;gap:5px;box-shadow:0 14px 40px #0005}.mcp-onboarding-icon span{width:7px;height:7px;border-radius:50%;background:#72a9f2;box-shadow:0 0 18px #4c91ef}.mcp-onboarding-kicker{font-size:9px;font-weight:750;letter-spacing:.18em;color:#718197}.mcp-onboarding h1{margin:9px 0 0;font-size:27px;letter-spacing:-.035em;font-weight:650;color:#f1f4f8}.mcp-onboarding p{max-width:610px;margin:12px auto 0;color:#7f8b9b;font-size:11px;line-height:1.75}.mcp-onboarding-points{display:flex;justify-content:center;gap:9px;flex-wrap:wrap;margin:22px 0}.mcp-onboarding-points span{padding:7px 10px;border:1px solid #243140;border-radius:999px;background:#0d141c;color:#8190a3;font-size:9px}.mcp-onboarding-primary,.mcp-onboarding-secondary{height:38px;padding:0 17px;border-radius:9px;font-size:10px;font-weight:650}.mcp-onboarding-primary{border:1px solid #4287e1;background:linear-gradient(180deg,#3c83df,#2f70ca);color:white;box-shadow:0 9px 25px #245b9c33}.mcp-onboarding-primary:hover:not(:disabled){background:linear-gradient(180deg,#4a91eb,#377bd3);transform:translateY(-1px)}.mcp-onboarding-primary:disabled{opacity:.4}.mcp-onboarding-secondary{border:1px solid #293544;background:#101720;color:#96a3b3}.mcp-onboarding-card>small{display:block;margin-top:14px;color:#4f5b6a;font-size:8px}.mcp-onboarding-progress,.mcp-onboarding-error{margin:18px auto 0;padding:10px 12px;border-radius:9px;font-size:9px;text-align:left}.mcp-onboarding-progress{border:1px solid #29415f;background:#0c1724;color:#8eacd0}.mcp-onboarding-progress span{display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;background:#4f9cff;box-shadow:0 0 0 4px #4f9cff18}.mcp-onboarding-error{border:1px solid #553139;background:#1a1013;color:#d99098}.mcp-ready-mark{width:42px;height:42px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:#10251c;border:1px solid #315a45;color:#77d39e;font-size:18px}.mcp-client-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:26px;text-align:left}.mcp-client-option{min-height:78px;display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:10px;padding:13px;border:1px solid #202b38;border-radius:12px;background:#0c1219;color:#a7b1bf}.mcp-client-option:hover{border-color:#34455a;background:#101923}.mcp-client-option.selected{border-color:#356da9;background:linear-gradient(145deg,#102239,#0d1825);box-shadow:inset 0 0 0 1px #3a7bc722}.mcp-client-check{width:19px;height:19px;border:1px solid #38485c;border-radius:6px;display:grid;place-items:center;color:#fff;background:#0a1016;font-size:10px}.mcp-client-option.selected .mcp-client-check{background:#3478d5;border-color:#4a91eb}.mcp-client-option strong,.mcp-client-option small{display:block}.mcp-client-option strong{font-size:11px;color:#e3e8ef}.mcp-client-option small{margin-top:4px;font-size:8px;color:#687688}.mcp-client-option em{font-style:normal;font-size:7px;padding:4px 6px;border-radius:999px;background:#141c26;color:#738196}.mcp-onboarding-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.mcp-instructions-shell{width:min(920px,94vw);margin:auto;padding:8px 0 30px}.mcp-instructions-shell>header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:18px}.mcp-instructions-shell>header h1{text-align:left}.mcp-instructions-shell>header p{text-align:left;margin-left:0}.mcp-guide-list{display:flex;flex-direction:column;gap:10px}.mcp-guide-card{padding:18px 20px;border:1px solid #202b38;border-radius:14px;background:linear-gradient(145deg,#0f151d,#0b1016);text-align:left}.mcp-guide-card.featured{border-color:#2d4563;background:linear-gradient(145deg,#111c2a,#0c131c)}.mcp-guide-head{display:flex;align-items:center;gap:11px}.mcp-guide-head strong,.mcp-guide-head small{display:block}.mcp-guide-head strong{font-size:12px;color:#e8edf3}.mcp-guide-head small{margin-top:3px;font-size:8px;color:#687688}.mcp-client-mark{width:30px;height:30px;border:1px solid #314054;border-radius:9px;display:grid;place-items:center;background:#121a24;color:#9fb4ce;font-size:9px;font-weight:750}.mcp-guide-card ol{margin:15px 0 0;padding-left:18px;color:#8c98a8;font-size:10px;line-height:1.75}.mcp-guide-card li+li{margin-top:5px}.mcp-guide-card b{color:#dce4ed}.mcp-guide-note{margin-top:13px;padding:10px 11px;border-left:2px solid #3b78bf;background:#0c1622;color:#71849b;font-size:9px;line-height:1.6}.mcp-copy-line{display:flex;align-items:center;gap:8px;margin-top:12px}.mcp-copy-line code{flex:1;padding:9px 10px;border:1px solid #24303d;border-radius:8px;background:#090e14;color:#94a8bf;font-size:9px}.mcp-copy-line button,.mcp-inline-advanced button{height:31px;padding:0 10px;border:1px solid #2f4053;border-radius:7px;color:#9fb0c4;background:#101720;font-size:8px}.mcp-inline-advanced{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px;padding:14px;border:1px solid #2b3948;border-radius:12px;background:#0a1118;text-align:left}.mcp-inline-advanced strong,.mcp-inline-advanced span,.mcp-inline-advanced small{display:block}.mcp-inline-advanced strong{font-size:10px}.mcp-inline-advanced span{margin-top:4px;color:#8090a3;font-size:9px;font-family:Consolas,monospace}.mcp-inline-advanced small{margin-top:4px;color:#6d9b7f;font-size:8px}@media(max-width:820px){.mcp-client-grid{grid-template-columns:1fr}.mcp-onboarding{padding:20px}.mcp-onboarding-card{padding:28px 22px}.mcp-instructions-shell>header{align-items:flex-start;flex-direction:column}}
    .rail-button[data-mcp-mode]:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 18h6'/%3E%3Cpath d='M6 18h.01'/%3E%3Cpath d='M8 6h1'/%3E%3Crect x='2' y='14' width='20' height='8' rx='2'/%3E%3Crect x='4' y='2' width='16' height='12' rx='2'/%3E%3C/svg%3E")}
    #${rootId}[hidden]{display:none!important}#${rootId}{position:absolute;inset:0 0 0 58px;z-index:70;display:grid;grid-template-columns:282px minmax(0,1fr);background:#090c11;color:#dce3ec}
    .body{position:relative}.mcp-mode-sidebar{min-width:0;border-right:1px solid #1b222c;background:#0c1016;padding:17px 10px;overflow:auto}.mcp-mode-sidebar-head{padding:0 9px 12px;display:flex;flex-direction:column;gap:4px}.mcp-mode-sidebar-head strong{font-size:13px}.mcp-mode-kicker,.mcp-section-label{font-size:8px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#657181}
    .mcp-sidebar-empty{margin:12px 8px;padding:12px;border:1px dashed #202b38;border-radius:9px;color:#5e6b7b;font-size:9px;line-height:1.5}.mcp-empty-session strong,.mcp-empty-session span{display:block}.mcp-empty-session strong{font-size:12px;color:#9eabba}.mcp-empty-session span{max-width:420px;margin:7px auto 0;color:#657284;font-size:9px;line-height:1.6}.mcp-session-list{margin-top:3px}.mcp-session-item{width:100%;display:grid;background:transparent;grid-template-columns:8px minmax(0,1fr);gap:9px;align-items:center;text-align:left;padding:9px;border:1px solid transparent;border-radius:8px;color:#9ba6b5}.mcp-session-item:hover,.mcp-session-item.active{background:#141a22;border-color:#232c38;color:#e9edf3}.mcp-session-item strong,.mcp-session-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mcp-session-item strong{font-size:10px;font-weight:600}.mcp-session-item small{margin-top:3px;font-size:8px;color:#687486}.mcp-session-led,.mcp-live-dot{display:block;border-radius:50%;background:#566273}.mcp-session-led{width:6px;height:6px}.mcp-live-dot{width:7px;height:7px}.state-running{--mcp-state:#69a7ff}.state-success{--mcp-state:#6fd49a}.state-failed{--mcp-state:#e87f87}.state-waiting,.state-pending{--mcp-state:#ddb86c}.state-cancelled{--mcp-state:#778191}.mcp-session-led[class*="state-"],.mcp-live-dot[class*="state-"]{background:var(--mcp-state,#566273)}
    .mcp-mode-main{min-width:0;display:flex;flex-direction:column;overflow:hidden}.mcp-mode-header{height:69px;flex:none;padding:0 26px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1b222c;background:#0a0e13}.mcp-mode-title-row{display:flex;align-items:center;gap:8px}.mcp-mode-title-row h1{margin:0;font-size:14px;font-weight:650}.mcp-header-state{padding:4px 7px;border:1px solid #283343;border-radius:999px;color:#8d99aa;font-size:8px}.mcp-mode-subtitle{margin-top:5px;color:#667283;font-size:8px}.mcp-header-actions{display:flex;gap:7px}.mcp-refresh-button,.mcp-stop-button{height:30px;padding:0 10px;border:1px solid #293341;border-radius:7px;color:#9ca8b8;font-size:9px;background:#11161d}.mcp-refresh-button:hover{color:#eef2f7;border-color:#3b4859}.mcp-stop-button{border-color:#57333a;color:#d58a91;background:#1b1013}.mcp-stop-button:hover{border-color:#7b454f;color:#f0a8af}
    .mcp-mode-toolbar{height:47px;flex:none;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #171e27}.mcp-connection-summary{flex:none;margin:12px 24px 0;padding:12px 14px;display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid #213043;border-radius:10px;background:linear-gradient(145deg,#0e151e,#0b1118)}.mcp-connection-dot{width:7px;height:7px;border-radius:50%;background:#667181}.mcp-connection-dot.ready{background:#66d091;box-shadow:0 0 0 4px #66d09112}.mcp-connection-summary strong,.mcp-connection-summary small{display:block}.mcp-connection-summary strong{font-size:10px;color:#dce4ee}.mcp-connection-summary small{margin-top:3px;color:#687688;font-size:8px}.mcp-connection-client{padding:5px 8px;border:1px solid #293849;border-radius:999px;color:#7f8fa3;font-size:8px}.mcp-gateway-card,.mcp-tunnel-card{display:none!important}#${rootId}.show-advanced .mcp-gateway-card,#${rootId}.show-advanced .mcp-tunnel-card{display:flex!important}.mcp-gateway-card{flex:none;margin:12px 24px 0;padding:11px 12px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #24303d;border-radius:9px;background:#0d131a}.mcp-gateway-card.running{border-color:#2e493d;background:#0e1714}.mcp-gateway-copy{min-width:0}.mcp-gateway-copy strong,.mcp-gateway-copy span,.mcp-gateway-copy code,.mcp-gateway-copy small{display:block}.mcp-gateway-preflight-ok{color:#79b997!important}.mcp-gateway-preflight-error{margin-top:6px;color:#d58a91;font-size:8px}.mcp-gateway-copy strong{margin-top:4px;font-size:10px}.mcp-gateway-copy span,.mcp-gateway-copy small{margin-top:3px;color:#6e7a8a;font-size:8px}.mcp-gateway-copy code{margin-top:6px;max-width:640px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#90a8bf;font:8px/1.4 Consolas,monospace}.mcp-gateway-actions{display:flex;gap:6px;flex:none}.mcp-gateway-actions button{height:29px;padding:0 9px;border:1px solid #304052;border-radius:6px;background:#101720;color:#9bacbf;font-size:8px}.mcp-gateway-actions button.primary{border-color:#365b49;color:#9dd3b4;background:#102019}.mcp-gateway-actions button.danger{border-color:#59343a;color:#d28c93;background:#1a1012}.mcp-tunnel-card{flex:none;margin:8px 24px 0;padding:11px 12px;display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #202a36;border-radius:9px;background:#0c1117}.mcp-tunnel-card.running,.mcp-tunnel-card.ready{border-color:#34485b}.mcp-tunnel-card.ready{background:#0d1715;border-color:#315142}.mcp-tunnel-copy{min-width:0;flex:1}.mcp-tunnel-copy strong,.mcp-tunnel-copy span,.mcp-tunnel-copy small{display:block}.mcp-tunnel-copy strong{margin-top:4px;font-size:10px}.mcp-tunnel-copy span,.mcp-tunnel-copy small{margin-top:3px;color:#6e7a8a;font-size:8px}.mcp-tunnel-error{margin-top:6px;color:#d58a91;font-size:8px}.mcp-tunnel-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:58%}.mcp-tunnel-controls input{height:29px;min-width:132px;padding:0 8px;border:1px solid #293746;border-radius:6px;background:#0a0f15;color:#aab5c4;font-size:8px;outline:none}.mcp-tunnel-controls input:focus{border-color:#45627f}.mcp-tunnel-controls button{height:29px;padding:0 9px;border:1px solid #304052;border-radius:6px;background:#101720;color:#9bacbf;font-size:8px}.mcp-tunnel-controls button.primary{border-color:#365b49;color:#9dd3b4;background:#102019}.mcp-tunnel-controls button.danger{border-color:#59343a;color:#d28c93;background:#1a1012}.mcp-tunnel-controls button:disabled{opacity:.45;cursor:not-allowed}.mcp-filter-group{display:flex;gap:4px}.mcp-filter{padding:6px 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:#6d7888;font-size:9px}.mcp-filter:hover,.mcp-filter.active{background:#151b23;color:#dce3ec}.mcp-mode-count{font-size:8px;color:#5d6877}
    .mcp-approval-stack,.mcp-artifact-strip{flex:none;padding:13px 24px;border-bottom:1px solid #171e27}.mcp-approval-stack{display:flex;flex-direction:column;gap:7px}.mcp-approval-card{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 11px;border:1px solid #594b2b;border-radius:8px;background:#18150d}.mcp-approval-card strong,.mcp-approval-card span{display:block}.mcp-approval-card strong{font-size:10px}.mcp-approval-card span{margin-top:3px;color:#93866a;font-size:8px}.mcp-approval-card>div:last-child{display:flex;gap:5px}.mcp-approval-card button{padding:6px 9px;border:1px solid #3a3426;border-radius:6px;background:#15120c;color:#b3a88d;font-size:8px}.mcp-approval-card button.primary{background:#6e5722;border-color:#8d7132;color:#fff2c9}
    .mcp-artifact-strip{display:flex;flex-direction:column;gap:8px}.mcp-artifact-row{display:flex;gap:6px;overflow:auto}.mcp-artifact-chip{display:grid;grid-template-columns:8px auto;grid-template-rows:auto auto;column-gap:6px;flex:none;padding:7px 9px;border:1px solid #263141;border-radius:7px;color:#8794a6;background:#10151c;text-align:left}.mcp-artifact-chip.active{border-color:#496584;background:#131d28}.mcp-artifact-chip span{grid-row:1/3;width:8px;height:8px;margin-top:2px;border-radius:2px;background:#53657b}.mcp-artifact-chip b{font-size:8px;font-weight:600;color:#a8b4c4}.mcp-artifact-chip small{font:7px/1.2 Consolas,monospace;color:#617084}
    .mcp-timeline{min-height:0;flex:1;overflow:auto;padding:20px 24px 50px}.mcp-event{position:relative;margin:0 0 8px;padding:0 12px 10px 20px;border:1px solid #1c2530;border-radius:8px;background:#0e1319}.mcp-event-toggle{display:block;width:100%;padding:10px 0 0;border:0;background:transparent;appearance:none;text-align:left;color:inherit;font:inherit}.mcp-event.expanded{border-color:#2d3948;background:#10161e}.mcp-event:before{content:"";position:absolute;left:9px;top:14px;bottom:-14px;width:1px;background:#1c2631}.mcp-event:last-child:before{display:none}.mcp-event-line{display:flex;align-items:center;gap:8px;min-width:0}.mcp-event-dot{position:absolute;left:6px;top:13px;width:7px;height:7px;border-radius:50%;background:var(--mcp-state,#536071);box-shadow:0 0 0 3px #0e1319}.mcp-event-time{font:8px/1 Consolas,monospace;color:#596474}.mcp-event-meta{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#748194;font-size:8px}.mcp-event-state{font-size:8px;color:var(--mcp-state,#718096)}.mcp-event-summary{margin-top:7px;color:#d7dde6;font-size:10px;line-height:1.45}.mcp-event-details{display:flex;gap:7px;flex-wrap:wrap;margin-top:6px}.mcp-event-details span{padding:3px 5px;border-radius:4px;background:#151c24;color:#788597;font-size:8px}.mcp-event-details .mcp-diff{color:#92b7a1}.mcp-event-error{margin-top:7px;padding:7px 8px;border-left:2px solid #a8525a;background:#1a1013;color:#d79096;font:8px/1.5 Consolas,monospace}.mcp-event-expanded{margin:9px 0 0;padding:8px 0 0;border-top:1px solid #1d2732;display:grid;gap:5px}.mcp-event-expanded div{display:grid;grid-template-columns:95px minmax(0,1fr);gap:9px}.mcp-event-expanded span{font-size:7px;color:#596678;text-transform:uppercase;letter-spacing:.08em}.mcp-event-expanded code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f9daf;font:8px/1.4 Consolas,monospace}.mcp-empty{padding:60px 20px;text-align:center;color:#606b79;font-size:9px}
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
    if (target.matches('[data-mcp-tunnel-key]')) tunnelKeyDraft = target.value;
  });

  root.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-mcp-activate]')) {
      activationBusy = true;
      activationError = '';
      activationMessage = 'Verificando seu computador…';
      render();
      try {
        activationMessage = 'Iniciando conexão local segura…';
        render();
        if (!gatewayStatus.running) {
          const started = await window.autoCodez.startMcpGateway();
          gatewayStatus = { running: true, host: started.host, port: started.port, endpoint: started.endpoint };
          gatewayToken = started.bearerToken;
        }
        activationMessage = 'Validando ferramentas MCP…';
        render();
        gatewayPreflight = await window.autoCodez.preflightMcpGateway();
        onboardingStep = 'clients';
        activationMessage = '';
      } catch (error) {
        activationError = error instanceof Error ? error.message : String(error);
        activationMessage = '';
      } finally {
        activationBusy = false;
        render();
      }
      return;
    }
    const client = target.closest<HTMLElement>('[data-mcp-client]')?.dataset.mcpClient as McpClientId | undefined;
    if (client) {
      if (selectedClients.has(client)) selectedClients.delete(client); else selectedClients.add(client);
      persistClientSelection();
      render();
      return;
    }
    if (target.closest('[data-mcp-onboarding-next]') && selectedClients.size) {
      activationError = '';
      if (selectedClients.has('chatgpt')) {
        activationBusy = true;
        activationMessage = 'Preparando a conexão do ChatGPT…';
        render();
        try {
          runtimeStatus = await window.autoCodez.prepareMcpRuntime() as McpRuntimeStatus;
        } catch (error) {
          activationError = error instanceof Error ? error.message : String(error);
          activationMessage = '';
          activationBusy = false;
          render();
          return;
        }
        activationBusy = false;
        activationMessage = '';
      }
      onboardingStep = 'instructions';
      render();
      return;
    }
    if (target.closest('[data-mcp-onboarding-back]')) { onboardingStep = 'activation'; render(); return; }
    if (target.closest('[data-mcp-onboarding-clients]')) { onboardingStep = 'clients'; render(); return; }
    if (target.closest('[data-mcp-onboarding-finish]')) { persistOnboardingComplete(); onboardingStep = 'operational'; render(); return; }
    if (target.closest('[data-mcp-clients]')) { onboardingStep = 'clients'; showAdvanced = false; render(); return; }
    if (target.closest('[data-mcp-advanced]')) { showAdvanced = !showAdvanced; render(); return; }
    const copyText = target.closest<HTMLElement>('[data-mcp-copy-text]')?.dataset.mcpCopyText;
    if (copyText) { await navigator.clipboard.writeText(copyText).catch((): undefined => undefined); return; }
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
      const tunnelIdInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-id]');
      const keyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
      const tunnelId = (tunnelIdInput?.value ?? tunnelIdDraft).trim();
      tunnelIdDraft = tunnelId;
      const controlPlaneApiKey = (keyInput?.value ?? tunnelKeyDraft).trim();
      const request = {
        tunnelId,
        ...(controlPlaneApiKey ? { controlPlaneApiKey } : {}),
      };
      tunnelKeyDraft = '';
      if (keyInput) keyInput.value = '';
      try {
        const result = await window.autoCodez.doctorMcpTunnel(request);
        gatewayPreflight = result.gateway;
        gatewayPreflightError = '';
        const diagnosticTail = result.diagnostics
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-2)
          .join(' · ');
        tunnelDoctorResult = `Gateway OK · MCP ${result.gateway.protocolVersion} · ${result.gateway.toolCount} tools/${result.gateway.writeToolCount} write · Tunnel Doctor OK · ${result.executable} · v${result.version}${diagnosticTail ? ` · ${diagnosticTail}` : ''}`;
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
      const keyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
      const tunnelId = (tunnelIdInput?.value ?? tunnelIdDraft).trim();
      tunnelIdDraft = tunnelId;
      const controlPlaneApiKey = (keyInput?.value ?? tunnelKeyDraft).trim();
      const request = {
        tunnelId,
        ...(controlPlaneApiKey ? { controlPlaneApiKey } : {}),
      };
      tunnelKeyDraft = '';
      if (keyInput) keyInput.value = '';
      try {
        await window.autoCodez.startMcpTunnel(request);
        tunnelDoctorResult = '';
      } catch (error) {
        tunnelError = error instanceof Error ? error.message : String(error);
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
    if (target.closest('[data-mcp-gateway-preflight]')) {
      gatewayPreflightError = '';
      try {
        gatewayPreflight = await window.autoCodez.preflightMcpGateway();
      } catch (error) {
        gatewayPreflight = undefined;
        gatewayPreflightError = error instanceof Error ? error.message : String(error);
      }
      render();
      return;
    }
    if (target.closest('[data-mcp-gateway-toggle]')) {
      if (gatewayStatus.running) {
        await window.autoCodez.stopMcpGateway();
        gatewayToken = '';
        gatewayPreflight = undefined;
        gatewayPreflightError = '';
      } else {
        const started = await window.autoCodez.startMcpGateway();
        gatewayStatus = { running: true, host: started.host, port: started.port, endpoint: started.endpoint };
        gatewayToken = started.bearerToken;
        gatewayPreflightError = '';
        try {
          gatewayPreflight = await window.autoCodez.preflightMcpGateway();
        } catch (error) {
          gatewayPreflight = undefined;
          gatewayPreflightError = error instanceof Error ? error.message : String(error);
        }
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
      tunnelKeyDraft = '';
      const tunnelKeyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
      if (tunnelKeyInput) tunnelKeyInput.value = '';
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

  unsubscribeTunnel = window.autoCodez.onMcpTunnelStatus((status) => {
    tunnelStatus = status as TunnelStatus;
    if (active) render();
  });

  window.addEventListener('beforeunload', () => {
    unsubscribeLedger?.();
    unsubscribeTunnel?.();
  }, { once: true });
}

install();

export {};
