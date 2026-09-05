type ExecutionSnapshot = { state?: string; runId?: string; updatedAt?: number } | null;
type Approval = { id: string; chatId?: string; runId?: string };
type ComposerBridge = {
  listExecutions: (chatId?: string) => Promise<ExecutionSnapshot>;
  listApprovals: (filters?: { chatId?: string }) => Promise<Approval[]>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string }) => void) => () => void;
};

const bridge = window.autoCodez as unknown as ComposerBridge;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
const sendButton = document.querySelector<HTMLButtonElement>('#send-button');
if (!prompt || !sendButton) throw new Error('Composer não encontrado.');

let syncToken = 0;
let syncTimer: number | null = null;
let locked = false;

function activeChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat;
}

function syncLocalAvailability(): void {
  sendButton.disabled = locked || !activeChatId() || !prompt.value.trim();
}

function applyLocked(nextLocked: boolean): void {
  locked = nextLocked;
  prompt.disabled = nextLocked;
  prompt.dataset.executionLocked = String(nextLocked);
  sendButton.dataset.executionLocked = String(nextLocked);
  syncLocalAvailability();
}

async function sync(): Promise<void> {
  const chatId = activeChatId();
  const token = ++syncToken;
  if (!chatId) {
    applyLocked(false);
    return;
  }

  try {
    const [execution, approvals] = await Promise.all([
      bridge.listExecutions(chatId),
      bridge.listApprovals({ chatId }),
    ]);
    if (token !== syncToken || activeChatId() !== chatId) return;

    const hasApprovals = approvals.some((approval) => approval.chatId === chatId);
    const running = execution?.state === 'running';
    const waiting = execution?.state === 'waiting_approval';
    applyLocked(Boolean(running || waiting || hasApprovals));
  } catch {
    syncLocalAvailability();
  }
}

function scheduleSync(delay = 0): void {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void sync();
  }, delay);
}

bridge.onStreamEvent((event): void => {
  if (event.chatId && event.chatId !== activeChatId()) return;
  scheduleSync();
});

prompt.addEventListener('input', syncLocalAvailability);
window.addEventListener('focus', () => scheduleSync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
window.addEventListener('auto-codez-chat-refresh', () => scheduleSync());
window.addEventListener('auto-codez-execution-refresh', () => scheduleSync());
window.addEventListener('auto-codez-approval-settled', () => scheduleSync());

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-chat], [data-approve], [data-deny]')) {
    scheduleSync();
    window.setTimeout(() => scheduleSync(), 300);
  }
}, true);

window.addEventListener('beforeunload', () => {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
}, { once: true });

void sync();
