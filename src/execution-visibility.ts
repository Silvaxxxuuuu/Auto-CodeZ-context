import { ExecutionManager, type ExecutionSnapshot } from './execution-manager';

type StreamExecutionEvent = {
  type?: string;
  chatId?: string;
  runId?: string;
  toolCall?: { name?: string };
  error?: string;
};

type StreamBridge = {
  onStreamEvent: (listener: (event: StreamExecutionEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: StreamBridge }).autoCodez;
const manager = new ExecutionManager();
const STYLE_ID = 'auto-codez-execution-visibility';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .chat-item .execution-indicator{display:none;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px;margin:0;color:#7fa9ed}
    .chat-item .execution-indicator svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .chat-item.is-executing .execution-indicator{display:inline-flex}
    .chat-item.is-executing .execution-indicator::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px currentColor;opacity:.12}
    .chat-item.is-executing .execution-indicator::after{content:'';position:absolute;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9;animation:ac-execution-pulse 1.15s ease-in-out infinite}
    .chat-item.is-waiting-approval .execution-indicator{color:#e6b95c}
    .chat-item.is-failed .execution-indicator{color:#d98289}
    .chat-item .execution-indicator{position:relative}
    .chat-item.is-executing .chat-item-copy>span::after{content:none!important}
    @keyframes ac-execution-pulse{0%,100%{transform:scale(.75);opacity:.45}50%{transform:scale(1);opacity:1}}
    @media(prefers-reduced-motion:reduce){.chat-item.is-executing .execution-indicator::after{animation:none}}
  `;
  document.head.appendChild(style);
}

function active(snapshot: ExecutionSnapshot | undefined): boolean {
  return snapshot?.state === 'running' || snapshot?.state === 'waiting_approval';
}

function indicatorMarkup(snapshot: ExecutionSnapshot): string {
  const label = snapshot.state === 'waiting_approval' ? 'Aguardando aprovação' : snapshot.currentTool ? `Executando ${snapshot.currentTool}` : 'Executando';
  return `<span class="execution-indicator" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}"></span>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function syncChatItems(): void {
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (!nav) return;
  nav.querySelectorAll<HTMLElement>('.chat-item[data-chat]').forEach((item) => {
    const chatId = item.dataset.chat;
    if (!chatId) return;
    const snapshot = manager.get(chatId);
    item.classList.toggle('is-executing', active(snapshot));
    item.classList.toggle('is-waiting-approval', snapshot?.state === 'waiting_approval');
    item.classList.toggle('is-failed', snapshot?.state === 'failed');
    const existing = item.querySelector<HTMLElement>(':scope > .execution-indicator');
    if (active(snapshot)) {
      if (!existing) item.insertAdjacentHTML('afterbegin', indicatorMarkup(snapshot));
      else {
        existing.title = snapshot.state === 'waiting_approval' ? 'Aguardando aprovação' : snapshot.currentTool ? `Executando ${snapshot.currentTool}` : 'Executando';
        existing.setAttribute('aria-label', existing.title);
      }
    } else {
      existing?.remove();
    }
  });
}

function syncComposer(): void {
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  const selected = nav?.querySelector<HTMLElement>('.chat-item.selected[data-chat]');
  const chatId = selected?.dataset.chat;
  const snapshot = chatId ? manager.get(chatId) : undefined;
  const busy = active(snapshot);
  const send = document.querySelector<HTMLButtonElement>('#send-button');
  const input = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (send) {
    send.dataset.executionLocked = busy ? 'true' : 'false';
    send.disabled = busy;
    send.title = snapshot?.state === 'waiting_approval' ? 'Aguardando aprovação' : busy ? 'Execução em andamento' : 'Enviar';
  }
  if (input) input.dataset.executionLocked = busy ? 'true' : 'false';
}

function syncUi(): void {
  syncChatItems();
  syncComposer();
}

function handleEvent(event: StreamExecutionEvent): void {
  if (!event.chatId) return;
  try {
    if (event.type === 'start') {
      const snapshot = manager.start(event.chatId);
      if (event.runId && snapshot.runId !== event.runId) manager.update(event.chatId, { state: 'running' });
    } else if (event.type === 'tool_call') {
      if (manager.get(event.chatId)) manager.update(event.chatId, { state: 'running', currentTool: event.toolCall?.name });
    } else if (event.type === 'approval_required') {
      if (manager.get(event.chatId)) manager.update(event.chatId, { state: 'waiting_approval' });
    } else if (event.type === 'complete') {
      if (manager.get(event.chatId)) manager.update(event.chatId, { state: 'completed' });
    } else if (event.type === 'error') {
      if (manager.get(event.chatId)) manager.update(event.chatId, { state: 'failed', error: event.error });
    }
  } catch {
    // A duplicate/stale stream event must never affect the renderer.
  }
  syncUi();
}

function initialize(): void {
  installStyle();
  if (bridge?.onStreamEvent) bridge.onStreamEvent(handleEvent);

  // Only the navigation can affect execution-item placement/selection. Observing the
  // whole document made every streaming DOM mutation trigger a full UI rescan.
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) {
    const observer = new MutationObserver(syncUi);
    observer.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (!(target instanceof HTMLTextAreaElement) || target.id !== 'prompt') return;
    if (target.dataset.executionLocked === 'true') event.preventDefault();
  }, true);
  syncUi();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
