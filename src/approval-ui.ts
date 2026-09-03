type ApprovalUiEvent = { type?: string; chatId?: string; pendingApprovalIds?: string[] };
type ApprovalUiBridge = {
  onStreamEvent: (listener: (event: ApprovalUiEvent) => void) => () => void;
  approveTool: (approvalId: string) => Promise<unknown>;
  denyTool: (approvalId: string) => Promise<unknown>;
  listApprovals: () => Promise<Array<{ id: string; toolCall: { name: string; input: Record<string, unknown> } }>>;
};

const bridge = (window as unknown as { autoCodez?: ApprovalUiBridge }).autoCodez;
const STYLE_ID = 'auto-codez-approval-ui';
let activeChatId: string | undefined;
const approvalIdsByChat = new Map<string, string[]>();
let rootElement: HTMLElement | null = null;

function currentChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
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

async function render(): Promise<void> {
  const chatId = currentChatId();
  if (!chatId || chatId !== activeChatId) return;
  const ids = approvalIdsByChat.get(chatId) || [];
  const root = ensureRoot();
  if (!root) return;
  if (!ids.length || !bridge) {
    root.innerHTML = '';
    return;
  }
  const approvals = await bridge.listApprovals();
  const visible = approvals.filter((approval) => ids.includes(approval.id));
  root.innerHTML = visible.map((approval) => `<div class="ac-approval-card" data-approval="${escapeHtml(approval.id)}"><div class="ac-approval-heading">Aprovação necessária</div><div class="ac-approval-tool">${escapeHtml(approval.toolCall.name)}</div><div class="ac-approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</div><div class="ac-approval-actions"><button data-ac-approve="${escapeHtml(approval.id)}">Aprovar</button><button class="ac-approval-deny" data-ac-deny="${escapeHtml(approval.id)}">Recusar</button></div></div>`).join('');
}

function syncChat(): void {
  const chatId = currentChatId();
  if (chatId === activeChatId) return;
  activeChatId = chatId;
  rootElement?.remove();
  rootElement = null;
  void render();
}

async function handleAction(event: Event): Promise<void> {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('[data-ac-approve],[data-ac-deny]');
  if (!button || !bridge) return;
  const approvalId = button.dataset.acApprove || button.dataset.acDeny;
  if (!approvalId) return;
  button.disabled = true;
  try {
    if (button.dataset.acApprove) await bridge.approveTool(approvalId);
    else await bridge.denyTool(approvalId);
    const chatId = activeChatId;
    if (chatId) approvalIdsByChat.set(chatId, (approvalIdsByChat.get(chatId) || []).filter((id) => id !== approvalId));
    await render();
  } catch {
    button.disabled = false;
  }
}

function handleStreamEvent(event: ApprovalUiEvent): void {
  if (event.type !== 'approval_required' || !event.chatId || !event.pendingApprovalIds?.length) return;
  approvalIdsByChat.set(event.chatId, [...event.pendingApprovalIds]);
  activeChatId = currentChatId();
  if (activeChatId === event.chatId) void render();
}

function initialize(): void {
  installStyle();
  activeChatId = currentChatId();
  bridge?.onStreamEvent(handleStreamEvent);
  document.addEventListener('click', (event) => void handleAction(event), true);
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) new MutationObserver(syncChat).observe(nav, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
