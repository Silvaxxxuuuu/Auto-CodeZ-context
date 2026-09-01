import type { ActivityEvent, FileDiff, DiffPlan, CommandResultSummary, GitOperationSummary } from './ai/types';

const style = document.createElement('style');
style.textContent = `
.activity-result-card { border:1px solid rgba(255,255,255,.065); border-radius:9px; background:rgba(12,15,20,.72); overflow:hidden; }
.activity-result-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; }
.activity-result-title { display:flex; align-items:center; gap:8px; min-width:0; }
.activity-result-title strong { font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.activity-result-status { font-size:10px; opacity:.62; }
.activity-result-meta { display:flex; gap:10px; font-size:10px; opacity:.56; white-space:nowrap; }
.activity-result-output { margin:0; padding:9px 10px; border-top:1px solid rgba(255,255,255,.05); font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; overflow:auto; max-height:120px; color:#cbd1da; }
.activity-result-error { color:#f1a7a7; }
.activity-result-dot { width:6px; height:6px; border-radius:50%; background:#7d8794; flex:0 0 auto; }
.activity-result-dot.success { background:#72c28b; }
.activity-result-dot.failed { background:#dc7777; }
.activity-result-dot.running { background:#d2b36f; }
.activity-result-dot.pending { background:#9b8ad1; }
.activity-result-git { border-top:1px solid rgba(255,255,255,.05); padding:8px 10px; font-size:10px; }
.activity-result-git-row { display:flex; justify-content:space-between; gap:10px; }
.activity-result-git-label { opacity:.52; }
.activity-result-changes { border-top:1px solid rgba(255,255,255,.05); padding:7px 10px; }
.activity-result-change { display:flex; align-items:center; gap:8px; padding:3px 0; font:10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.activity-result-change-kind { width:14px; text-align:center; font-weight:700; }
.activity-result-change-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity-result-change-details { margin-top:6px; }
.activity-result-change-details summary { cursor:pointer; font-size:10px; opacity:.66; }
`;
document.head.appendChild(style);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function statusLabel(status: ActivityEvent['status']): string {
  return status === 'success' ? 'Concluído' : status === 'failed' ? 'Falhou' : status === 'running' ? 'Executando' : 'Pendente';
}

function gitOperationLabel(operation: GitOperationSummary['operation']): string {
  const labels: Record<GitOperationSummary['operation'], string> = {
    create_branch: 'Criar branch',
    checkout: 'Trocar branch',
    stage: 'Staging',
    stage_all: 'Staging completo',
    commit: 'Commit',
  };
  return labels[operation];
}

function changeKindLabel(kind: FileDiff['type']): string {
  return { created: '+', modified: 'M', deleted: '-', renamed: 'R' }[kind];
}

function ensureRunDetails(runId: string): HTMLElement | null {
  const escapedId = CSS.escape(runId);
  const run = document.querySelector<HTMLElement>(`.activity-run[data-run-id="${escapedId}"]`);
  if (!run) return null;
  let details = run.querySelector<HTMLElement>('.activity-run-details');
  if (!details) {
    details = document.createElement('div');
    details.className = 'activity-run-details';
    run.appendChild(details);
  }
  return details;
}

function renderChanges(changes: FileDiff[] | undefined): string {
  if (!changes?.length) return '';
  const rows = changes.map((change) => `<div class="activity-result-change"><span class="activity-result-change-kind">${escapeHtml(changeKindLabel(change.type))}</span><span class="activity-result-change-path">${escapeHtml(change.path)}</span></div>`).join('');
  return `<div class="activity-result-changes">${rows}</div>`;
}

function renderDiffPlan(plan: DiffPlan | undefined): string {
  if (!plan?.changes?.length) return '';
  const sections = plan.changes.map((change) => {
    const before = change.before ?? '';
    const after = change.after ?? '';
    return `<details class="activity-result-change-details"><summary>${escapeHtml(change.path)}</summary><pre class="activity-result-output">${escapeHtml(`--- before ---\n${before}\n\n+++ after +++\n${after}`)}</pre></details>`;
  }).join('');
  return `<div class="activity-result-changes">${sections}</div>`;
}

function renderCommandActivity(event: ActivityEvent, container: HTMLElement): void {
  if (!event.commandResult || !['test', 'build', 'tool'].includes(event.type)) return;
  const result = event.commandResult;
  const output = result.stderr || result.stdout;
  const card = document.createElement('article');
  card.className = 'activity-result-card';
  card.dataset.activityId = event.id;
  card.innerHTML = `<div class="activity-result-head"><div class="activity-result-title"><span class="activity-result-dot ${escapeHtml(event.status)}"></span><strong>${escapeHtml(result.command)}</strong><span class="activity-result-status">${statusLabel(event.status)}</span></div><div class="activity-result-meta"><span>exit ${result.exitCode}</span><span>${formatDuration(result.durationMs)}</span></div></div>${output ? `<pre class="activity-result-output ${result.stderr ? 'activity-result-error' : ''}">${escapeHtml(output)}</pre>` : ''}${renderChanges(event.changes)}${renderDiffPlan(event.diffPlan)}${event.error ? `<div class="activity-result-output activity-result-error">${escapeHtml(event.error)}</div>` : ''}`;
  container.prepend(card);
}

function renderGitActivity(event: ActivityEvent, container: HTMLElement): void {
  if (!event.gitResult) return;
  const result = event.gitResult;
  const card = document.createElement('article');
  card.className = 'activity-result-card';
  card.dataset.activityId = event.id;
  card.innerHTML = `<div class="activity-result-head"><div class="activity-result-title"><span class="activity-result-dot ${escapeHtml(event.status)}"></span><strong>${escapeHtml(gitOperationLabel(result.operation))}</strong><span class="activity-result-status">${statusLabel(event.status)}</span></div><div class="activity-result-meta"><span>${escapeHtml(result.branch)}</span></div></div><div class="activity-result-git"><div class="activity-result-git-row"><span class="activity-result-git-label">Operação</span><span>${escapeHtml(result.operation)}</span></div>${result.output ? `<pre class="activity-result-output">${escapeHtml(result.output)}</pre>` : ''}${event.error ? `<div class="activity-result-error">${escapeHtml(event.error)}</div>` : ''}</div>${renderChanges(event.changes)}${renderDiffPlan(event.diffPlan)}`;
  container.prepend(card);
}

function renderActivity(event: ActivityEvent): void {
  if (!event.runId || (!event.commandResult && !event.gitResult && !event.changes?.length && !event.diffPlan)) return;
  const container = ensureRunDetails(event.runId);
  if (!container) return;
  container.querySelector(`[data-activity-id="${CSS.escape(event.id)}"]`)?.remove();
  if (event.gitResult) renderGitActivity(event, container);
  else if (event.commandResult) renderCommandActivity(event, container);
  while (container.children.length > 6) container.lastElementChild?.remove();
}

function initialize(): void {
  const unsubscribe = window.autoCodez.onActivity(renderActivity);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
