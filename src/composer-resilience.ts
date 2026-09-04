type ExecutionSnapshot = { state?: string } | null;
type ComposerBridge = {
  listExecutions: (chatId?: string) => Promise<ExecutionSnapshot>;
  onStreamEvent: (listener: (event: { type?: string; chatId?: string }) => void) => () => void;
};

const bridge = window.autoCodez as unknown as ComposerBridge;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
const sendButton = document.querySelector<HTMLButtonElement>('#send-button');
if (!prompt || !sendButton) throw new Error('Composer não encontrado.');

let recoveryTimer: number | null = null;
let checkInFlight = false;

function activeChatId(): string | undefined { return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat; }
function release(): void { prompt.disabled = false; sendButton.disabled = !activeChatId() || !prompt.value.trim(); }

async function verify(): Promise<void> {
  if (!prompt.disabled || checkInFlight) return;
  const chatId = activeChatId();
  if (!chatId) { release(); return; }
  checkInFlight = true;
  try {
    const execution = await bridge.listExecutions(chatId);
    if (execution?.state !== 'running' && execution?.state !== 'waiting_approval') release();
  } catch { /* IPC transitório não deve alterar o estado do composer. */ }
  finally { checkInFlight = false; }
}

function startRecovery(): void {
  if (recoveryTimer !== null) return;
  recoveryTimer = window.setInterval(() => {
    if (!prompt.disabled) { window.clearInterval(recoveryTimer!); recoveryTimer = null; return; }
    void verify();
  }, 750);
}

bridge.onStreamEvent((event) => {
  if (event.chatId && event.chatId !== activeChatId()) return;
  if (event.type === 'start') startRecovery();
  if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') window.setTimeout(() => void verify(), 0);
});

window.addEventListener('focus', () => void verify());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void verify(); });
startRecovery();
