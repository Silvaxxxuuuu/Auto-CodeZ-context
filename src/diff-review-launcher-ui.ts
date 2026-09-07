type Approval = {
  id: string;
  chatId?: string;
  diffPlan?: { changes?: unknown[] };
};

type DiffReviewBridge = {
  listApprovals: (filters?: { chatId?: string; runId?: string }) => Promise<Approval[]>;
};

const bridge = (window as unknown as { autoCodez?: DiffReviewBridge }).autoCodez;
if (!bridge?.listApprovals) throw new Error('Infraestrutura de revisão de diff indisponível.');

const style = document.createElement('style');
style.id = 'auto-codez-diff-review-launcher';
style.textContent = `
.ac-approval-review{height:29px;padding:0 12px;border:1px solid #353f4b;border-radius:7px;background:#161d25;color:#c7d0db;cursor:pointer;font:600 10px Inter,ui-sans-serif,system-ui,sans-serif;margin-right:auto}
.ac-approval-review:hover{background:#202a35;color:#f0f4f8}
.ac-approval-review:disabled{opacity:.55;cursor:default}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);

let hydrateToken = 0;
let scheduled = false;

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function approvalProcessing(): boolean {
  return Boolean(document.querySelector('.ac-approval-root [data-processing="true"]'));
}

async function hydrate(): Promise<void> {
  scheduled = false;
  const chatId = selectedChatId();
  const token = ++hydrateToken;
  if (!chatId) return;
  const approvals = await bridge.listApprovals({ chatId }).catch((): Approval[] => []);
  if (token !== hydrateToken || selectedChatId() !== chatId) return;
  const reviewable = new Set(approvals.filter((approval) => approval.chatId === chatId && approval.diffPlan?.changes?.length).map((approval) => approval.id));
  const processing = approvalProcessing();
  document.querySelectorAll<HTMLElement>('[data-ac-approval]').forEach((card) => {
    const approvalId = card.dataset.acApproval || '';
    const actions = card.querySelector<HTMLElement>('.ac-approval-actions');
    const existing = card.querySelector<HTMLButtonElement>('.ac-approval-review');
    if (!reviewable.has(approvalId) || !actions) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.disabled = processing;
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ac-approval-review';
    button.dataset.diffReview = approvalId;
    button.textContent = 'Revisar alterações';
    button.disabled = processing;
    actions.prepend(button);
  });
}

function scheduleHydrate(): void {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => { void hydrate(); }, 0);
}

const approvalRoot = document.querySelector<HTMLElement>('.ac-approval-root');
if (approvalRoot) new MutationObserver(scheduleHydrate).observe(approvalRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-processing'] });

const nav = document.querySelector<HTMLElement>('#nav-panel');
if (nav) new MutationObserver(scheduleHydrate).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-diff-review]');
  if (!target?.dataset.diffReview) return;
  if (target.disabled || approvalProcessing()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const approvalId = target.dataset.diffReview;
  target.disabled = true;
  target.textContent = 'Abrindo revisão…';
  try {
    await import('./diff-ui');
    document.dispatchEvent(new CustomEvent('auto-codez-open-diff-review', { detail: { approvalId } }));
  } finally {
    if (target.isConnected) {
      target.disabled = approvalProcessing();
      target.textContent = 'Revisar alterações';
    }
  }
}, true);

window.addEventListener('focus', scheduleHydrate);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleHydrate(); });

scheduleHydrate();
