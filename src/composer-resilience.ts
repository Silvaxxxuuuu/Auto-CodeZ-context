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
let periodicTimer: number | null = null;

function activeChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat;
}

function applyLocked(locked: boolean): void {
  prompt.disabled = locked;
  prompt.dataset.executionLocked = String(locked);
  sendButton.dataset.executionLocked = String(locked);
  sendButton.disabled = locked || !activeChatId() || !prompt.value.trim();
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

    const ownedApprovals = approvals.filter((approval) => approval.chatId === chatId);
    const hasApprovals = ownedApprovals.length > 0;
    const running = execution?.state === 'running';
    const waiting = execution?.state === 'waiting_approval';
    const locked = running || hasApprovals || (waiting && hasApprovals);
    applyLocked(locked);
  } catch {
    // Preserve the current UI state on transient IPC failures.
  }
}

function ensurePeriodicSync(): void {
  if (periodicTimer !== null) return;
  periodicTimer = window.setInterval(() => {
    void sync();
  }, 1500);
}

bridge.onStreamEvent((event): void => {
  if (event.chatId && event.chatId !== activeChatId()) return;
  void sync();
  if (event.type === 'start' || event.type === 'approval_required') ensurePeriodicSync();
});

prompt.addEventListener('input', () => { void sync(); });
window.addEventListener('focus', () => { void sync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
window.addEventListener('auto-codez-chat-refresh', () => { void sync(); });
window.addEventListener('auto-codez-execution-refresh', () => { void sync(); });

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-chat], [data-approve], [data-deny]')) {
    window.setTimeout(() => { void sync(); }, 0);
    window.setTimeout(() => { void sync(); }, 300);
    window.setTimeout(() => { void sync(); }, 1200);
  }
}, true);

ensurePeriodicSync();
void sync();
