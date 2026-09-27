import './mcp-mode-ui.css';

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
type McpAutoConfigClientId = 'cursor' | 'codex' | 'claude-code';
type McpStoredConnection = { clientId: McpClientId; setupState: 'added' | 'configured'; addedAt: number; updatedAt: number; configuredAt?: number; lastConnectedAt?: number; metadata?: { tunnelId?: string } };
type McpClientConfigStatus = { clientId: McpAutoConfigClientId; state: 'not-configured' | 'configured' | 'conflict' | 'unsupported'; configPath: string; detail: string };

const MAX_RENDERED_EVENTS = 250;
const OPENAI_ICON_URL = new URL('./assets/mcp-clients/openai.svg', import.meta.url).href;
const CLAUDE_ICON_URL = new URL('./assets/mcp-clients/claude.svg', import.meta.url).href;
const CURSOR_ICON_URL = new URL('./assets/mcp-clients/cursor.svg', import.meta.url).href;
const MCP_ICON_URL = new URL('./assets/mcp-clients/model-context-protocol.svg', import.meta.url).href;

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
let selectedConnectionId: McpClientId | '' = '';
let connectPanelOpen = false;
const clientConfigStatuses: Partial<Record<McpAutoConfigClientId, McpClientConfigStatus>> = {};
const clientConfigErrors: Partial<Record<McpAutoConfigClientId, string>> = {};
let clientConfigBusy: McpAutoConfigClientId | '' = '';

const MCP_CLIENTS: Array<{ id: McpClientId; name: string; detail: string; badge: string; description: string; icon: string }> = [
  { id: 'chatgpt', name: 'ChatGPT', detail: 'Secure MCP Tunnel', badge: 'Configuração guiada', description: 'Permite que o ChatGPT use as ferramentas autorizadas do Auto CodeZ com sua aprovação local.', icon: OPENAI_ICON_URL },
  { id: 'codex', name: 'ChatGPT Codex', detail: 'App, CLI ou extensão', badge: 'Conexão local', description: 'Conecte o Codex ao workspace para ler contexto e executar ferramentas MCP autorizadas.', icon: OPENAI_ICON_URL },
  { id: 'claude-desktop', name: 'Claude Desktop', detail: 'Aplicativo desktop', badge: 'Configuração guiada', description: 'Disponibilize as ferramentas do Auto CodeZ para conversas e agentes no Claude Desktop.', icon: CLAUDE_ICON_URL },
  { id: 'claude-code', name: 'Claude Code', detail: 'Ambiente de desenvolvimento', badge: 'Conexão local', description: 'Use o MCP do Auto CodeZ diretamente em tarefas executadas pelo Claude Code.', icon: CLAUDE_ICON_URL },
  { id: 'cursor', name: 'Cursor', detail: 'Editor de código', badge: 'Conexão local', description: 'Conecte o Cursor para usar ferramentas e contexto do Auto CodeZ durante o desenvolvimento.', icon: CURSOR_ICON_URL },
  { id: 'other', name: 'Outro cliente MCP', detail: 'Cliente compatível', badge: 'Configuração manual', description: 'Conecte outro aplicativo compatível com MCP usando a configuração avançada do Auto CodeZ.', icon: MCP_ICON_URL },
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

function renderClientIcon(client: McpClientId, className = 'mcp-client-logo'): string {
  const definition = clientDefinition(client);
  return `<span class="${className}" aria-hidden="true"><img src="${escapeHtml(definition.icon)}" alt="" draggable="false"></span>`;
}

function renderClientInstructions(client: McpClientId): string {
  if (client === 'chatgpt') {
    return `<article class="mcp-guide-card featured">
      <div class="mcp-guide-head">${renderClientIcon('chatgpt', 'mcp-client-mark')}<div><strong>ChatGPT</strong><small>Plugin · Secure MCP Tunnel</small></div></div>
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
    const status = clientConfigStatuses.codex;
    const error = clientConfigErrors.codex;
    return `<article class="mcp-guide-card">
      <div class="mcp-guide-head">${renderClientIcon('codex', 'mcp-client-mark')}<div><strong>ChatGPT Codex</strong><small>App · CLI · extensão</small></div></div>
      ${status?.state === 'configured'
        ? '<p>O Auto CodeZ já está configurado no Codex. App, CLI e extensão usam a mesma configuração MCP global.</p><div class="mcp-guide-note">Configuração concluída automaticamente.</div>'
        : status?.state === 'conflict'
          ? `<p>${escapeHtml(status.detail)}</p><div class="mcp-guide-note">O Auto CodeZ não sobrescreve conexões MCP que não criou.</div>`
          : status?.state === 'unsupported'
            ? '<p>A configuração automática do Codex ainda não está disponível neste sistema. Use a configuração avançada.</p>'
            : `<p>O Auto CodeZ pode adicionar esta conexão ao Codex automaticamente, preservando seu config.toml atual e sem salvar tokens.</p><button class="mcp-primary-action compact" type="button" data-mcp-install-client-config="codex" ${clientConfigBusy ? 'disabled' : ''}>${clientConfigBusy === 'codex' ? 'Configurando…' : 'Configurar automaticamente'}</button>`}
      ${error ? `<div class="mcp-client-config-error">${escapeHtml(error)}</div>` : ''}
    </article>`;
  }
  if (client === 'claude-desktop') {
    return `<article class="mcp-guide-card"><div class="mcp-guide-head">${renderClientIcon('claude-desktop', 'mcp-client-mark')}<div><strong>Claude Desktop</strong><small>Aplicativo desktop · MCP local</small></div></div><p>Abra as configurações de integrações/extensões do Claude Desktop e adicione o Auto CodeZ como servidor MCP local. O Auto CodeZ manterá os dados técnicos em <b>Configuração avançada</b>.</p><div class="mcp-guide-note">A configuração exata varia conforme a versão do Claude Desktop. O Auto CodeZ não altera sua conta nem instala extensões sem sua confirmação.</div></article>`;
  }
  if (client === 'claude-code') {
    const status = clientConfigStatuses['claude-code'];
    const error = clientConfigErrors['claude-code'];
    return `<article class="mcp-guide-card"><div class="mcp-guide-head">${renderClientIcon('claude-code', 'mcp-client-mark')}<div><strong>Claude Code</strong><small>MCP local · escopo de usuário</small></div></div>
      ${status?.state === 'configured'
        ? '<p>O Auto CodeZ já está configurado no Claude Code para este usuário.</p><div class="mcp-guide-note">Configuração concluída automaticamente.</div>'
        : status?.state === 'conflict'
          ? `<p>${escapeHtml(status.detail)}</p><div class="mcp-guide-note">O Auto CodeZ não sobrescreve conexões MCP que não criou.</div>`
          : status?.state === 'unsupported'
            ? '<p>A configuração automática do Claude Code ainda não está disponível neste sistema. Use a configuração avançada.</p>'
            : `<p>O Auto CodeZ pode adicionar esta conexão ao Claude Code automaticamente no escopo de usuário, preservando o restante do ~/.claude.json e sem salvar tokens.</p><button class="mcp-primary-action compact" type="button" data-mcp-install-client-config="claude-code" ${clientConfigBusy ? 'disabled' : ''}>${clientConfigBusy === 'claude-code' ? 'Configurando…' : 'Configurar automaticamente'}</button>`}
      ${error ? `<div class="mcp-client-config-error">${escapeHtml(error)}</div>` : ''}
    </article>`;
  }
  if (client === 'cursor') {
    const status = clientConfigStatuses.cursor;
    const error = clientConfigErrors.cursor;
    return `<article class="mcp-guide-card"><div class="mcp-guide-head">${renderClientIcon('cursor', 'mcp-client-mark')}<div><strong>Cursor</strong><small>Servidor MCP no editor</small></div></div>
      ${status?.state === 'configured'
        ? '<p>O Auto CodeZ já está configurado no Cursor. Se o editor estava aberto, recarregue as integrações MCP.</p><div class="mcp-guide-note">Configuração concluída automaticamente.</div>'
        : status?.state === 'conflict'
          ? `<p>${escapeHtml(status.detail)}</p><div class="mcp-guide-note">O Auto CodeZ não sobrescreve conexões MCP que não criou.</div>`
          : status?.state === 'unsupported'
            ? '<p>A configuração automática do Cursor ainda não está disponível neste sistema. Use a configuração avançada.</p>'
            : `<p>O Auto CodeZ pode adicionar esta conexão ao Cursor automaticamente, sem expor tokens nem pedir edição de arquivos.</p><button class="mcp-primary-action compact" type="button" data-mcp-install-client-config="cursor" ${clientConfigBusy ? 'disabled' : ''}>${clientConfigBusy === 'cursor' ? 'Configurando…' : 'Configurar automaticamente'}</button>`}
      ${error ? `<div class="mcp-client-config-error">${escapeHtml(error)}</div>` : ''}
    </article>`;
  }
  return `<article class="mcp-guide-card"><div class="mcp-guide-head">${renderClientIcon('other', 'mcp-client-mark')}<div><strong>Outro cliente MCP</strong><small>Configuração manual</small></div></div><p>Adicione um servidor MCP usando os dados de conexão local mostrados em <b>Configuração avançada</b>. Se o seu cliente exigir um formato específico, consulte a documentação dele.</p></article>`;
}

function clientDefinition(id: McpClientId) {
  return MCP_CLIENTS.find((client) => client.id === id)!;
}

function eventMatchesClient(event: LedgerEvent, client: McpClientId): boolean {
  const value = `${event.clientId ?? ''} ${event.providerId ?? ''}`.toLowerCase();
  if (!value.trim()) return false;
  if (client === 'chatgpt') return /chatgpt|openai/.test(value);
  if (client === 'codex') return /codex/.test(value);
  if (client === 'claude-desktop') return /claude desktop|claude-desktop/.test(value);
  if (client === 'claude-code') return /claude code|claude-code/.test(value);
  if (client === 'cursor') return /cursor/.test(value);
  return MCP_CLIENTS.every((item) => item.id === 'other' || !eventMatchesClient(event, item.id));
}

function clientEvents(client: McpClientId): LedgerEvent[] {
  return mcpActivityEvents().filter((event) => eventMatchesClient(event, client));
}

function clientSetupSummary(client: McpClientId): string {
  if (client === 'chatgpt') return 'No ChatGPT, crie a conexão Auto CodeZ e escolha Secure MCP Tunnel. Quando ele solicitar o Tunnel ID, use a configuração avançada desta conexão.';
  if (client === 'codex') return 'No Codex, adicione Auto CodeZ em Servidores MCP usando a conexão local exibida na configuração avançada.';
  if (client === 'claude-desktop') return 'No Claude Desktop, adicione Auto CodeZ como servidor MCP local nas configurações de integrações ou extensões.';
  if (client === 'claude-code') return 'No Claude Code, adicione o servidor MCP do Auto CodeZ e use a conexão local exibida na configuração avançada.';
  if (client === 'cursor') return 'No Cursor, adicione Auto CodeZ nas configurações MCP do editor usando a conexão local desta conexão.';
  return 'No cliente MCP escolhido, adicione um servidor usando os dados locais exibidos na configuração avançada.';
}

function clientPublicState(client: McpClientId): { label: string; tone: string; detail: string } {
  const latest = clientEvents(client).at(-1);
  if (latest?.state === 'failed') return { label: 'Precisa de atenção', tone: 'attention', detail: latest.error || latest.summary };
  if (latest?.state === 'running' || latest?.state === 'waiting' || latest?.state === 'pending') {
    return { label: latest.state === 'running' ? 'Em uso agora' : 'Aguardando aprovação', tone: latest.state === 'running' ? 'active' : 'waiting', detail: latest.summary };
  }
  if (latest) return { label: 'Conectado', tone: 'connected', detail: `Última atividade às ${formatTime(latest.timestamp)}` };
  if (client === 'chatgpt' && tunnelStatus.ready) return { label: 'Conectado', tone: 'connected', detail: 'Secure MCP Tunnel pronto' };
  if (gatewayStatus.running && gatewayPreflight) return { label: 'Pronto para conectar', tone: 'ready', detail: `${gatewayPreflight.toolCount} ferramentas disponíveis` };
  return { label: 'Configurado', tone: 'configured', detail: 'Conclua a conexão no aplicativo escolhido' };
}

function renderConnectionCard(client: (typeof MCP_CLIENTS)[number], configured: boolean): string {
  const state = configured ? clientPublicState(client.id) : { label: 'Disponível', tone: 'available', detail: client.detail };
  return `<article class="mcp-connection-card ${configured ? 'configured' : 'available'}" data-mcp-connection-card="${client.id}">
    <div class="mcp-connection-card-top">
      ${renderClientIcon(client.id)}
      <span class="mcp-status-pill ${escapeHtml(state.tone)}"><i></i>${escapeHtml(state.label)}</span>
    </div>
    <div class="mcp-connection-card-copy">
      <h3>${escapeHtml(client.name)}</h3>
      <p>${escapeHtml(client.description)}</p>
    </div>
    <div class="mcp-connection-card-meta"><span>${escapeHtml(state.detail)}</span><span>${escapeHtml(client.badge)}</span></div>
    <div class="mcp-connection-card-actions">
      ${configured
        ? `<button class="mcp-text-action" type="button" data-mcp-open-connection="${client.id}">${state.tone === 'connected' || state.tone === 'active' ? 'Abrir conexão' : state.tone === 'attention' || state.tone === 'waiting' ? 'Revisar conexão' : 'Concluir conexão'}</button>`
        : `<button class="mcp-card-add-action" type="button" data-mcp-connect-client="${client.id}">Adicionar ${escapeHtml(client.name)}</button>`}
    </div>
  </article>`;
}

function renderTechnicalPanels(): string {
  return `<div class="mcp-advanced-stack">
    <section class="mcp-gateway-card ${gatewayStatus.running ? 'running' : ''}">
      <div class="mcp-gateway-copy">
        <div class="mcp-section-label">Gateway local</div>
        <strong>${gatewayStatus.running ? 'Ativo somente neste computador' : 'Desligado'}</strong>
        <span>${gatewayStatus.running ? `${escapeHtml(gatewayStatus.endpoint)} · MCP 2026-07-28` : 'Nenhuma porta local é aberta até você iniciar explicitamente.'}</span>
        ${gatewayStatus.running && gatewayToken ? `<code>Bearer ${escapeHtml(gatewayToken)}</code>` : gatewayStatus.running ? '<small>O token é temporário e não é persistido.</small>' : ''}
        ${gatewayPreflight ? `<small class="mcp-gateway-preflight-ok">Preflight OK · MCP ${escapeHtml(gatewayPreflight.protocolVersion)} · ${gatewayPreflight.toolCount} tools · ${gatewayPreflight.writeToolCount} write</small>` : ''}
        ${gatewayPreflightError ? `<div class="mcp-gateway-preflight-error">${escapeHtml(gatewayPreflightError)}</div>` : ''}
      </div>
      <div class="mcp-gateway-actions">
        ${gatewayStatus.running ? '<button data-mcp-gateway-preflight>Verificar gateway</button>' : ''}
        ${gatewayStatus.running && gatewayToken ? '<button data-mcp-copy-gateway>Copiar conexão local</button>' : ''}
        <button class="${gatewayStatus.running ? 'danger' : 'primary'}" data-mcp-gateway-toggle>${gatewayStatus.running ? 'Desligar gateway' : 'Iniciar gateway local'}</button>
      </div>
    </section>
    <section class="mcp-tunnel-card ${tunnelStatus.ready ? 'ready' : tunnelStatus.running ? 'running' : ''}">
      <div class="mcp-tunnel-copy">
        <div class="mcp-section-label">Secure MCP Tunnel</div>
        <strong>${tunnelStatus.ready ? 'Conectado e pronto' : tunnelStatus.running ? 'Inicializando…' : 'Somente quando necessário'}</strong>
        <span>${tunnelStatus.ready
          ? `${escapeHtml(tunnelStatus.tunnelId || '')}${tunnelStatus.version ? ` · tunnel-client ${escapeHtml(tunnelStatus.version)}` : ''}`
          : 'Use para clientes que precisam alcançar o MCP local por um túnel protegido.'}</span>
        ${tunnelDoctorResult ? `<small>${escapeHtml(tunnelDoctorResult)}</small>` : ''}
        ${tunnelStatus.error || tunnelError ? `<div class="mcp-tunnel-error">${escapeHtml(tunnelStatus.error || tunnelError)}</div>` : ''}
      </div>
      <div class="mcp-tunnel-controls">
        ${tunnelStatus.running
          ? '<button class="danger" type="button" data-mcp-tunnel-stop>Desconectar tunnel</button>'
          : `<input type="text" maxlength="39" autocomplete="off" spellcheck="false" placeholder="Tunnel ID" value="${escapeHtml(tunnelIdDraft)}" data-mcp-tunnel-id aria-label="Tunnel ID">
             <input type="password" maxlength="8192" autocomplete="new-password" placeholder="${tunnelStatus.credentialAvailable ? 'Credencial detectada no ambiente' : 'Chave do control plane'}" data-mcp-tunnel-key aria-label="Chave do control plane">
             <button type="button" data-mcp-tunnel-doctor ${gatewayStatus.running ? '' : 'disabled'}>Testar tunnel</button>
             <button class="primary" type="button" data-mcp-tunnel-start ${gatewayStatus.running ? '' : 'disabled'}>Conectar tunnel</button>`}
      </div>
    </section>
  </div>`;
}

function isAutoConfigClient(client: McpClientId): client is McpAutoConfigClientId {
  return client === 'cursor' || client === 'codex' || client === 'claude-code';
}

function renderConnectionSetup(client: McpClientId, state: { label: string; tone: string; detail: string }): string {
  if (!isAutoConfigClient(client)) {
    return state.tone === 'connected' || state.tone === 'active'
      ? ''
      : `<section class="mcp-setup-callout"><span>PRÓXIMO PASSO</span><strong>Conclua no ${escapeHtml(clientDefinition(client).name)}</strong><p>${escapeHtml(clientSetupSummary(client))}</p></section>`;
  }

  const definition = clientDefinition(client);
  const status = clientConfigStatuses[client];
  const error = clientConfigErrors[client];
  const configuredExtra = client === 'cursor'
    ? ' Se o Cursor já estava aberto, recarregue as integrações MCP.'
    : client === 'codex'
      ? ' App, CLI e extensão do Codex compartilham esta configuração.'
      : ' O Claude Code usa esta conexão no escopo de usuário.';
  if (status?.state === 'configured') {
    return `<section class="mcp-setup-callout configured"><span>CONFIGURADO</span><strong>Auto CodeZ adicionado ao ${escapeHtml(definition.name)}</strong><p>${escapeHtml(status.detail)}${escapeHtml(configuredExtra)}</p><button class="mcp-text-action" type="button" data-mcp-remove-client-config="${client}" ${clientConfigBusy ? 'disabled' : ''}>Remover configuração</button></section>`;
  }
  if (status?.state === 'conflict') {
    return `<section class="mcp-setup-callout attention"><span>AÇÃO NECESSÁRIA</span><strong>Já existe uma conexão auto-codez no ${escapeHtml(definition.name)}</strong><p>${escapeHtml(status.detail)} O Auto CodeZ não sobrescreveu nada.</p></section>`;
  }
  if (status?.state === 'unsupported') {
    return `<section class="mcp-setup-callout"><span>PRÓXIMO PASSO</span><strong>Conclua no ${escapeHtml(definition.name)}</strong><p>${escapeHtml(status.detail)}</p></section>`;
  }
  return `<section class="mcp-setup-callout"><span>PRÓXIMO PASSO</span><strong>Conectar ao ${escapeHtml(definition.name)}</strong><p>O Auto CodeZ pode configurar esta conexão automaticamente. Nenhum token é salvo na configuração do cliente.</p><button class="mcp-primary-action compact" type="button" data-mcp-install-client-config="${client}" ${clientConfigBusy ? 'disabled' : ''}>${clientConfigBusy === client ? 'Configurando…' : 'Configurar automaticamente'}</button>${error ? `<div class="mcp-client-config-error">${escapeHtml(error)}</div>` : ''}</section>`;
}

function renderConnectionDetail(root: HTMLElement, clientId: McpClientId): void {
  const client = clientDefinition(clientId);
  const state = clientPublicState(clientId);
  const related = clientEvents(clientId).slice(-8).reverse();
  const pending = relevantApprovals();
  const toolCount = gatewayPreflight?.toolCount ?? 0;
  const writeCount = gatewayPreflight?.writeToolCount ?? 0;
  root.innerHTML = `<section class="mcp-detail-page" data-mcp-connection-detail="${client.id}">
    <header class="mcp-detail-header">
      <button class="mcp-back-button" type="button" data-mcp-back-hub aria-label="Voltar para MCP Mode"><span>←</span>MCP Mode</button>
      <div class="mcp-detail-header-actions"><button class="mcp-icon-action" type="button" data-mcp-refresh aria-label="Atualizar status" title="Atualizar status">↻</button></div>
    </header>
    <main class="mcp-detail-content">
      <section class="mcp-detail-hero">
        ${renderClientIcon(client.id, 'mcp-client-logo large')}
        <div class="mcp-detail-identity"><span class="mcp-detail-eyebrow">CONEXÃO MCP</span><h1>${escapeHtml(client.name)}</h1><p>${escapeHtml(client.description)}</p><span class="mcp-status-pill ${escapeHtml(state.tone)}"><i></i>${escapeHtml(state.label)}</span></div>
      </section>
      ${renderConnectionSetup(client.id, state)}
      <div class="mcp-detail-grid">
        <section class="mcp-detail-card">
          <div class="mcp-detail-card-heading"><span>FERRAMENTAS</span><h2>Disponíveis para esta conexão</h2></div>
          <div class="mcp-tool-summary"><strong>${toolCount || '—'}</strong><div><span>ferramentas MCP</span><small>${toolCount ? `${writeCount} podem alterar dados e continuam sob aprovação local.` : 'O catálogo aparece assim que o gateway local estiver pronto.'}</small></div></div>
          <button class="mcp-text-action" type="button" data-mcp-advanced>${showAdvanced ? 'Ocultar configuração avançada' : 'Ver configuração avançada'}</button>
        </section>
        <section class="mcp-detail-card">
          <div class="mcp-detail-card-heading"><span>SEGURANÇA</span><h2>Controle continua no Auto CodeZ</h2></div>
          <div class="mcp-security-list">
            <div><i>✓</i><span><strong>Alterações protegidas</strong><small>Ferramentas de escrita continuam seguindo permissões e aprovações.</small></span></div>
            <div><i>✓</i><span><strong>Credenciais temporárias</strong><small>Tokens de sessão não entram no histórico operacional.</small></span></div>
            <div><i>✓</i><span><strong>Atividade rastreável</strong><small>Operações MCP aparecem na atividade recente desta conexão.</small></span></div>
          </div>
        </section>
      </div>
      ${showAdvanced ? renderTechnicalPanels() : ''}
      ${pending.length ? `<section class="mcp-approval-stack"><div class="mcp-section-heading"><div><span>AGUARDANDO VOCÊ</span><h2>Aprovações pendentes</h2></div></div>${pending.map((approval) => `<div class="mcp-approval-card"><div><strong>${escapeHtml(approval.toolCall.name)}</strong><span>A execução está pausada até sua decisão.</span></div><div><button data-mcp-deny="${escapeHtml(approval.id)}">Rejeitar</button><button class="primary" data-mcp-approve="${escapeHtml(approval.id)}">Permitir esta ação</button></div></div>`).join('')}</section>` : ''}
      <section class="mcp-activity-section">
        <div class="mcp-section-heading"><div><span>ATIVIDADE</span><h2>Atividade recente</h2></div><small>${related.length ? `${related.length} eventos desta conexão` : 'Nenhuma atividade registrada ainda'}</small></div>
        <div class="mcp-timeline compact">${related.length ? related.map(renderEvent).join('') : '<div class="mcp-empty-state compact"><strong>Aguardando a primeira ação</strong><span>Quando esta conexão usar uma ferramenta, ela aparecerá aqui com o resultado e o horário.</span></div>'}</div>
      </section>
    </main>
  </section>`;
  const tunnelKeyInput = root.querySelector<HTMLInputElement>('[data-mcp-tunnel-key]');
  if (tunnelKeyInput && tunnelKeyDraft) tunnelKeyInput.value = tunnelKeyDraft;
}

function renderConnectPanel(): string {
  const available = MCP_CLIENTS.filter((client) => !selectedClients.has(client.id));
  return `<div class="mcp-connect-backdrop" data-mcp-close-connect>
    <section class="mcp-connect-panel" role="dialog" aria-modal="true" aria-label="Conectar ferramenta">
      <header><div><span>CONEXÕES MCP</span><h2>Conectar uma ferramenta</h2><p>Escolha um aplicativo compatível. O Auto CodeZ mantém os detalhes técnicos fora do caminho.</p></div><button class="mcp-icon-action" type="button" data-mcp-close-connect aria-label="Fechar">×</button></header>
      <div class="mcp-connect-discovery"><span class="mcp-discovery-icon" aria-hidden="true"><img src="${escapeHtml(MCP_ICON_URL)}" alt="" draggable="false"></span><div><strong>Conexões compatíveis</strong><small>Escolha um aplicativo com fluxo de configuração disponível no Auto CodeZ.</small></div></div>
      <div class="mcp-connect-list">
        ${available.length ? available.map((client) => `<button type="button" class="mcp-connect-option" data-mcp-connect-client="${client.id}">${renderClientIcon(client.id)}<span><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(client.description)}</small></span><em>Adicionar</em></button>`).join('') : '<div class="mcp-empty-state compact"><strong>Todas as conexões conhecidas já foram adicionadas.</strong><span>Novos tipos de conexão entrarão aqui conforme o runtime MCP evoluir.</span></div>'}
      </div>
      <footer><span>Precisa de um servidor personalizado?</span><button class="mcp-text-action" type="button" data-mcp-advanced>Usar configuração avançada</button></footer>
    </section>
  </div>`;
}

function renderOnboarding(root: HTMLElement): void {
  if (onboardingStep === 'activation') {
    const platform = runtimeStatus.platform ? `${escapeHtml(runtimeStatus.platform)} · ${escapeHtml(runtimeStatus.arch)}` : 'Seu computador';
    root.innerHTML = `<section class="mcp-onboarding">
      <div class="mcp-onboarding-glow"></div>
      <div class="mcp-onboarding-card">
        <div class="mcp-onboarding-icon"><span></span><span></span><span></span></div>
        <div class="mcp-onboarding-kicker">AUTO CODEZ · MCP</div>
        <h1>Prepare o MCP Mode.</h1>
        <p>Conecte ferramentas e aplicativos às suas IAs sem precisar configurar portas, processos ou arquivos manualmente.</p>
        <div class="mcp-onboarding-points"><span>✓ Detecta ${platform}</span><span>✓ Prepara dependências</span><span>✓ Mantém writes sob aprovação</span></div>
        ${activationMessage ? `<div class="mcp-onboarding-progress"><span></span>${escapeHtml(activationMessage)}</div>` : ''}
        ${activationError ? `<div class="mcp-onboarding-error">${escapeHtml(activationError)}</div>` : ''}
        <button class="mcp-onboarding-primary" data-mcp-activate ${activationBusy ? 'disabled' : ''}>${activationBusy ? 'Preparando…' : 'Preparar MCP Mode'}</button>
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
        <h1>Escolha suas primeiras conexões.</h1>
        <p>Você poderá adicionar ou remover conexões depois. Mostraremos somente os passos necessários para cada aplicativo.</p>
        <div class="mcp-client-grid">${MCP_CLIENTS.map((client) => `<button class="mcp-client-option ${selectedClients.has(client.id) ? 'selected' : ''}" data-mcp-client="${client.id}"><span class="mcp-client-check">${selectedClients.has(client.id) ? '✓' : ''}</span>${renderClientIcon(client.id)}<span class="mcp-client-option-copy"><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(client.detail)}</small></span><em>${escapeHtml(client.badge)}</em></button>`).join('')}</div>
        ${activationMessage ? `<div class="mcp-onboarding-progress"><span></span>${escapeHtml(activationMessage)}</div>` : ''}
        ${activationError ? `<div class="mcp-onboarding-error">${escapeHtml(activationError)}</div>` : ''}
        <div class="mcp-onboarding-actions"><button class="mcp-onboarding-secondary" data-mcp-onboarding-back ${activationBusy ? 'disabled' : ''}>Voltar</button><button class="mcp-onboarding-primary" data-mcp-onboarding-next ${selectedClients.size && !activationBusy ? '' : 'disabled'}>${activationBusy ? 'Preparando…' : 'Avançar'}</button></div>
      </div>
    </section>`;
    return;
  }
  root.innerHTML = `<section class="mcp-onboarding instructions">
    <div class="mcp-instructions-shell">
      <header><div><div class="mcp-onboarding-kicker">ÚLTIMO PASSO</div><h1>Conclua suas conexões</h1><p>Siga somente os passos de cada aplicativo. Os detalhes de protocolo continuam escondidos por padrão.</p></div><button class="mcp-onboarding-secondary" data-mcp-advanced>Ver configuração avançada</button></header>
      <div class="mcp-guide-list">${[...selectedClients].map(renderClientInstructions).join('')}</div>
      ${activationError ? `<div class="mcp-onboarding-error">${escapeHtml(activationError)}</div>` : ''}
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
  if (onboardingStep !== 'operational') {
    selectedConnectionId = '';
    connectPanelOpen = false;
    root.classList.remove('show-advanced');
    renderOnboarding(root);
    return;
  }

  root.classList.toggle('show-advanced', showAdvanced);
  const configured = MCP_CLIENTS.filter((client) => selectedClients.has(client.id));
  const available = MCP_CLIENTS.filter((client) => !selectedClients.has(client.id));
  const recent = mcpActivityEvents().slice(-6).reverse();
  const pending = relevantApprovals();

  if (selectedConnectionId) {
    renderConnectionDetail(root, selectedConnectionId);
    return;
  }

  const ready = Boolean(gatewayStatus.running && gatewayPreflight);
  root.innerHTML = `<section class="mcp-hub-page">
    <header class="mcp-hub-header">
      <div><span class="mcp-page-eyebrow">AUTO CODEZ · MCP</span><h1>MCP Mode</h1><p>Conecte ferramentas e aplicativos e deixe suas IAs usarem somente o que você autorizou.</p></div>
      <div class="mcp-hub-actions"><button class="mcp-icon-action" type="button" data-mcp-refresh aria-label="Atualizar conexões" title="Atualizar conexões">↻</button><button class="mcp-primary-action" type="button" data-mcp-open-connect><span>＋</span>Conectar ferramenta</button></div>
    </header>
    <main class="mcp-hub-content">
      <section class="mcp-health-card ${ready ? 'ready' : ''}">
        <span class="mcp-health-indicator"><i></i></span>
        <div><strong>${ready ? 'MCP pronto' : 'Preparando conexões'}</strong><small>${ready ? `${gatewayPreflight!.toolCount} ferramentas disponíveis · alterações continuam protegidas por aprovação` : gatewayPreflightError || 'O Auto CodeZ está preparando o runtime local necessário para suas conexões.'}</small></div>
        <span class="mcp-health-count">${configured.length === 1 ? '1 conexão adicionada' : `${configured.length} conexões adicionadas`}</span>
      </section>

      ${pending.length ? `<section class="mcp-approval-stack"><div class="mcp-section-heading"><div><span>AGUARDANDO VOCÊ</span><h2>Aprovações pendentes</h2></div></div>${pending.map((approval) => `<div class="mcp-approval-card"><div><strong>${escapeHtml(approval.toolCall.name)}</strong><span>A execução está pausada até sua decisão.</span></div><div><button data-mcp-deny="${escapeHtml(approval.id)}">Rejeitar</button><button class="primary" data-mcp-approve="${escapeHtml(approval.id)}">Permitir esta ação</button></div></div>`).join('')}</section>` : ''}

      <section class="mcp-hub-section">
        <div class="mcp-section-heading"><div><span>CONEXÕES</span><h2>Suas conexões</h2></div><small>${configured.length ? 'Abra uma conexão para revisar status, ferramentas e segurança.' : 'Adicione sua primeira conexão para começar.'}</small></div>
        <div class="mcp-connection-grid">${configured.length ? configured.map((client) => renderConnectionCard(client, true)).join('') : '<div class="mcp-empty-state"><strong>Nenhuma conexão configurada.</strong><span>Use “Conectar ferramenta” para escolher um aplicativo compatível.</span><button class="mcp-text-action" type="button" data-mcp-open-connect>Escolher uma conexão</button></div>'}</div>
      </section>

      ${available.length ? `<section class="mcp-hub-section"><div class="mcp-section-heading"><div><span>DISPONÍVEIS</span><h2>Adicionar outra conexão</h2></div><small>Somente clientes com fluxo conhecido aparecem aqui.</small></div><div class="mcp-connection-grid available">${available.slice(0, 3).map((client) => renderConnectionCard(client, false)).join('')}</div></section>` : ''}

      <section class="mcp-activity-section">
        <div class="mcp-section-heading"><div><span>ATIVIDADE</span><h2>Atividade recente</h2></div><small>${recent.length ? 'Ações MCP mais recentes' : 'Nenhuma sessão externa usou ferramentas ainda'}</small></div>
        <div class="mcp-timeline compact">${loading ? '<div class="mcp-empty-state compact"><strong>Atualizando conexões…</strong></div>' : recent.length ? recent.map(renderEvent).join('') : '<div class="mcp-empty-state compact"><strong>Nenhuma atividade ainda.</strong><span>Quando uma IA usar uma ferramenta MCP, a ação aparecerá aqui em tempo real.</span></div>'}</div>
      </section>
    </main>
    ${connectPanelOpen ? renderConnectPanel() : ''}
  </section>`;
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
    const clientStatusPromise = (clientId: McpAutoConfigClientId) => window.autoCodez.mcpClientConfigStatus(clientId)
      .then((status) => status as McpClientConfigStatus)
      .catch((error): undefined => {
        clientConfigErrors[clientId] = error instanceof Error ? error.message : String(error);
        return undefined;
      });
    const [page, nextApprovals, nextGatewayStatus, nextTunnelStatus, nextRuntimeStatus, nextConnections, nextCursorConfigStatus, nextCodexConfigStatus, nextClaudeCodeConfigStatus] = await Promise.all([
      window.autoCodez.listOperationalLedger({ limit: MAX_RENDERED_EVENTS, direction: 'backward' }),
      window.autoCodez.listApprovals(),
      window.autoCodez.mcpGatewayStatus(),
      window.autoCodez.mcpTunnelStatus(),
      window.autoCodez.mcpRuntimeStatus(),
      window.autoCodez.listMcpConnections() as Promise<McpStoredConnection[]>,
      clientStatusPromise('cursor'),
      clientStatusPromise('codex'),
      clientStatusPromise('claude-code'),
    ]);
    if (!active || token !== refreshSequence) return;
    events = page.events.map(asLedgerEvent).filter((event): event is LedgerEvent => Boolean(event)).reverse();
    approvals = nextApprovals as Approval[];
    gatewayStatus = nextGatewayStatus as GatewayStatus;
    tunnelStatus = nextTunnelStatus as TunnelStatus;
    runtimeStatus = nextRuntimeStatus as McpRuntimeStatus;
    if (nextCursorConfigStatus) clientConfigStatuses.cursor = nextCursorConfigStatus;
    if (nextCodexConfigStatus) clientConfigStatuses.codex = nextCodexConfigStatus;
    if (nextClaudeCodeConfigStatus) clientConfigStatuses['claude-code'] = nextClaudeCodeConfigStatus;
    if (onboardingStep === 'operational') {
      const persistedClients = nextConnections
        .map((connection) => connection.clientId)
        .filter((clientId): clientId is McpClientId => MCP_CLIENTS.some((client) => client.id === clientId));
      if (persistedClients.length) {
        selectedClients.clear();
        for (const clientId of persistedClients) selectedClients.add(clientId);
        persistClientSelection();
      } else if (selectedClients.size) {
        await Promise.all([...selectedClients].map((clientId) => window.autoCodez.addMcpConnection(clientId)));
      }
    }
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

function install(): void {
  const rail = document.querySelector<HTMLElement>('.rail');
  const body = document.querySelector<HTMLElement>('.body');
  const spacer = rail?.querySelector<HTMLElement>('.rail-spacer');
  if (!rail || !body || !spacer || document.getElementById(rootId)) return;


  let button = rail.querySelector<HTMLButtonElement>('[data-mcp-mode]');
  if (!button) {
    button = document.createElement('button');
    button.className = 'rail-button';
    button.type = 'button';
    button.setAttribute('data-mcp-mode', '');
    button.title = 'MCP Mode';
    button.setAttribute('aria-label', 'MCP Mode');
    rail.insertBefore(button, spacer);
  }

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
    if (target.closest('[data-mcp-open-connect]')) {
      connectPanelOpen = true;
      render();
      return;
    }
    const closeConnectButton = target.closest('button[data-mcp-close-connect]');
    if (closeConnectButton || target.matches('.mcp-connect-backdrop')) {
      connectPanelOpen = false;
      render();
      return;
    }
    const connectClient = target.closest<HTMLElement>('[data-mcp-connect-client]')?.dataset.mcpConnectClient as McpClientId | undefined;
    if (connectClient) {
      try {
        await window.autoCodez.addMcpConnection(connectClient);
        selectedClients.add(connectClient);
        persistClientSelection();
        connectPanelOpen = false;
        selectedConnectionId = connectClient;
        showAdvanced = false;
        render();
      } catch (error) {
        activationError = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }
    const openConnection = target.closest<HTMLElement>('[data-mcp-open-connection]')?.dataset.mcpOpenConnection as McpClientId | undefined;
    if (openConnection) {
      selectedConnectionId = openConnection;
      connectPanelOpen = false;
      showAdvanced = false;
      render();
      return;
    }
    const installClientConfig = target.closest<HTMLElement>('[data-mcp-install-client-config]')?.dataset.mcpInstallClientConfig as McpAutoConfigClientId | undefined;
    if (installClientConfig && (installClientConfig === 'cursor' || installClientConfig === 'codex' || installClientConfig === 'claude-code')) {
      clientConfigBusy = installClientConfig;
      delete clientConfigErrors[installClientConfig];
      render();
      try {
        clientConfigStatuses[installClientConfig] = await window.autoCodez.installMcpClientConfig(installClientConfig) as McpClientConfigStatus;
        await refresh();
      } catch (error) {
        clientConfigErrors[installClientConfig] = error instanceof Error ? error.message : String(error);
      } finally {
        clientConfigBusy = '';
        render();
      }
      return;
    }
    const removeClientConfig = target.closest<HTMLElement>('[data-mcp-remove-client-config]')?.dataset.mcpRemoveClientConfig as McpAutoConfigClientId | undefined;
    if (removeClientConfig && (removeClientConfig === 'cursor' || removeClientConfig === 'codex' || removeClientConfig === 'claude-code')) {
      clientConfigBusy = removeClientConfig;
      delete clientConfigErrors[removeClientConfig];
      render();
      try {
        clientConfigStatuses[removeClientConfig] = await window.autoCodez.removeMcpClientConfig(removeClientConfig) as McpClientConfigStatus;
        await refresh();
      } catch (error) {
        clientConfigErrors[removeClientConfig] = error instanceof Error ? error.message : String(error);
      } finally {
        clientConfigBusy = '';
        render();
      }
      return;
    }
    if (target.closest('[data-mcp-back-hub]')) {
      selectedConnectionId = '';
      showAdvanced = false;
      render();
      return;
    }
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
    if (target.closest('[data-mcp-onboarding-finish]')) {
      activationError = '';
      try {
        await Promise.all([...selectedClients].map((clientId) => window.autoCodez.addMcpConnection(clientId)));
        persistOnboardingComplete();
        onboardingStep = 'operational';
        await refresh();
      } catch (error) {
        activationError = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }
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
