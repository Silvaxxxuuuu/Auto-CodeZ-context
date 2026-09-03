type ApprovalUiEvent = { type?: string; chatId?: string; runId?: string; pendingApprovalIds?: string[] };
type ApprovalUiBridge = {
  onStreamEvent: (listener: (event: ApprovalUiEvent) => void) => () => void;
  approveTool: (approvalId: string) => Promise<unknown>;
  denyTool: (approvalId: string) => Promise<unknown>;
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Array<{ id: string; chatId?: string; runId?: string; toolCall: { name: string; input: Record<string, unknown> } }>>;
};

const bridge = (window as unknown as { autoCodez?: ApprovalUiBridge }).autoCodez;
const STYLE_ID = 'auto-codez-approval-ui';
let activeChatId: string | undefined;
let activeRunId: string | undefined;
const approvalIdsByRun = new Map<string, string[]>();
let rootElement: HTMLElement | null = null;

function currentChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function currentRunId(): string | undefined {
  const run = document.querySelector<HTMLElement>('.execution-run[data-run-id]');
  return run?.dataset.runId;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ac-approval-root{max-width:800px;margin:10px auto 20px}
    .ac-approval-card{padding:13px;border:1px solid #2a323d;border-radius:10px;background:#10151b}
    .ac-approval-heading{font-size:11px;font-weight:650;color:#dce2e9}
    .ac-approval-tool{margin-top:5px;color:#aeb7c3;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
    .ac-approval-input{margin-top:8px;max-height:150px;overflow:auto;padding:8px;border:1px solid #222a34;border-radius:7px;background:#0a0e13;color:#818b99;font:9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}
    .ac-approval-actions{display:flex;gap:7px;margin-top:9px}
    .ac-approval-actions button{flex:1;padding:8px 10px;border:1px solid #303946;border-radius:8px;background:#171d25;color:#dce2e9;font:600 10px Inter,ui-sans-serif,system-ui;cursor:pointer}
    .ac-approval-actions button:hover{background:#202731}
    .ac-approval-actions .ac-approval-deny{border-color:#493238;background:#171015;color:#d7a0a6}
  `;
  document.head.appendChild(style);
}

function ensureRoot(): HTMLElement | null {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return null;
  if (!rootElement?.isConnected || rootElement.parentElement !== messages) {
    rootElement = document.createElement('div');
    rootElement.className = 'ac-approval-root';
    messages.appendChild(rootElement);
  }
  return rootElement;
}

async function syncApprovals(): Promise<void> {
  if (!bridge) return;
  const chatId = currentChatId();
  if (!chatId) return;
  const runId = currentRunId();
  const approvals = await bridge.listApprovals({ chatId, ...(runId ? { runId } : {}) });
  const ids = approvals.filter((approval) => approval.chatId === chatId && (!runId || !approval.runId || approval.runId === runId)).map((approval) => approval.id);
  if (runId) approvalIdsByRun.set(runId, ids);
  activeRunId = runId;
  await render();
}

async function render(): Promise<void> {
  const chatId = currentChatId();
  if (!chatId || chatId !== activeChatId) return;
  const runId = activeRunId || currentRunId();
  const ids = runId ? approvalIdsByRun.get(runId) || [] : [];
  const root = ensureRoot();
  if (!root) return;
  if (!ids.length || !bridge) {
    root.innerHTML = '';
    return;
  }
  const approvals = await bridge.listApprovals({ chatId, ...(runId ? { runId } : {}) });
  const visible = approvals.filter((approval) => approval.chatId === chatId && (!runId || !approval.runId || approval.runId === runId) && ids.includes(approval.id));
  root.innerHTML = visible.map((approval) => `<div class="ac-approval-card" data-approval="${escapeHtml(approval.id)}"><div class="ac-approval-heading">Aprovação necessária</div><div class="ac-approval-tool">${escapeHtml(approval.toolCall.name)}</div><div class="ac-approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</div><div class="ac-approval-actions"><button data-ac-approve="${escapeHtml(approval.id)}">Aprovar</button><button class="ac-approval-deny" data-ac-deny="${escapeHtml(approval.id)}">Recusar</button></div></div>`).join('');
}

function syncChat(): void {
  const chatId = currentChatId();
  if (chatId === activeChatId) {
    const runId = currentRunId();
    if (runId !== activeRunId) void syncApprovals();
    return;
  }
  activeChatId = chatId;
  activeRunId = currentRunId();
  rootElement?.remove();
  rootElement = null;
  void syncApprovals();
}

async function handleAction(event: Event): Promise<void> {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('[data-ac-approve],[data-ac-deny]');
  if (!button || !bridge) return;
  const approvalId = button.dataset.acApprove || button.dataset.acDeny;
  if (!approvalId) return;
  button.disabled = true;
  try {
    const approval = (await bridge.listApprovals({ chatId: currentChatId(), ...(activeRunId ? { runId: activeRunId } : {}) })).find((item) => item.id === approvalId);
    if (!approval || approval.chatId !== currentChatId() || (activeRunId && approval.runId && approval.runId !== activeRunId)) throw new Error('Aprovação fora do contexto atual.');
    if (button.dataset.acApprove) await bridge.approveTool(approvalId);
    else await bridge.denyTool(approvalId);
    if (approval.chatId) window.dispatchEvent(new CustomEvent('auto-codez-execution-refresh', { detail: { chatId: approval.chatId } }));
    await syncApprovals();
  } catch {
    button.disabled = false;
  }
}

function handleStreamEvent(event: ApprovalUiEvent): void {
  if (event.type !== 'approval_required' || !event.chatId || !event.runId || !event.pendingApprovalIds?.length) return;
  approvalIdsByRun.set(event.runId, [...event.pendingApprovalIds]);
  activeChatId = currentChatId();
  activeRunId = currentRunId() || event.runId;
  if (activeChatId === event.chatId && activeRunId === event.runId) void render();
}

function initialize(): void {
  installStyle();
  activeChatId = currentChatId();
  activeRunId = currentRunId();
  bridge?.onStreamEvent(handleStreamEvent);
  document.addEventListener('click', (event) => void handleAction(event), true);
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) new MutationObserver(syncChat).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
  const executionRoot = document.querySelector<HTMLElement>('.chat-area');
  if (executionRoot) new MutationObserver(syncChat).observe(executionRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-run-id'] });
  void syncApprovals();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
