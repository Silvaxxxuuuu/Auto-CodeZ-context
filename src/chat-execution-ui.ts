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

type AutoCodeZBridge = {
  onActivity: (listener: (event: unknown) => void) => () => void;
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
if (!bridge?.onActivity) throw new Error('Canal de atividade não disponível.');

const runs = new Map<string, RunState>();
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

function render(): void {
  const ordered = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUNS);
  container.hidden = ordered.length === 0;
  container.innerHTML = ordered.map((run) => {
    const steps = run.steps.slice(-MAX_STEPS).map((step) => {
      const status = normalizeStatus(step.status);
      const detail = step.commandResult
        ? `exit ${step.commandResult.exitCode ?? 'n/a'}${step.commandResult.durationMs !== undefined ? ` · ${step.commandResult.durationMs} ms` : ''}`
        : step.gitResult?.branch
          ? `branch ${step.gitResult.branch}`
          : '';
      return `<div class="execution-step"><span class="execution-step-status ${statusClass(status)}"></span><span class="execution-step-label">${escapeHtml(stepLabel(step))}</span><span class="execution-step-detail">${escapeHtml(detail || statusLabel(status))}</span></div>`;
    }).join('');
    return `<article class="execution-run ${statusClass(run.status)}" data-run-id="${escapeHtml(run.runId)}"><div class="execution-run-header"><div><div class="execution-run-kicker">Execução do agente</div><div class="execution-run-title">${escapeHtml(runTitle(run))}</div></div><span class="execution-run-status">${statusLabel(run.status)}</span></div><div class="execution-run-message">${escapeHtml(run.message)}</div><div class="execution-steps">${steps}</div></article>`;
  }).join('');
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

bridge.onActivity(handleActivity);
