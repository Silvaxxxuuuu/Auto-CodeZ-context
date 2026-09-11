type DiffPlan = {
  summary?: { files?: number; created?: number; modified?: number; deleted?: number; renamed?: number; addedLines?: number; removedLines?: number };
  changes?: Array<{ path: string; type: string; addedLines?: number; removedLines?: number }>;
};

type Approval = {
  id: string;
  chatId?: string;
  runId?: string;
  createdAt?: number;
  toolCall: { name: string; input: Record<string, unknown> };
  diffPlan?: DiffPlan;
};

type ApprovalBridge = {
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string; runId?: string }) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: ApprovalBridge }).autoCodez;
const chatArea = document.querySelector<HTMLElement>('.chat-area');
const composer = document.querySelector<HTMLElement>('.composer-wrap');
if (!bridge?.listApprovals || !bridge.onStreamEvent || !chatArea || !composer) throw new Error('Infraestrutura de aprovações indisponível.');

const processing = new Map<string, number>();
let activeChatId = '';
let requestToken = 0;

const style = document.createElement('style');
style.id = 'auto-codez-approval-ui';
style.textContent = `
  #messages .approval-card,.chat-execution .execution-approval{display:none!important}
  .ac-approval-root{display:flex;flex-direction:column;gap:8px;width:min(860px,calc(100% - 56px));margin:0 auto 10px;flex:none}
  .ac-approval-root[hidden]{display:none}
  .ac-approval-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px;color:#828d9a;font-size:10px}
  .ac-approval-card{border:1px solid #303844;border-radius:11px;background:#10151b;overflow:hidden;box-shadow:0 8px 24px #0002}
  .ac-approval-card[data-processing="true"]{opacity:.72}
  .ac-approval-head{display:flex;align-items:center;gap:10px;padding:11px 13px}
  .ac-approval-icon{display:grid;place-items:center;width:27px;height:27px;flex:0 0 27px;border:1px solid #36404c;border-radius:8px;color:#c9d2dc;background:#151b22}
  .ac-approval-icon svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .ac-approval-copy{min-width:0;display:flex;flex:1;flex-direction:column;gap:2px}
  .ac-approval-copy span{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#747f8d;font-weight:700}
  .ac-approval-copy strong{font-size:11px;font-weight:650;color:#e8edf4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-approval-path{font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#9ca8b6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-approval-meta{padding:0 13px 10px;color:#7f8996;font-size:9px}
  .ac-approval-details{border-top:1px solid #202731}
  .ac-approval-details summary{cursor:pointer;padding:9px 13px;color:#8d98a6;font-size:9px;user-select:none}
  .ac-approval-input{margin:0;padding:0 13px 11px;max-height:180px;overflow:auto;color:#aeb8c5;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  .ac-approval-actions{display:flex;justify-content:flex-end;gap:7px;padding:9px 11px;border-top:1px solid #202731}
  .ac-approval-actions button{height:29px;padding:0 12px;border-radius:7px;cursor:pointer;font:600 10px Inter,ui-sans-serif,system-ui,sans-serif}
  .ac-approval-actions button:disabled{cursor:default;opacity:.55}
  .ac-approval-deny{border:1px solid #353e49;background:#151a21;color:#aeb7c4}
  .ac-approval-deny:not(:disabled):hover{background:#1c222b;color:#edf1f6}
  .ac-approval-approve{border:1px solid #cbd3dd;background:#e1e7ee;color:#0a0e13}
  .ac-approval-approve:not(:disabled):hover{background:#f1f4f7}
  @media(max-width:720px){.ac-approval-root{width:calc(100% - 24px)}}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);

const root = document.createElement('section');
root.className = 'ac-approval-root';
root.setAttribute('aria-live', 'polite');
root.hidden = true;
chatArea.insertBefore(root, composer);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function approvalIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.8 3 7.9 7.5 9.5 4.5-1.6 7.5-4.7 7.5-9.5V6Z"/><path d="M9 12.5 11 14l4-4"/></svg>';
}

function stringInput(approval: Approval, key: string): string {
  const value = approval.toolCall.input[key];
  return typeof value === 'string' ? value : '';
}

function friendlyToolName(name: string): string {
  const names: Record<string, string> = {
    run_command: 'Executar comando',
    create_file: 'Criar arquivo',
    write_file: 'Alterar arquivo',
    delete_file: 'Excluir arquivo',
    rename_file: 'Mover ou renomear arquivo',
    git_create_branch: 'Criar branch',
    git_checkout: 'Trocar branch',
    git_stage: 'Preparar arquivos para commit',
    git_stage_all: 'Preparar alterações para commit',
    git_commit: 'Criar commit',
  };
  return names[name] || name;
}

function primaryDetail(approval: Approval): string {
  const name = approval.toolCall.name;
  if (name === 'run_command') return stringInput(approval, 'command');
  if (name === 'rename_file') return `${stringInput(approval, 'from')} → ${stringInput(approval, 'to')}`.trim();
  return stringInput(approval, 'path') || stringInput(approval, 'name');
}

function diffMeta(approval: Approval): string {
  const summary = approval.diffPlan?.summary;
  if (!summary) return '';
  const parts: string[] = [];
  if (summary.files) parts.push(`${summary.files} arquivo${summary.files === 1 ? '' : 's'}`);
  if (summary.addedLines) parts.push(`+${summary.addedLines}`);
  if (summary.removedLines) parts.push(`-${summary.removedLines}`);
  return parts.join(' · ');
}

function safeInput(approval: Approval): string {
  const input = { ...approval.toolCall.input };
  for (const key of ['content', 'text', 'body']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 1200) input[key] = `${value.slice(0, 1200)}\n… (${value.length - 1200} caracteres ocultos)`;
  }
  return JSON.stringify(input, null, 2);
}

function render(approvals: Approval[]): void {
  const validIds = new Set(approvals.map((approval) => approval.id));
  for (const id of processing.keys()) if (!validIds.has(id)) processing.delete(id);

  if (!approvals.length) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }

  const anyProcessing = processing.size > 0;
  root.innerHTML = `${approvals.length > 1 ? `<div class="ac-approval-summary"><span>${approvals.length} operações aguardam sua decisão</span><span>Você pode revisar cada uma separadamente</span></div>` : ''}${approvals.map((approval, index) => {
    const isProcessing = processing.has(approval.id);
    const detail = primaryDetail(approval);
    const meta = diffMeta(approval);
    return `
      <article class="ac-approval-card" data-ac-approval="${escapeHtml(approval.id)}" data-processing="${String(anyProcessing)}">
        <div class="ac-approval-head">
          <span class="ac-approval-icon">${approvalIcon()}</span>
          <div class="ac-approval-copy">
            <span>${approvals.length > 1 ? `Aprovação ${index + 1} de ${approvals.length}` : 'Aprovação necessária'}</span>
            <strong>${escapeHtml(friendlyToolName(approval.toolCall.name))}</strong>
            ${detail ? `<div class="ac-approval-path" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
          </div>
        </div>
        ${meta ? `<div class="ac-approval-meta">${escapeHtml(meta)}</div>` : ''}
        <details class="ac-approval-details"><summary>Ver detalhes da operação</summary><pre class="ac-approval-input">${escapeHtml(safeInput(approval))}</pre></details>
        <div class="ac-approval-actions">
          <button type="button" class="ac-approval-deny" data-deny="${escapeHtml(approval.id)}" ${anyProcessing ? 'disabled' : ''}>${isProcessing ? 'Processando…' : 'Recusar'}</button>
          <button type="button" class="ac-approval-approve" data-approve="${escapeHtml(approval.id)}" ${anyProcessing ? 'disabled' : ''}>${isProcessing ? 'Processando…' : 'Aprovar'}</button>
        </div>
      </article>`;
  }).join('')}`;
  root.hidden = false;
}

async function refresh(): Promise<void> {
  const chatId = selectedChatId();
  activeChatId = chatId;
  const token = ++requestToken;
  if (!chatId) {
    render([]);
    return;
  }
  try {
    const approvals = (await bridge.listApprovals({ chatId })).filter((approval) => approval.chatId === chatId);
    if (token !== requestToken || selectedChatId() !== chatId) return;
    render(approvals);
  } catch {
    if (token === requestToken) render([]);
  }
}

const nav = document.querySelector<HTMLElement>('#nav-panel');
if (nav) {
  new MutationObserver(() => {
    const nextChatId = selectedChatId();
    if (nextChatId !== activeChatId) {
      processing.clear();
      void refresh();
    }
  }).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
}

bridge.onStreamEvent((event) => {
  if (event.chatId && event.chatId !== selectedChatId()) return;
  if (event.type === 'approval_required' || event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') {
    if (event.type !== 'approval_required') processing.clear();
    void refresh();
  }
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>('[data-approve], [data-deny]');
  if (!action) return;
  const id = action.dataset.approve || action.dataset.deny;
  if (!id) return;
  if (processing.size > 0) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  processing.set(id, Date.now());
  root.querySelectorAll<HTMLElement>('[data-ac-approval]').forEach((card) => { card.dataset.processing = 'true'; });
  root.querySelectorAll<HTMLButtonElement>('.ac-approval-actions button').forEach((button) => { button.disabled = true; });
  action.textContent = 'Processando…';
  window.setTimeout(() => { void refresh(); }, 250);
  window.setTimeout(() => { void refresh(); }, 1200);
}, true);

window.addEventListener('auto-codez-approval-settled', (event) => {
  const id = (event as CustomEvent<{ approvalId?: string }>).detail?.approvalId;
  if (id) processing.delete(id);
  void refresh();
});

window.addEventListener('focus', () => { void refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

void refresh();
