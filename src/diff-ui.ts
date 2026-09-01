type DiffChange = {
  path: string;
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
  renamedFrom?: string;
};

type DiffPlan = {
  id: string;
  createdAt: number;
  changes: DiffChange[];
  summary: { files: number; created: number; modified: number; deleted: number; renamed: number; addedLines: number; removedLines: number };
};

type Approval = { id: string; toolCall: { id: string }; };
type ActivityEvent = {
  id: string;
  type: 'thought' | 'action' | 'tool' | 'test' | 'build' | 'complete' | 'error';
  message: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  createdAt: number;
  toolCallId?: string;
  toolName?: string;
  changes?: DiffChange[];
  diffPlan?: DiffPlan;
};

declare global {
  interface Window {
    autoCodez: {
      onActivity: (listener: (event: ActivityEvent) => void) => () => void;
      listApprovals: () => Promise<Approval[]>;
      approveTool: (approvalId: string) => Promise<unknown>;
      denyTool: (approvalId: string) => Promise<unknown>;
    };
  }
}

const style = document.createElement('style');
style.textContent = `
.diff-results { display:flex; flex-direction:column; gap:10px; padding:0 20px 10px; max-height:430px; overflow:auto; }
.diff-card { border:1px solid rgba(255,255,255,.09); border-radius:10px; background:#101318; overflow:hidden; }
.diff-card-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); }
.diff-card-title { min-width:0; display:flex; align-items:center; gap:8px; }
.diff-card-title strong { font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.diff-card-status { font-size:11px; opacity:.68; }
.diff-card-summary { display:flex; gap:9px; font-size:11px; opacity:.68; white-space:nowrap; }
.diff-card-actions { display:flex; gap:6px; padding:9px 12px; border-top:1px solid rgba(255,255,255,.06); }
.diff-card-actions button { border:1px solid rgba(255,255,255,.1); border-radius:6px; background:#181c23; color:#d8dde5; padding:5px 9px; font:inherit; cursor:pointer; }
.diff-card-actions button:hover { background:#20252e; }
.diff-card-actions button:disabled { opacity:.45; cursor:default; }
.diff-card-file { border-bottom:1px solid rgba(255,255,255,.05); }
.diff-card-file:last-child { border-bottom:0; }
.diff-file-head { display:flex; align-items:center; gap:8px; padding:7px 12px; font-size:11px; }
.diff-file-type { opacity:.62; text-transform:uppercase; }
.diff-file-path { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.diff-file-count { margin-left:auto; opacity:.58; white-space:nowrap; }
.diff-file-body { display:grid; grid-template-columns:1fr 1fr; border-top:1px solid rgba(255,255,255,.05); }
.diff-pane { min-width:0; }
.diff-pane + .diff-pane { border-left:1px solid rgba(255,255,255,.05); }
.diff-pane-label { padding:5px 10px; font-size:10px; text-transform:uppercase; letter-spacing:.04em; opacity:.5; border-bottom:1px solid rgba(255,255,255,.05); }
.diff-pane pre { margin:0; padding:9px 10px; max-height:150px; overflow:auto; font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; color:#cbd1da; }
.diff-empty { padding:12px; font-size:12px; opacity:.6; }
@media (max-width: 720px) { .diff-file-body { grid-template-columns:1fr; } .diff-pane + .diff-pane { border-left:0; border-top:1px solid rgba(255,255,255,.05); } .diff-card-summary { display:none; } }
`;
document.head.appendChild(style);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!));
}

function typeLabel(type: DiffChange['type']): string {
  return ({ created: 'criado', modified: 'modificado', deleted: 'excluído', renamed: 'renomeado' })[type];
}

function ensureContainer(): HTMLElement | null {
  const chatArea = document.querySelector<HTMLElement>('.chat-area');
  const composer = document.querySelector<HTMLElement>('.composer-wrap');
  if (!chatArea || !composer) return null;
  let container = document.querySelector<HTMLElement>('#diff-results');
  if (!container) {
    container = document.createElement('section');
    container.id = 'diff-results';
    container.className = 'diff-results';
    chatArea.insertBefore(container, composer);
  }
  return container;
}

function renderChange(change: DiffChange): string {
  const source = escapeHtml(change.before || '');
  const target = escapeHtml(change.after || '');
  const rename = change.renamedFrom ? `<span class="diff-file-type">de ${escapeHtml(change.renamedFrom)}</span>` : '';
  return `<div class="diff-card-file"><div class="diff-file-head"><span class="diff-file-type">${typeLabel(change.type)}</span>${rename}<strong class="diff-file-path">${escapeHtml(change.path)}</strong><span class="diff-file-count">+${change.addedLines} / -${change.removedLines}</span></div><div class="diff-file-body"><div class="diff-pane"><div class="diff-pane-label">Antes</div><pre>${source || '(vazio)'}</pre></div><div class="diff-pane"><div class="diff-pane-label">Depois</div><pre>${target || '(vazio)'}</pre></div></div></div>`;
}

function statusLabel(status: ActivityEvent['status']): string {
  return status === 'pending' ? 'Aguardando aprovação' : status === 'running' ? 'Aplicando' : status === 'success' ? 'Aplicado' : 'Falhou';
}

async function findApprovalId(toolCallId: string): Promise<string | undefined> {
  const approvals = await window.autoCodez.listApprovals();
  return approvals.find((approval) => approval.toolCall.id === toolCallId)?.id;
}

function renderDiff(event: ActivityEvent): void {
  const plan = event.diffPlan;
  if (!plan && !event.changes?.length) return;
  const container = ensureContainer();
  if (!container) return;
  const changes = plan?.changes || event.changes || [];
  const summary = plan?.summary;
  const card = document.createElement('article');
  card.className = 'diff-card';
  card.dataset.activityId = event.id;
  card.innerHTML = `<div class="diff-card-head"><div class="diff-card-title"><strong>${escapeHtml(event.message)}</strong><span class="diff-card-status">${statusLabel(event.status)}</span></div>${summary ? `<div class="diff-card-summary"><span>${summary.files} arquivo(s)</span><span>+${summary.addedLines}</span><span>-${summary.removedLines}</span></div>` : ''}</div>${changes.length ? changes.map(renderChange).join('') : '<div class="diff-empty">Nenhuma alteração para exibir.</div>'}`;
  if (event.status === 'pending' && event.toolCallId) {
    const actions = document.createElement('div');
    actions.className = 'diff-card-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Aprovar';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.textContent = 'Recusar';
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      deny.disabled = true;
      approve.textContent = 'Aplicando...';
      try {
        const approvalId = await findApprovalId(event.toolCallId!);
        if (!approvalId) throw new Error('Aprovação não encontrada.');
        await window.autoCodez.approveTool(approvalId);
        card.querySelector<HTMLElement>('.diff-card-status')!.textContent = 'Aplicado';
      } catch {
        approve.disabled = false;
        deny.disabled = false;
        approve.textContent = 'Aprovar';
      }
    });
    deny.addEventListener('click', async () => {
      approve.disabled = true;
      deny.disabled = true;
      try {
        const approvalId = await findApprovalId(event.toolCallId!);
        if (!approvalId) throw new Error('Aprovação não encontrada.');
        await window.autoCodez.denyTool(approvalId);
        card.querySelector<HTMLElement>('.diff-card-status')!.textContent = 'Recusado';
      } catch {
        approve.disabled = false;
        deny.disabled = false;
      }
    });
    actions.append(approve, deny);
    card.append(actions);
  }
  container.prepend(card);
  while (container.children.length > 8) container.lastElementChild?.remove();
}

function initialize(): void {
  const unsubscribe = window.autoCodez.onActivity(renderDiff);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
