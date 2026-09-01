import type { ActivityEvent } from './ai/types';

interface RunState {
  runId: string;
  startedAt: number;
  status: ActivityEvent['status'];
  events: ActivityEvent[];
}

declare global {
  interface Window {
    autoCodez: {
      onActivity: (listener: (event: ActivityEvent) => void) => () => void;
    };
  }
}

const style = document.createElement('style');
style.textContent = `
.activity-runs {
  display:flex;
  flex-direction:column;
  gap:8px;
  width:min(920px, calc(100% - 32px));
  margin:0 auto;
  padding:0 0 10px;
  max-height:360px;
  overflow:auto;
}
.activity-run {
  border:1px solid rgba(255,255,255,.075);
  border-radius:11px;
  background:rgba(15,18,23,.96);
  box-shadow:0 7px 22px rgba(0,0,0,.12);
  overflow:hidden;
  transition:border-color .16s ease, background .16s ease;
}
.activity-run:hover { border-color:rgba(255,255,255,.13); background:rgba(17,21,27,.98); }
.activity-run-head {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:10px 12px;
}
.activity-run-title { display:flex; align-items:center; gap:8px; min-width:0; font-size:12px; font-weight:600; }
.activity-run-status { opacity:.58; font-weight:500; }
.activity-run-meta { font-size:10px; opacity:.48; white-space:nowrap; }
.activity-run-body { border-top:1px solid rgba(255,255,255,.055); padding:7px 12px 8px; }
.activity-run-step { display:flex; align-items:center; gap:8px; min-height:22px; font-size:11px; }
.activity-run-step-status { width:6px; height:6px; border-radius:50%; background:#7d8794; flex:0 0 auto; opacity:.8; }
.activity-run-step-status.success { background:#72c28b; }
.activity-run-step-status.failed { background:#dc7777; }
.activity-run-step-status.running { background:#d2b36f; }
.activity-run-step-status.pending { background:#9b8ad1; }
.activity-run-step-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.72; }
.activity-run-details { border-top:1px solid rgba(255,255,255,.055); padding:0 12px 9px; }
.activity-run-details:empty { display:none; }
.activity-run-details .activity-result-card { margin-top:7px; }
@media (max-width:720px) {
  .activity-runs { width:calc(100% - 16px); }
  .activity-run-head { padding:9px 10px; }
  .activity-run-body { padding:6px 10px 7px; }
  .activity-run-details { padding:0 10px 8px; }
}
@media (prefers-reduced-motion:reduce) {
  .activity-run { transition:none; }
}
`;
document.head.appendChild(style);

const runs = new Map<string, RunState>();

function statusLabel(status: ActivityEvent['status']): string {
  return status === 'success' ? 'Concluído' : status === 'failed' ? 'Falhou' : status === 'running' ? 'Executando' : 'Pendente';
}

function titleFor(event: ActivityEvent): string {
  if (event.gitResult) return event.gitResult.operation;
  if (event.commandResult) return event.commandResult.command;
  if (event.toolName) return event.toolName;
  return event.message;
}

function ensureContainer(): HTMLElement | null {
  const chatArea = document.querySelector<HTMLElement>('.chat-area');
  const composer = document.querySelector<HTMLElement>('.composer-wrap');
  if (!chatArea || !composer) return null;
  let container = document.querySelector<HTMLElement>('#activity-runs');
  if (!container) {
    container = document.createElement('section');
    container.id = 'activity-runs';
    container.className = 'activity-runs';
    chatArea.insertBefore(container, composer);
  }
  return container;
}

function renderRun(run: RunState, container: HTMLElement): void {
  let card = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(run.runId)}"]`);
  if (!card) {
    card = document.createElement('article');
    card.className = 'activity-run';
    card.dataset.runId = run.runId;
  }
  const existingDetails = card.querySelector<HTMLElement>('.activity-run-details');
  const detailsMarkup = existingDetails ? existingDetails.outerHTML : '<div class="activity-run-details"></div>';
  const latest = run.events[run.events.length - 1];
  const elapsed = Math.max(0, (latest?.createdAt ?? Date.now()) - run.startedAt);
  const steps = run.events.slice(-6).map((event) => `<div class="activity-run-step"><span class="activity-run-step-status ${event.status}"></span><span class="activity-run-step-name">${escapeHtml(titleFor(event))}</span></div>`).join('');
  card.innerHTML = `<div class="activity-run-head"><div class="activity-run-title"><span>Execução</span><span class="activity-run-status">${statusLabel(run.status)}</span></div><span class="activity-run-meta">${(elapsed / 1000).toFixed(1)} s</span></div><div class="activity-run-body">${steps}</div>${detailsMarkup}`;
  if (!card.parentElement) container.prepend(card);
  while (container.children.length > 6) container.lastElementChild?.remove();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function handleActivity(event: ActivityEvent): void {
  if (!event.runId) return;
  const existing = runs.get(event.runId);
  const run: RunState = existing ?? { runId: event.runId, startedAt: event.createdAt, status: event.status, events: [] };
  run.events.push(event);
  run.status = event.status === 'failed' ? 'failed' : event.status === 'pending' ? 'pending' : event.status === 'running' ? 'running' : 'success';
  runs.set(event.runId, run);
  const container = ensureContainer();
  if (container) renderRun(run, container);
}

function initialize(): void {
  const unsubscribe = window.autoCodez.onActivity(handleActivity);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
