import { buildExecutionGraph, type ExecutionGraphNode } from './execution-graph';
import type { ExecutionReport } from './execution-report';

const STYLE_ID = 'auto-codez-execution-graph';
const MAX_VISIBLE_NODES = 18;

type ExecutionGraphBridge = {
  getExecutionReport?: (input: { chatId: string; runId: string }) => Promise<ExecutionReport | null>;
};

const bridge = (window as unknown as { autoCodez?: ExecutionGraphBridge }).autoCodez;
const requestTokens = new Map<string, number>();

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
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
    @media(max-width:720px){.execution-graph-time{display:none}.execution-graph-node{grid-template-columns:12px minmax(0,1fr)}}
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
  return `<div class="execution-graph-node" data-kind="${escapeHtml(node.kind)}"${state}><span class="execution-graph-dot"></span><div class="execution-graph-copy"><div class="execution-graph-label" title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</div><div class="execution-graph-meta" title="${escapeHtml(nodeMeta(node))}">${escapeHtml(nodeMeta(node))}</div></div><span class="execution-graph-time">${escapeHtml(formatTime(node.at))}</span></div>`;
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

function renderGraph(runId: string, report: ExecutionReport): void {
  const details = ensureDetails(runId);
  if (!details) return;
  const graph = buildExecutionGraph(report);
  let container = details.querySelector<HTMLElement>(':scope > .execution-graph');
  if (!graph.nodes.length) {
    container?.remove();
    return;
  }
  if (!container) {
    container = document.createElement('section');
    container.className = 'execution-graph';
    details.appendChild(container);
  }
  const visible = graph.nodes.slice(-MAX_VISIBLE_NODES);
  const hiddenCount = graph.nodes.length - visible.length;
  container.innerHTML = `<div class="execution-graph-head"><span class="execution-graph-title">Execution Graph</span><span class="execution-graph-count">${graph.nodes.length} fatos</span></div><div class="execution-graph-list">${hiddenCount > 0 ? `<div class="execution-graph-more">+${hiddenCount} fatos anteriores</div>` : ''}${visible.map(nodeMarkup).join('')}</div>`;
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
  } catch {
    if (requestTokens.get(runId) !== token) return;
  }
}

function refreshVisibleRuns(): void {
  document.querySelectorAll<HTMLElement>('.execution-run[data-run-id]').forEach((run) => {
    const runId = run.dataset.runId;
    if (runId) void refreshRun(runId);
  });
}

function initialize(): void {
  installStyle();
  window.addEventListener('auto-codez-execution-run-rendered', (event) => {
    const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
    if (runId) void refreshRun(runId);
  });
  window.addEventListener('auto-codez-execution-refresh', refreshVisibleRuns);
  window.addEventListener('auto-codez-chat-refresh', refreshVisibleRuns);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
