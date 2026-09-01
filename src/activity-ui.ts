type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
};

type GitOperationSummary = {
  operation: 'create_branch' | 'checkout' | 'stage' | 'stage_all' | 'commit';
  branch: string;
  output: string;
};

type FileChange = {
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  oldContent?: string;
  newContent?: string;
};

type DiffPlan = {
  id: string;
  changes: FileChange[];
  reason?: string;
};

type ActivityEvent = {
  id: string;
  type: 'thought' | 'action' | 'tool' | 'test' | 'build' | 'complete' | 'error';
  message: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  createdAt: number;
  toolCallId?: string;
  toolName?: string;
  commandResult?: CommandResult;
  gitResult?: GitOperationSummary;
  changes?: FileChange[];
  diffPlan?: DiffPlan;
  error?: string;
};

declare global {
  interface Window {
    autoCodez: {
      onActivity: (listener: (event: ActivityEvent) => void) => () => void;
    };
  }
}

const style = document.createElement('style');
style.textContent = `
.activity-results { display:flex; flex-direction:column; gap:8px; padding:0 20px 10px; max-height:360px; overflow:auto; }
.activity-result-card { border:1px solid rgba(255,255,255,.08); border-radius:10px; background:#101318; overflow:hidden; }
.activity-result-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 11px; }
.activity-result-title { display:flex; align-items:center; gap:8px; min-width:0; }
.activity-result-title strong { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.activity-result-status { font-size:11px; opacity:.72; }
.activity-result-meta { display:flex; gap:10px; font-size:11px; opacity:.62; white-space:nowrap; }
.activity-result-output { margin:0; padding:10px 11px; border-top:1px solid rgba(255,255,255,.06); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; overflow:auto; max-height:120px; color:#cbd1da; }
.activity-result-error { color:#f1a7a7; }
.activity-result-dot { width:7px; height:7px; border-radius:50%; background:#7d8794; flex:0 0 auto; }
.activity-result-dot.success { background:#72c28b; }
.activity-result-dot.failed { background:#dc7777; }
.activity-result-dot.running { background:#d2b36f; }
.activity-result-dot.pending { background:#9b8ad1; }
.activity-result-git { border-top:1px solid rgba(255,255,255,.06); padding:9px 11px; font-size:11px; }
.activity-result-git-row { display:flex; justify-content:space-between; gap:10px; }
.activity-result-git-label { opacity:.58; }
.activity-result-changes { border-top:1px solid rgba(255,255,255,.06); padding:8px 11px; }
.activity-result-change { display:flex; align-items:center; gap:8px; padding:3px 0; font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.activity-result-change-kind { width:14px; text-align:center; font-weight:700; }
.activity-result-change-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity-result-change-details { margin-top:7px; }
.activity-result-change-details summary { cursor:pointer; font-size:11px; opacity:.7; }
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

function changeKindLabel(kind: FileChange['kind']): string {
  return { created: '+', modified: 'M', deleted: '-', renamed: 'R' }[kind];
}

function ensureContainer(): HTMLElement | null {
  const chatArea = document.querySelector<HTMLElement>('.chat-area');
  const composer = document.querySelector<HTMLElement>('.composer-wrap');
  if (!chatArea || !composer) return null;
  let container = document.querySelector<HTMLElement>('#activity-results');
  if (!container) {
    container = document.createElement('section');
    container.id = 'activity-results';
    container.className = 'activity-results';
    chatArea.insertBefore(container, composer);
  }
  return container;
}

function renderChanges(changes: FileChange[] | undefined): string {
  if (!changes?.length) return '';
  const rows = changes.map((change) => `<div class="activity-result-change"><span class="activity-result-change-kind">${escapeHtml(changeKindLabel(change.kind))}</span><span class="activity-result-change-path">${escapeHtml(change.path)}</span></div>`).join('');
  return `<div class="activity-result-changes">${rows}</div>`;
}

function renderDiffPlan(plan: DiffPlan | undefined): string {
  if (!plan?.changes?.length) return '';
  const sections = plan.changes.map((change) => {
    const before = change.oldContent ?? '';
    const after = change.newContent ?? '';
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
  if (!event.commandResult && !event.gitResult && !event.changes?.length && !event.diffPlan) return;
  const container = ensureContainer();
  if (!container) return;
  container.querySelector(`[data-activity-id="${CSS.escape(event.id)}"]`)?.remove();
  if (event.gitResult) renderGitActivity(event, container);
  else if (event.commandResult) renderCommandActivity(event, container);
  while (container.children.length > 8) container.lastElementChild?.remove();
}

function initialize(): void {
  const unsubscribe = window.autoCodez.onActivity((event) => renderActivity(event));
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
