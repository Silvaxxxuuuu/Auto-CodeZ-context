type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed';
type Activity = {
  id?: string;
  runId?: string;
  type?: string;
  message?: string;
  status?: ExecutionStatus | string;
  toolName?: string;
  commandResult?: { exitCode?: number; durationMs?: number; timedOut?: boolean };
  gitResult?: { operation?: string; branch?: string; output?: string };
};
type Approval = {
  id: string;
  toolCall: { name: string; input: Record<string, unknown> };
};

type AutoCodeZBridge = {
  onActivity: (listener: (event: unknown) => void) => () => void;
  onStreamEvent: (listener: (event: unknown) => void) => () => void;
  listApprovals: () => Promise<Approval[]>;
};

type RunState = {
  runId: string;
  status: ExecutionStatus;
  startedAt: number;
  updatedAt: number;
  message: string;
  steps: Activity[];
};

const root = document.querySelector<HTMLElement>('.chat-area');
if (!root) throw new Error('Área do chat não encontrada.');

const bridge = (window as unknown as { autoCodez?: AutoCodeZBridge }).autoCodez;
if (!bridge?.onActivity || !bridge.onStreamEvent || !bridge.listApprovals) throw new Error('Canal de execução não disponível.');

const runs = new Map<string, RunState>();
let pendingApprovals: Approval[] = [];
const MAX_RUNS = 6;
const MAX_STEPS = 8;

const container = document.createElement('section');
container.className = 'chat-execution';
container.setAttribute('aria-live', 'polite');
container.hidden = true;
root.insertBefore(container, root.querySelector('.composer-wrap'));

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function normalizeStatus(value: string | undefined): ExecutionStatus {
  if (value === 'pending' || value === 'failed' || value === 'success') return value;
  return 'running';
}

function statusLabel(status: ExecutionStatus): string {
  if (status === 'pending') return 'Aguardando aprovação';
  if (status === 'failed') return 'Falhou';
  if (status === 'success') return 'Concluída';
  return 'Em execução';
}

function statusClass(status: ExecutionStatus): string {
  return `execution-status-${status}`;
}

function stepLabel(step: Activity): string {
  if (step.toolName) return step.toolName;
  if (step.gitResult?.operation) return `git_${step.gitResult.operation}`;
  return step.message || step.type || 'Atividade';
}

function runTitle(run: RunState): string {
  const firstTool = run.steps.find((step) => step.toolName)?.toolName;
  if (firstTool) return firstTool;
  return 'Execução do agente';
}

function approvalMarkup(approvals: Approval[]): string {
  if (!approvals.length) return '';
  const cards = approvals.map((approval) => `<div class="execution-approval-item" data-execution-approval="${escapeHtml(approval.id)}"><div class="execution-approval-tool"><span class="execution-approval-icon" aria-hidden="true"></span><div><div class="execution-approval-label">Aprovação necessária</div><strong>${escapeHtml(approval.toolCall.name)}</strong></div></div><pre class="execution-approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</pre><div class="execution-approval-actions"><button data-approve="${escapeHtml(approval.id)}" class="primary-button">Aprovar</button><button data-deny="${escapeHtml(approval.id)}" class="danger-button">Recusar</button></div></div>`).join('');
  return `<div class="execution-approval"><div class="execution-approval-head"><span class="execution-approval-status-dot"></span><span>Operação aguardando sua decisão</span></div>${cards}</div>`;
}

function latestRun(): RunState | undefined {
  return [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function render(): void {
  const ordered = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUNS);
  container.hidden = ordered.length === 0 && pendingApprovals.length === 0;
  container.innerHTML = ordered.map((run) => {
    const existingRun = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(run.runId)}"]`);
    const detailsMarkup = existingRun?.querySelector<HTMLElement>('.execution-run-details')?.outerHTML || '<div class="execution-run-details"></div>';
    const approvalMarkup = existingRun?.querySelector<HTMLElement>('.execution-approval')?.outerHTML || (latestRun()?.runId === run.runId ? approvalMarkupForCurrentRun() : '');
    const steps = run.steps.slice(-MAX_STEPS).map((step) => {
      const status = normalizeStatus(step.status);
      const detail = step.commandResult
        ? `exit ${step.commandResult.exitCode ?? 'n/a'}${step.commandResult.durationMs !== undefined ? ` · ${step.commandResult.durationMs} ms` : ''}`
        : step.gitResult?.branch
          ? `branch ${step.gitResult.branch}`
          : '';
      return `<div class="execution-step"><span class="execution-step-status ${statusClass(status)}"></span><span class="execution-step-label">${escapeHtml(stepLabel(step))}</span><span class="execution-step-detail">${escapeHtml(detail || statusLabel(status))}</span></div>`;
    }).join('');
    return `<article class="execution-run ${statusClass(run.status)}" data-run-id="${escapeHtml(run.runId)}"><div class="execution-run-header"><div><div class="execution-run-kicker">Execução do agente</div><div class="execution-run-title">${escapeHtml(runTitle(run))}</div></div><span class="execution-run-status">${statusLabel(run.status)}</span></div><div class="execution-run-message">${escapeHtml(run.message)}</div><div class="execution-steps">${steps}</div>${detailsMarkup}${approvalMarkup}</article>`;
  }).join('');
  if (pendingApprovals.length && !ordered.length) {
    container.innerHTML = `<article class="execution-run execution-status-pending" data-run-id="approval"><div class="execution-run-header"><div><div class="execution-run-kicker">Execução do agente</div><div class="execution-run-title">Operação em espera</div></div><span class="execution-run-status">Aguardando aprovação</span></div>${approvalMarkup(pendingApprovals)}</article>`;
  }
  ordered.forEach((run) => window.dispatchEvent(new CustomEvent('auto-codez-execution-run-rendered', { detail: { runId: run.runId } })));
}

function approvalMarkupForCurrentRun(): string {
  return approvalMarkup(pendingApprovals);
}

function handleActivity(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const event = value as Activity;
  const runId = typeof event.runId === 'string' && event.runId.trim() ? event.runId : 'global';
  const now = Date.now();
  const existing = runs.get(runId);
  const status = normalizeStatus(event.status);
  const run: RunState = existing || {
    runId,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    message: 'Execução iniciada.',
    steps: [],
  };
  run.status = event.type === 'complete' ? status : status === 'failed' ? 'failed' : status === 'pending' ? 'pending' : run.status === 'pending' && status === 'running' ? 'running' : run.status;
  if (event.message) run.message = event.message;
  run.updatedAt = now;
  if (event.toolName || event.commandResult || event.gitResult || event.type === 'action' || event.type === 'tool') {
    const existingStep = event.id ? run.steps.find((step) => step.id === event.id) : undefined;
    if (existingStep) Object.assign(existingStep, event);
    else run.steps.push(event);
    if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
  }
  runs.set(runId, run);
  render();
}

async function refreshApprovals(): Promise<void> {
  try {
    pendingApprovals = await bridge.listApprovals();
  } catch {
    pendingApprovals = [];
  }
  const current = latestRun();
  if (pendingApprovals.length && current) {
    current.status = 'pending';
    current.message = 'Uma operação precisa da sua aprovação.';
    current.updatedAt = Date.now();
  }
  render();
}

bridge.onActivity(handleActivity);
bridge.onStreamEvent((value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const event = value as { type?: string };
  if (event.type === 'approval_required') void refreshApprovals();
  if (event.type === 'complete' || event.type === 'error') window.setTimeout(() => void refreshApprovals(), 0);
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-approve], [data-deny]')) window.setTimeout(() => void refreshApprovals(), 80);
});

void refreshApprovals();
