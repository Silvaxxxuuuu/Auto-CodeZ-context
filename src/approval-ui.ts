type Approval = { id: string; chatId?: string; runId?: string; toolCall: { name: string; input: Record<string, unknown> } };
type Bridge = { onStreamEvent: (listener: (event: { type?: string; chatId?: string; runId?: string; pendingApprovalIds?: string[] }) => void) => () => void; approveTool: (id: string, filters?: { chatId?: string; runId?: string }) => Promise<unknown>; denyTool: (id: string, filters?: { chatId?: string; runId?: string }) => Promise<unknown>; listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]> };

const bridge = (window as unknown as { autoCodez?: Bridge }).autoCodez;
let activeChatId: string | undefined;
let rootElement: HTMLElement | null = null;
let syncInFlight = false;

function chatId(): string | undefined { return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
function installStyle(): void {
  if (document.getElementById('auto-codez-approval-ui')) return;
  const style = document.createElement('style'); style.id = 'auto-codez-approval-ui';
  style.textContent = `.ac-approval-root{max-width:800px;margin:12px auto 20px}.ac-approval-card{padding:14px;border:1px solid #2f3845;border-radius:10px;background:#10151b}.ac-approval-heading{font-size:11px;font-weight:650;color:#dce2e9}.ac-approval-tool{margin-top:5px;color:#aeb7c3;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}.ac-approval-input{margin-top:8px;max-height:180px;overflow:auto;padding:9px;border:1px solid #222a34;border-radius:7px;background:#0a0e13;color:#9aa4b1;font:9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.ac-approval-message{margin-top:8px;color:#aeb7c3;font-size:11px}.ac-approval-actions{display:flex;gap:7px;margin-top:10px}.ac-approval-actions button{flex:1;padding:8px 10px;border:1px solid #303946;border-radius:8px;background:#171d25;color:#dce2e9;font:600 10px Inter,ui-sans-serif,system-ui;cursor:pointer}.ac-approval-actions button:disabled{opacity:.5;cursor:default}.ac-approval-actions .deny{border-color:#493238;background:#171015;color:#d7a0a6}`;
  document.head.appendChild(style);
}
function ensureRoot(): HTMLElement | null {
  const messages = document.querySelector<HTMLElement>('#messages'); if (!messages) return null;
  if (!rootElement?.isConnected || rootElement.parentElement !== messages) { rootElement = document.createElement('div'); rootElement.className = 'ac-approval-root'; messages.appendChild(rootElement); }
  return rootElement;
}
async function sync(): Promise<void> {
  if (!bridge || syncInFlight) return; const selected = chatId();
  if (!selected) { rootElement?.remove(); rootElement = null; return; }
  activeChatId = selected; syncInFlight = true;
  try {
    const approvals = (await bridge.listApprovals({ chatId: selected })).filter((approval) => approval.chatId === selected);
    const root = ensureRoot(); if (!root) return;
    if (!approvals.length) { root.innerHTML = ''; return; }
    root.innerHTML = approvals.map((approval) => `<article class="ac-approval-card" data-ac-approval="${escapeHtml(approval.id)}"><div class="ac-approval-heading">Aprovação necessária</div><div class="ac-approval-tool">${escapeHtml(approval.toolCall.name)}</div><div class="ac-approval-message">O Auto CodeZ está aguardando sua decisão para continuar esta execução.</div><pre class="ac-approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</pre><div class="ac-approval-actions"><button data-ac-approve="${escapeHtml(approval.id)}">Aprovar</button><button class="deny" data-ac-deny="${escapeHtml(approval.id)}">Recusar</button></div></article>`).join('');
  } catch { /* approval UI is best-effort */ } finally { syncInFlight = false; }
}
async function action(event: Event): Promise<void> {
  const target = event.target as HTMLElement | null; const button = target?.closest<HTMLButtonElement>('[data-ac-approve],[data-ac-deny]'); if (!button || !bridge) return;
  const id = button.dataset.acApprove || button.dataset.acDeny; if (!id) return; button.disabled = true;
  try {
    const selected = chatId(); if (!selected) throw new Error('Chat não selecionado.');
    const approval = (await bridge.listApprovals({ chatId: selected })).find((item) => item.id === id && item.chatId === selected); if (!approval) throw new Error('Aprovação não encontrada neste chat.');
    const scope = { chatId: selected, ...(approval.runId ? { runId: approval.runId } : {}) };
    if (button.dataset.acApprove) await bridge.approveTool(id, scope); else await bridge.denyTool(id, scope);
    window.dispatchEvent(new CustomEvent('auto-codez-execution-refresh', { detail: { chatId: selected, runId: approval.runId } }));
    await sync();
  } catch { button.disabled = false; }
}
function initialize(): void {
  installStyle(); activeChatId = chatId(); bridge?.onStreamEvent((event) => { if (event.chatId === activeChatId || event.type === 'approval_required') void sync(); });
  document.addEventListener('click', (event) => void action(event), true);
  const observer = new MutationObserver(() => { const next = chatId(); if (next !== activeChatId) { activeChatId = next; rootElement?.remove(); rootElement = null; } void sync(); });
  const nav = document.querySelector<HTMLElement>('#nav-panel'); if (nav) observer.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
  const messages = document.querySelector<HTMLElement>('#messages'); if (messages) new MutationObserver(() => { if (!syncInFlight) void sync(); }).observe(messages, { childList: true, subtree: true });
  window.setInterval(() => { if (chatId()) void sync(); }, 400);
  void sync();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
