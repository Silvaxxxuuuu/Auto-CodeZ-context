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
.activity-runs { display:flex; flex-direction:column; gap:8px; padding:0 20px 10px; max-height:220px; overflow:auto; }
.activity-run { border:1px solid rgba(255,255,255,.08); border-radius:10px; background:#0d1014; overflow:hidden; }
.activity-run-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 11px; }
.activity-run-title { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; }
.activity-run-meta { font-size:10px; opacity:.55; }
.activity-run-body { border-top:1px solid rgba(255,255,255,.06); padding:7px 11px; }
.activity-run-step { display:flex; align-items:center; gap:8px; padding:3px 0; font-size:11px; }
.activity-run-step-status { width:6px; height:6px; border-radius:50%; background:#7d8794; flex:0 0 auto; }
.activity-run-step-status.success { background:#72c28b; }
.activity-run-step-status.failed { background:#dc7777; }
.activity-run-step-status.running { background:#d2b36f; }
.activity-run-step-status.pending { background:#9b8ad1; }
.activity-run-step-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
    container.prepend(card);
  }
  const latest = run.events[run.events.length - 1];
  const elapsed = Math.max(0, (latest?.createdAt ?? Date.now()) - run.startedAt);
  const steps = run.events.slice(-6).map((event) => `<div class="activity-run-step"><span class="activity-run-step-status ${event.status}"></span><span class="activity-run-step-name">${escapeHtml(titleFor(event))}</span></div>`).join('');
  card.innerHTML = `<div class="activity-run-head"><div class="activity-run-title"><span>Execução</span><span>${statusLabel(run.status)}</span></div><span class="activity-run-meta">${(elapsed / 1000).toFixed(1)} s</span></div><div class="activity-run-body">${steps}</div>`;
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
