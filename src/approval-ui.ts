type Approval = {
  id: string;
  chatId?: string;
  runId?: string;
  toolCall: { name: string; input: Record<string, unknown> };
};

type ApprovalBridge = {
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string; runId?: string }) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: ApprovalBridge }).autoCodez;
const chatArea = document.querySelector<HTMLElement>('.chat-area');
const composer = document.querySelector<HTMLElement>('.composer-wrap');

if (!bridge?.listApprovals || !bridge.onStreamEvent || !chatArea || !composer) throw new Error('Infraestrutura de aprovações indisponível.');

const style = document.createElement('style');
style.id = 'auto-codez-approval-ui';
style.textContent = `
  #messages .approval-card,.chat-execution .execution-approval{display:none!important}
  .ac-approval-root{display:flex;flex-direction:column;gap:8px;width:min(860px,calc(100% - 56px));margin:0 auto 10px;flex:none}
  .ac-approval-root[hidden]{display:none}
  .ac-approval-card{border:1px solid #313946;border-radius:12px;background:#10151c;overflow:hidden;box-shadow:0 10px 30px #0003}
  .ac-approval-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #202731}
  .ac-approval-icon{display:grid;place-items:center;width:28px;height:28px;flex:0 0 28px;border:1px solid #353f4c;border-radius:8px;color:#cbd4df;background:#151b23}
  .ac-approval-icon svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .ac-approval-title{min-width:0;display:flex;flex-direction:column;gap:2px}
  .ac-approval-title span{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#788392;font-weight:700}
  .ac-approval-title strong{font-size:11px;font-weight:650;color:#e8edf4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-approval-input{margin:0;padding:11px 14px;max-height:160px;overflow:auto;background:#0b0f14;color:#aeb8c5;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  .ac-approval-actions{display:flex;justify-content:flex-end;gap:7px;padding:10px 12px;border-top:1px solid #202731}
  .ac-approval-actions button{height:30px;padding:0 12px;border-radius:7px;cursor:pointer;font:600 10px Inter,ui-sans-serif,system-ui,sans-serif}
  .ac-approval-deny{border:1px solid #353e49;background:#151a21;color:#aeb7c4}
  .ac-approval-deny:hover{background:#1c222b;color:#edf1f6}
  .ac-approval-approve{border:1px solid #cbd3dd;background:#e1e7ee;color:#0a0e13}
  .ac-approval-approve:hover{background:#f1f4f7}
  @media(max-width:720px){.ac-approval-root{width:calc(100% - 24px)}}
`;
document.head.appendChild(style);

const root = document.createElement('section');
root.className = 'ac-approval-root';
root.setAttribute('aria-live', 'polite');
root.hidden = true;
chatArea.insertBefore(root, composer);

let activeChatId = '';
let requestToken = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function approvalIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.8 3 7.9 7.5 9.5 4.5-1.6 7.5-4.7 7.5-9.5V6Z"/><path d="M9 12.5 11 14l4-4"/></svg>';
}

function render(approvals: Approval[]): void {
  if (!approvals.length) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }

  root.innerHTML = approvals.map((approval) => `
    <article class="ac-approval-card" data-ac-approval="${escapeHtml(approval.id)}">
      <div class="ac-approval-head">
        <span class="ac-approval-icon">${approvalIcon()}</span>
        <div class="ac-approval-title"><span>Aprovação necessária</span><strong>${escapeHtml(approval.toolCall.name)}</strong></div>
      </div>
      <pre class="ac-approval-input">${escapeHtml(JSON.stringify(approval.toolCall.input, null, 2))}</pre>
      <div class="ac-approval-actions">
        <button type="button" class="ac-approval-deny" data-deny="${escapeHtml(approval.id)}">Recusar</button>
        <button type="button" class="ac-approval-approve" data-approve="${escapeHtml(approval.id)}">Aprovar</button>
      </div>
    </article>
  `).join('');
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
    if (nextChatId !== activeChatId) void refresh();
  }).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
}

bridge.onStreamEvent((event) => {
  if (event.chatId && event.chatId !== selectedChatId()) return;
  if (event.type === 'approval_required' || event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') void refresh();
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('[data-approve], [data-deny]')) return;
  window.setTimeout(() => { void refresh(); }, 100);
  window.setTimeout(() => { void refresh(); }, 500);
}, true);

void refresh();
