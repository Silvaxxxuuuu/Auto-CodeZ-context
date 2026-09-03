type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed';
type Activity = {
  id?: string;
  runId?: string;
  chatId?: string;
  type?: string;
  message?: string;
  status?: ExecutionStatus | string;
  toolName?: string;
  commandResult?: { exitCode?: number; durationMs?: number; timedOut?: boolean };
  gitResult?: { operation?: string; branch?: string; output?: string };
};
type Approval = {
  id: string;
  chatId?: string;
  runId?: string;
  toolCall: { name: string; input: Record<string, unknown> };
};
type RecoverableRun = {
  runId: string;
  chatId: string;
  toolRounds: number;
};

type AutoCodeZBridge = {
  onActivity: (listener: (event: unknown) => void) => () => void;
  onStreamEvent: (listener: (event: unknown) => void) => () => void;
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]>;
  listRecoverableRuns: () => Promise<RecoverableRun[]>;
  resumeRecoveredRun: (runId: string) => Promise<{ chatId: string; pendingApprovalIds: string[] }>;
};

type RunState = {
  runId: string;
  chatId: string;
  status: ExecutionStatus;
  startedAt: number;
  updatedAt: number;
  message: string;
  steps: Activity[];
};

const root = document.querySelector<HTMLElement>('.chat-area');
if (!root) throw new Error('Área do chat não encontrada.');

const bridge = (window as unknown as { autoCodez?: AutoCodeZBridge }).autoCodez;
if (!bridge?.onActivity || !bridge.onStreamEvent || !bridge.listApprovals || !bridge.listRecoverableRuns || !bridge.resumeRecoveredRun) throw new Error('Canal de execução não disponível.');

const runs = new Map<string, RunState>();
const runChatIds = new Map<string, string>();
let pendingApprovals: Approval[] = [];
let recoverableRuns: RecoverableRun[] = [];
let activeChatId = '';
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

function recoveryMarkup(): string {
  const current = recoverableRuns.filter((run) => run.chatId === activeChatId);
  if (!current.length) return '';
  return current.map((run) => `<article class="execution-run execution-status-pending" data-recovery-run="${escapeHtml(run.runId)}"><div class="execution-run-header"><div><div class="execution-run-kicker">Execução recuperável</div><div class="execution-run-title">Retomar execução</div></div><span class="execution-run-status">Interrompida</span></div><div class="execution-run-message">Uma execução anterior pode continuar do ponto persistido, sem repetir as ferramentas já concluídas.</div><div class="execution-approval-actions"><button data-recover-run="${escapeHtml(run.runId)}" class="primary-button">Retomar execução</button></div></article>`).join('');
}

function latestRun(): RunState | undefined {
  return [...runs.values()].filter((run) => run.chatId === activeChatId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function currentRunId(): string | undefined {
  return latestRun()?.runId;
}

function render(): void {
  const ordered = [...runs.values()].filter((run) => run.chatId === activeChatId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUNS);
  const recovery = recoveryMarkup();
  container.hidden = ordered.length === 0 && pendingApprovals.length === 0 && !recovery;
  container.innerHTML = recovery + ordered.map((run) => {
    const existingRun = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(run.runId)}"]`);
    const detailsMarkup = existingRun?.querySelector<HTMLElement>('.execution-run-details')?.outerHTML || '<div class="execution-run-details"></div>';
    const approvalMarkupForRun = pendingApprovals.length && run.runId === currentRunId() ? approvalMarkup(pendingApprovals.filter((approval) => !approval.runId || approval.runId === run.runId)) : '';
    const steps = run.steps.slice(-MAX_STEPS).map((step) => {
      const status = normalizeStatus(step.status);
      const detail = step.commandResult
        ? `exit ${step.commandResult.exitCode ?? 'n/a'}${step.commandResult.durationMs !== undefined ? ` · ${step.commandResult.durationMs} ms` : ''}`
        : step.gitResult?.branch
          ? `branch ${step.gitResult.branch}`
          : '';
      return `<div class="execution-step"><span class="execution-step-status ${statusClass(status)}"></span><span class="execution-step-label">${escapeHtml(stepLabel(step))}</span><span class="execution-step-detail">${escapeHtml(detail || statusLabel(status))}</span></div>`;
    }).join('');
    return `<article class="execution-run ${statusClass(run.status)}" data-run-id="${escapeHtml(run.runId)}"><div class="execution-run-header"><div><div class="execution-run-kicker">Execução do agente</div><div class="execution-run-title">${escapeHtml(runTitle(run))}</div></div><span class="execution-run-status">${statusLabel(run.status)}</span></div><div class="execution-run-message">${escapeHtml(run.message)}</div><div class="execution-steps">${steps}</div>${detailsMarkup}${approvalMarkupForRun}</article>`;
  }).join('');
  ordered.forEach((run) => window.dispatchEvent(new CustomEvent('auto-codez-execution-run-rendered', { detail: { runId: run.runId } })));
}

function handleActivity(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const event = value as Activity;
  const runId = typeof event.runId === 'string' && event.runId.trim() ? event.runId : 'global';
  if (event.chatId) runChatIds.set(runId, event.chatId);
  const chatId = event.chatId || runChatIds.get(runId);
  if (chatId && chatId !== activeChatId) return;
  if (!chatId) return;
  runChatIds.set(runId, chatId);
  const now = Date.now();
  const existing = runs.get(runId);
  const status = normalizeStatus(event.status);
  const run: RunState = existing || {
    runId,
    chatId,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    message: 'Execução iniciada.',
    steps: [],
  };
  if (run.chatId !== chatId || run.chatId !== activeChatId) return;
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
    const runId = currentRunId();
    pendingApprovals = (await bridge.listApprovals({ chatId: activeChatId, ...(runId ? { runId } : {}) })).filter((approval) => approval.chatId === activeChatId && (!runId || !approval.runId || approval.runId === runId));
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

async function refreshRecoverableRuns(): Promise<void> {
  try {
    recoverableRuns = (await bridge.listRecoverableRuns()).filter((run) => run.chatId === activeChatId);
    for (const run of recoverableRuns) runChatIds.set(run.runId, run.chatId);
  } catch {
    recoverableRuns = [];
  }
  render();
}

function syncChatContext(): void {
  const selected = document.querySelector<HTMLElement>('.chat-item.selected');
  const nextChatId = selected?.dataset.chat || '';
  if (nextChatId === activeChatId) return;
  activeChatId = nextChatId;
  runs.clear();
  pendingApprovals = [];
  recoverableRuns = [];
  container.hidden = true;
  container.innerHTML = '';
  if (activeChatId) {
    void refreshApprovals();
    void refreshRecoverableRuns();
  }
}

const chatContextObserver = new MutationObserver(syncChatContext);
chatContextObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-chat'] });

bridge.onActivity(handleActivity);
bridge.onStreamEvent((value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const event = value as { type?: string; chatId?: string; runId?: string };
  if (event.chatId) {
    if (event.runId) runChatIds.set(event.runId, event.chatId);
    if (event.chatId !== activeChatId) return;
  } else if (event.runId && runChatIds.get(event.runId) && runChatIds.get(event.runId) !== activeChatId) {
    return;
  } else if (!event.runId && event.type !== 'start') {
    return;
  }
  const current = event.runId ? runs.get(event.runId) : latestRun();
  if (event.type === 'approval_required') {
    void refreshApprovals();
    return;
  }
  if (event.type === 'complete') {
    if (current) {
      current.status = 'success';
      current.message = 'Execução concluída.';
      current.updatedAt = Date.now();
    }
    pendingApprovals = [];
    render();
    return;
  }
  if (event.type === 'error') {
    if (current) {
      current.status = 'failed';
      current.message = 'A execução falhou.';
      current.updatedAt = Date.now();
    }
    pendingApprovals = [];
    render();
  }
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const recoveryButton = target.closest<HTMLButtonElement>('[data-recover-run]');
  if (recoveryButton) {
    const runId = recoveryButton.dataset.recoverRun;
    if (!runId) return;
    recoveryButton.disabled = true;
    recoveryButton.textContent = 'Retomando…';
    void bridge.resumeRecoveredRun(runId).then((result) => {
      recoverableRuns = recoverableRuns.filter((run) => run.runId !== runId);
      runChatIds.set(runId, result.chatId);
      const now = Date.now();
      runs.set(runId, {
        runId,
        chatId: result.chatId,
        status: result.pendingApprovalIds.length ? 'pending' : 'success',
        startedAt: now,
        updatedAt: now,
        message: result.pendingApprovalIds.length ? 'A execução foi retomada e aguarda aprovação.' : 'Execução recuperada e concluída.',
        steps: [],
      });
      window.dispatchEvent(new CustomEvent('auto-codez-execution-refresh', { detail: { chatId: result.chatId } }));
      window.dispatchEvent(new CustomEvent('auto-codez-chat-refresh', { detail: { chatId: result.chatId } }));
      void refreshApprovals();
      void refreshRecoverableRuns();
    }).catch((error: unknown) => {
      recoveryButton.disabled = false;
      recoveryButton.textContent = 'Retomar execução';
      const message = error instanceof Error ? error.message : String(error);
      const recovery = recoverableRuns.find((run) => run.runId === runId);
      if (recovery) {
        runs.set(runId, {
          runId,
          chatId: recovery.chatId,
          status: 'failed',
          startedAt: Date.now(),
          updatedAt: Date.now(),
          message: `Falha ao retomar: ${message}`,
          steps: [],
        });
      }
      render();
    });
    return;
  }
  if (target.closest('[data-approve], [data-deny]')) {
    window.setTimeout((): void => { void refreshApprovals(); }, 80);
  }
});

syncChatContext();
void refreshApprovals();
void refreshRecoverableRuns();
