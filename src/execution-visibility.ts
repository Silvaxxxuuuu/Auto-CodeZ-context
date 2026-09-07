import { ExecutionManager, type ExecutionChange, type ExecutionSnapshot, type ExecutionState } from './execution-manager';

type ExecutionBridge = {
  onExecutionEvent?: (listener: (event: ExecutionChange) => void) => () => void;
  listExecutions?: () => Promise<unknown>;
};

const bridge = (window as unknown as { autoCodez?: ExecutionBridge }).autoCodez;
const manager = new ExecutionManager();
const STYLE_ID = 'auto-codez-execution-visibility';
const EXECUTION_STATES = new Set<ExecutionState>(['idle', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted']);
let hydrateToken = 0;

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
    .activity-card{max-width:800px!important;margin:2px auto 20px!important;padding:2px 0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}
    .activity-heading{height:18px;margin:0 0 2px!important;padding:0!important;font-size:0!important;letter-spacing:0!important;color:#687281!important;text-transform:none!important}
    .activity-heading::before{content:'•••';display:inline-block;font-size:12px;letter-spacing:3px;line-height:18px;color:#727d8c;animation:ac-thinking 1.15s ease-in-out infinite}
    .activity-line{padding:2px 0!important;font-size:10px!important;line-height:1.5!important;color:#6f7987!important}
    .activity-line.running{color:#8b95a3!important}
    .activity-line.done{color:#7f8997!important}
    .activity-line.error{color:#d18c8c!important}
    .approval-card{margin-top:9px}
    @keyframes ac-execution-pulse{0%,100%{transform:scale(.75);opacity:.45}50%{transform:scale(1);opacity:1}}
    @keyframes ac-thinking{0%,100%{opacity:.28;transform:translateY(0)}50%{opacity:1;transform:translateY(-1px)}}
    @media(prefers-reduced-motion:reduce){.chat-item.is-executing .execution-indicator::after,.activity-heading::before{animation:none}}
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
    send.disabled = busy || !chatId || !input?.value.trim();
    send.title = snapshot?.state === 'waiting_approval' ? 'Aguardando aprovação' : busy ? 'Execução em andamento' : 'Enviar';
  }
  if (input) input.dataset.executionLocked = busy ? 'true' : 'false';
}

function syncUi(): void {
  syncChatItems();
  syncComposer();
}

function isSnapshot(value: unknown): value is ExecutionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ExecutionSnapshot>;
  return typeof snapshot.chatId === 'string'
    && typeof snapshot.runId === 'string'
    && typeof snapshot.state === 'string'
    && EXECUTION_STATES.has(snapshot.state as ExecutionState)
    && typeof snapshot.startedAt === 'number'
    && Number.isFinite(snapshot.startedAt)
    && typeof snapshot.updatedAt === 'number'
    && Number.isFinite(snapshot.updatedAt)
    && snapshot.updatedAt >= snapshot.startedAt;
}

function applySnapshot(snapshot: ExecutionSnapshot): void {
  const current = manager.get(snapshot.chatId);
  if (current && current.runId === snapshot.runId && current.updatedAt > snapshot.updatedAt) return;
  manager.remove(snapshot.chatId);
  manager.start(snapshot.chatId, snapshot.startedAt, snapshot.runId);
  manager.update(snapshot.chatId, {
    state: snapshot.state,
    currentTool: snapshot.currentTool,
    error: snapshot.error,
    runId: snapshot.runId,
  }, snapshot.updatedAt);
}

function handleExecutionChange(change: ExecutionChange): void {
  if (!change || typeof change !== 'object') return;
  try {
    if (change.type === 'upsert') {
      if (!isSnapshot(change.snapshot)) return;
      applySnapshot(change.snapshot);
    } else if (change.type === 'remove') {
      if (typeof change.chatId !== 'string') return;
      const current = manager.get(change.chatId);
      if (change.runId && current?.runId !== change.runId) return;
      manager.remove(change.chatId);
    } else {
      return;
    }
    syncUi();
  } catch {
    // A malformed or stale backend snapshot must never interrupt the renderer.
  }
}

async function hydrateExecutions(): Promise<void> {
  if (!bridge?.listExecutions) return;
  const token = ++hydrateToken;
  try {
    const value = await bridge.listExecutions();
    if (token !== hydrateToken || !Array.isArray(value)) return;
    const snapshots = value.filter(isSnapshot);
    const backendChatIds = new Set(snapshots.map((snapshot) => snapshot.chatId));
    for (const snapshot of manager.list()) {
      if (!backendChatIds.has(snapshot.chatId)) manager.remove(snapshot.chatId);
    }
    for (const snapshot of snapshots) applySnapshot(snapshot);
    syncUi();
  } catch {
    // A renderer-side hydration failure must not interrupt the chat UI.
  }
}

function initialize(): void {
  installStyle();
  bridge?.onExecutionEvent?.(handleExecutionChange);
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) {
    const observer = new MutationObserver(syncUi);
    observer.observe(nav, { childList: true, subtree: true });
    nav.addEventListener('click', () => {
      queueMicrotask(syncUi);
      void hydrateExecutions();
    }, true);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (!(target instanceof HTMLTextAreaElement) || target.id !== 'prompt') return;
    if (target.dataset.executionLocked === 'true') event.preventDefault();
  }, true);
  syncUi();
  void hydrateExecutions();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
