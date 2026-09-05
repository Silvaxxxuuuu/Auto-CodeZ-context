import { buildExecutionGraph, type ExecutionGraphNode } from './execution-graph';
import type { ExecutionReport } from './execution-report';

const STYLE_ID = 'auto-codez-execution-graph';
const HISTORY_HOST_CLASS = 'execution-graph-history-host';
const MAX_VISIBLE_NODES = 18;

type ExecutionGraphBridge = {
  getExecutionReport?: (input: { chatId: string; runId: string }) => Promise<ExecutionReport | null>;
  listExecutionReports?: (chatId?: string) => Promise<ExecutionReport[]>;
};

const bridge = (window as unknown as { autoCodez?: ExecutionGraphBridge }).autoCodez;
const requestTokens = new Map<string, number>();
let historyRequestToken = 0;
let observedChatId = '';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .execution-graph-history-host{width:min(860px,calc(100% - 56px));margin:0 auto 10px}
    .execution-graph{margin-top:8px;border:1px solid rgba(255,255,255,.055);border-radius:9px;background:rgba(9,12,17,.42);overflow:hidden}
    .execution-graph-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.045)}
    .execution-graph-title{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#8993a1}
    .execution-graph-count{font-size:9px;color:#687382}
    .execution-graph-list{padding:7px 10px 8px}
    .execution-graph-node{position:relative;display:grid;grid-template-columns:12px minmax(0,1fr) auto;align-items:start;gap:8px;min-height:28px;padding:3px 0}
    .execution-graph-node:not(:last-child)::after{content:'';position:absolute;left:5px;top:14px;bottom:-4px;width:1px;background:rgba(139,151,166,.18)}
    .execution-graph-dot{position:relative;z-index:1;width:7px;height:7px;margin-top:4px;border-radius:50%;background:#778290;box-shadow:0 0 0 3px rgba(119,130,144,.08)}
    .execution-graph-node[data-kind='started'] .execution-graph-dot{background:#7b9bd1}
    .execution-graph-node[data-kind='recovered'] .execution-graph-dot{background:#b39a6c}
    .execution-graph-node[data-kind='tool'] .execution-graph-dot{background:#8b8fd0}
    .execution-graph-node[data-kind='approval'][data-decision='approved'] .execution-graph-dot{background:#6fa783}
    .execution-graph-node[data-kind='approval'][data-decision='denied'] .execution-graph-dot{background:#ca7379}
    .execution-graph-node[data-kind='evidence'] .execution-graph-dot{background:#6fa783}
    .execution-graph-node[data-kind='error'] .execution-graph-dot{background:#ca7379}
    .execution-graph-node[data-state='completed'] .execution-graph-dot{background:#6fa783}
    .execution-graph-node[data-state='failed'] .execution-graph-dot{background:#ca7379}
    .execution-graph-node[data-state='interrupted'] .execution-graph-dot{background:#b39a6c}
    .execution-graph-copy{min-width:0}
    .execution-graph-label{font-size:10.5px;line-height:1.4;color:#bbc2cc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .execution-graph-meta{margin-top:2px;font-size:9px;line-height:1.35;color:#687382;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .execution-graph-time{padding-top:1px;font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#5f6976;white-space:nowrap}
    .execution-graph-more{padding:5px 0 1px 20px;font-size:9px;color:#687382}
    @media(max-width:720px){.execution-graph-history-host{width:calc(100% - 24px)}.execution-graph-time{display:none}.execution-graph-node{grid-template-columns:12px minmax(0,1fr)}}
  `;
  document.head.appendChild(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function nodeMeta(node: ExecutionGraphNode): string {
  if (node.kind === 'tool') return 'Ferramenta observada';
  if (node.kind === 'approval') return node.approvalDecision === 'approved' ? 'Aprovação confirmada pelo usuário' : 'Operação recusada pelo usuário';
  if (node.kind === 'evidence') {
    const parts = [node.evidenceType, node.stepTitle, node.reference].filter((value): value is string => Boolean(value));
    return parts.join(' · ');
  }
  if (node.kind === 'error') return 'Erro observado';
  if (node.kind === 'recovered') return 'Estado restaurado no boot';
  if (node.kind === 'state') return 'Mudança de estado';
  return 'Início observado';
}

function formatTime(value: number): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function nodeMarkup(node: ExecutionGraphNode): string {
  const state = node.state ? ` data-state="${escapeHtml(node.state)}"` : '';
  const decision = node.approvalDecision ? ` data-decision="${escapeHtml(node.approvalDecision)}"` : '';
  return `<div class="execution-graph-node" data-kind="${escapeHtml(node.kind)}"${state}${decision}><span class="execution-graph-dot"></span><div class="execution-graph-copy"><div class="execution-graph-label" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</div><div class="execution-graph-meta" title="${escapeHtml(nodeMeta(node))}">${escapeHtml(nodeMeta(node))}</div></div><span class="execution-graph-time">${escapeHtml(formatTime(node.at))}</span></div>`;
}

function renderGraphContainer(container: HTMLElement, report: ExecutionReport): boolean {
  const graph = buildExecutionGraph(report);
  if (!graph.nodes.length) {
    container.innerHTML = '';
    return false;
  }
  const visible = graph.nodes.slice(-MAX_VISIBLE_NODES);
  const hiddenCount = graph.nodes.length - visible.length;
  container.innerHTML = `<div class="execution-graph-head"><span class="execution-graph-title">Execution Graph</span><span class="execution-graph-count">${graph.nodes.length} fatos</span></div><div class="execution-graph-list">${hiddenCount > 0 ? `<div class="execution-graph-more">+${hiddenCount} fatos anteriores</div>` : ''}${visible.map(nodeMarkup).join('')}</div>`;
  return true;
}

function ensureDetails(runId: string): HTMLElement | null {
  const run = document.querySelector<HTMLElement>(`.execution-run[data-run-id="${CSS.escape(runId)}"]`);
  if (!run) return null;
  let details = run.querySelector<HTMLElement>(':scope > .execution-run-details');
  if (!details) {
    details = document.createElement('div');
    details.className = 'execution-run-details';
    run.appendChild(details);
  }
  return details;
}

function historyHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${HISTORY_HOST_CLASS}`);
}

function removeHistoryHost(): void {
  historyHost()?.remove();
}

function ensureHistoryHost(): HTMLElement | null {
  const existing = historyHost();
  if (existing) return existing;
  const root = document.querySelector<HTMLElement>('.chat-area');
  const composer = root?.querySelector<HTMLElement>('.composer-wrap');
  if (!root || !composer) return null;
  const host = document.createElement('section');
  host.className = HISTORY_HOST_CLASS;
  host.setAttribute('aria-label', 'Execution Graph da execução mais recente');
  root.insertBefore(host, composer);
  return host;
}

function renderGraph(runId: string, report: ExecutionReport): void {
  const details = ensureDetails(runId);
  if (!details) return;
  let container = details.querySelector<HTMLElement>(':scope > .execution-graph');
  if (!container) {
    container = document.createElement('section');
    container.className = 'execution-graph';
    details.appendChild(container);
  }
  if (!renderGraphContainer(container, report)) container.remove();
}

function renderHistoryGraph(report: ExecutionReport): void {
  const host = ensureHistoryHost();
  if (!host) return;
  host.dataset.runId = report.runId;
  let container = host.querySelector<HTMLElement>(':scope > .execution-graph');
  if (!container) {
    container = document.createElement('section');
    container.className = 'execution-graph';
    host.appendChild(container);
  }
  if (!renderGraphContainer(container, report)) removeHistoryHost();
}

async function refreshRun(runId: string): Promise<void> {
  if (!bridge?.getExecutionReport || !runId || runId === 'global') return;
  const chatId = selectedChatId();
  if (!chatId) return;
  const token = (requestTokens.get(runId) ?? 0) + 1;
  requestTokens.set(runId, token);
  try {
    const report = await bridge.getExecutionReport({ chatId, runId });
    if (requestTokens.get(runId) !== token || selectedChatId() !== chatId) return;
    if (!report || report.chatId !== chatId || report.runId !== runId) return;
    renderGraph(runId, report);
    if (historyHost()?.dataset.runId === runId) removeHistoryHost();
  } catch {
    if (requestTokens.get(runId) !== token) return;
  }
}

async function refreshHistoryGraph(): Promise<void> {
  if (!bridge?.listExecutionReports) return;
  const chatId = selectedChatId();
  const token = ++historyRequestToken;
  if (!chatId) {
    removeHistoryHost();
    return;
  }
  try {
    const reports = await bridge.listExecutionReports(chatId);
    if (token !== historyRequestToken || selectedChatId() !== chatId) return;
    const report = reports.find((item) => item?.chatId === chatId && typeof item.runId === 'string' && item.runId.length > 0);
    if (!report) {
      removeHistoryHost();
      return;
    }
    const liveRun = document.querySelector<HTMLElement>(`.execution-run[data-run-id="${CSS.escape(report.runId)}"]`);
    if (liveRun) {
      removeHistoryHost();
      void refreshRun(report.runId);
      return;
    }
    renderHistoryGraph(report);
  } catch {
    if (token === historyRequestToken && selectedChatId() === chatId) removeHistoryHost();
  }
}

function refreshVisibleRuns(): void {
  document.querySelectorAll<HTMLElement>('.execution-run[data-run-id]').forEach((run) => {
    const runId = run.dataset.runId;
    if (runId) void refreshRun(runId);
  });
}

function refreshAllGraphs(): void {
  refreshVisibleRuns();
  void refreshHistoryGraph();
}

function syncSelectedChat(): void {
  const nextChatId = selectedChatId();
  if (nextChatId === observedChatId) return;
  observedChatId = nextChatId;
  historyRequestToken += 1;
  requestTokens.clear();
  removeHistoryHost();
  void refreshHistoryGraph();
}

function initialize(): void {
  installStyle();
  observedChatId = selectedChatId();
  window.addEventListener('auto-codez-execution-run-rendered', (event) => {
    const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
    if (!runId) return;
    if (historyHost()?.dataset.runId === runId) removeHistoryHost();
    void refreshRun(runId);
  });
  window.addEventListener('auto-codez-execution-refresh', refreshAllGraphs);
  window.addEventListener('auto-codez-chat-refresh', refreshAllGraphs);
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) {
    const observer = new MutationObserver(syncSelectedChat);
    observer.observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
  }
  refreshAllGraphs();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
