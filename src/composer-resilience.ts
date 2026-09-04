type ExecutionSnapshot = { state?: string } | null;
type Approval = { id: string; chatId?: string };
type ComposerBridge = {
  listExecutions: (chatId?: string) => Promise<ExecutionSnapshot>;
  listApprovals: (filters?: { chatId?: string }) => Promise<Approval[]>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string }) => void) => () => void;
};

const bridge = window.autoCodez as unknown as ComposerBridge;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
const sendButton = document.querySelector<HTMLButtonElement>('#send-button');
if (!prompt || !sendButton) throw new Error('Composer não encontrado.');

let recoveryTimer: number | null = null;
let checkInFlight = false;

function activeChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function release(): void {
  prompt.disabled = false;
  prompt.dataset.executionLocked = 'false';
  sendButton.dataset.executionLocked = 'false';
  sendButton.disabled = !activeChatId() || !prompt.value.trim();
}

async function verify(): Promise<void> {
  if (!prompt.disabled || checkInFlight) return;
  const chatId = activeChatId();
  if (!chatId) {
    release();
    return;
  }

  checkInFlight = true;
  try {
    const execution = await bridge.listExecutions(chatId);
    if (execution?.state === 'waiting_approval') {
      const approvals = (await bridge.listApprovals({ chatId })).filter((approval) => approval.chatId === chatId);
      if (!approvals.length) release();
      return;
    }
    if (execution?.state !== 'running') release();
  } catch {
    // Falhas transitórias de IPC não devem alterar uma execução realmente ativa.
  } finally {
    checkInFlight = false;
  }
}

function startRecovery(): void {
  if (recoveryTimer !== null) return;
  recoveryTimer = window.setInterval((): void => {
    if (!prompt.disabled) {
      window.clearInterval(recoveryTimer!);
      recoveryTimer = null;
      return;
    }
    void verify();
  }, 750);
}

bridge.onStreamEvent((event): void => {
  if (event.chatId && event.chatId !== activeChatId()) return;
  if (event.type === 'start' || event.type === 'approval_required') startRecovery();
  if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') {
    window.setTimeout((): void => { void verify(); }, 0);
  }
});

window.addEventListener('focus', (): void => { void verify(); });
document.addEventListener('visibilitychange', (): void => {
  if (!document.hidden) void verify();
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-approve], [data-deny]')) {
    window.setTimeout((): void => { void verify(); }, 250);
    window.setTimeout((): void => { void verify(); }, 900);
  }
}, true);

startRecovery();
