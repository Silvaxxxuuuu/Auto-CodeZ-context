type StreamEvent = {
  type?: string;
  chatId?: string;
  text?: string;
  activity?: { message?: string; status?: string; type?: string };
  toolCall?: { name?: string; input?: Record<string, unknown> };
};

type ExecutionSnapshot = {
  chatId: string;
  runId: string;
  state: 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  updatedAt: number;
};

type StreamBridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
  listExecutions?: () => Promise<unknown>;
};

const bridge = (window as unknown as { autoCodez?: StreamBridge }).autoCodez;
const messages = () => document.querySelector<HTMLElement>('#messages');
const STYLE_ID = 'auto-codez-thinking-ui';
type ThinkingState = {
  active: boolean;
  waitingApproval: boolean;
  runStartedAt: number;
  accumulatedMs: number;
  pausedAt: number;
  runToken: number;
};
const states = new Map<string, ThinkingState>();
let activeChatId: string | undefined;

function createState(): ThinkingState {
  return { active: false, waitingApproval: false, runStartedAt: 0, accumulatedMs: 0, pausedAt: 0, runToken: 0 };
}

function getState(chatId: string | undefined): ThinkingState | undefined {
  if (!chatId) return undefined;
  let state = states.get(chatId);
  if (!state) {
    state = createState();
    states.set(chatId, state);
  }
  return state;
}

function currentChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function syncActiveChat(): void {
  const chatId = currentChatId();
  if (chatId === activeChatId) return;
  activeChatId = chatId;
  removeThinkingStatus();
  const state = getState(chatId);
  if (state?.active) ensureStatus();
}

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ac-thinking-status{max-width:800px;margin:0 auto 7px;display:flex;align-items:center;gap:5px;color:#7b8491;font-size:11px;line-height:18px;font-weight:400}
    .ac-thinking-label{white-space:nowrap}
    .ac-thinking-dots{display:inline-flex;min-width:17px;letter-spacing:2px}
    .ac-thinking-dots span{opacity:.25;animation:ac-thinking-dot 1.05s infinite}
    .ac-thinking-dots span:nth-child(2){animation-delay:.15s}
    .ac-thinking-dots span:nth-child(3){animation-delay:.3s}
    .ac-thought-time{max-width:800px;margin:0 auto 7px;color:#737d8a;font-size:10px;line-height:16px}
    .approval-card{margin:10px 0 2px!important;padding:12px 13px!important;border:1px solid #2a323d!important;border-radius:10px!important;background:#10151b!important}
    .approval-heading{font-size:10px!important;font-weight:650!important;color:#dce2e9!important}
    .approval-tool{margin-top:5px!important;color:#aeb7c3!important;font-size:10px!important;font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important}
    .approval-input{margin-top:7px!important;max-height:150px;overflow:auto;padding:8px!important;border:1px solid #222a34!important;border-radius:7px!important;background:#0a0e13!important;color:#818b99!important;font:9px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace!important;white-space:pre-wrap}
    .approval-actions{display:flex!important;gap:7px!important;margin-top:9px!important}
    .approval-actions .primary-button,.approval-actions .danger-button{width:auto!important;flex:1;margin-top:0!important;padding:8px 10px!important}
    .danger-button{border:1px solid #493238!important;border-radius:8px!important;background:#171015!important;color:#d7a0a6!important;font-size:10px!important;font-weight:650!important;cursor:pointer}
    .danger-button:hover{background:#21161a!important}
    @keyframes ac-thinking-dot{0%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-1px)}70%{opacity:.25;transform:translateY(0)}}
    @media(prefers-reduced-motion:reduce){.ac-thinking-dots span{animation:none;opacity:.7}}
  `;
  document.head.appendChild(style);
}

function elapsed(state: ThinkingState, now = Date.now()): number {
  if (!state.runStartedAt || (state.waitingApproval && state.pausedAt)) return state.accumulatedMs;
  return state.accumulatedMs + Math.max(0, now - state.runStartedAt);
}

function formatSeconds(ms: number): string {
  const seconds = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
  return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
}

function ensureStatus(): HTMLElement | null {
  const state = getState(activeChatId);
  if (!state?.active) return null;
  const root = messages();
  if (!root) return null;
  const status = root.querySelector<HTMLElement>('.ac-thinking-status') || document.createElement('div');
  status.className = 'ac-thinking-status';
  const desired = state.waitingApproval
    ? '<span class="ac-thinking-label">Aguardando sua aprovação</span>'
    : '<span class="ac-thinking-label">Pensando</span><span class="ac-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
  if (status.innerHTML !== desired) status.innerHTML = desired;
  const anchor = root.querySelector<HTMLElement>('.message.assistant.streaming, .activity-card');
  if (anchor) {
    if (status.parentElement !== root || status.nextElementSibling !== anchor) root.insertBefore(status, anchor);
  } else if (!status.parentElement) {
    root.appendChild(status);
  }
  return status;
}

function removeThinkingStatus(): void {
  document.querySelectorAll('.ac-thinking-status').forEach((element) => element.remove());
}

function insertThoughtTime(state: ThinkingState, durationMs: number): void {
  const root = messages();
  if (!root || state.runToken !== getState(activeChatId)?.runToken) return;
  const assistantMessages = [...root.querySelectorAll<HTMLElement>('.message.assistant:not(.streaming)')];
  const lastAssistant = assistantMessages.at(-1);
  if (!lastAssistant) return;
  if (root.querySelector<HTMLElement>(`[data-ac-thought-token="${state.runToken}"]`)) return;
  const label = document.createElement('div');
  label.className = 'ac-thought-time';
  label.dataset.acThoughtToken = String(state.runToken);
  label.textContent = `Pensou por ${formatSeconds(durationMs)}`;
  lastAssistant.before(label);
}

function finishRun(chatId: string): void {
  const state = getState(chatId);
  if (!state?.active) return;
  state.accumulatedMs = elapsed(state);
  state.active = false;
  state.waitingApproval = false;
  state.pausedAt = 0;
  const duration = state.accumulatedMs;
  const token = state.runToken;
  if (chatId !== activeChatId) return;
  removeThinkingStatus();
  const tryInsert = () => {
    if (state.runToken !== token || state.active || chatId !== activeChatId) return;
    insertThoughtTime(state, duration);
  };
  tryInsert();
  window.setTimeout(tryInsert, 0);
  window.setTimeout(tryInsert, 60);
  window.setTimeout(tryInsert, 250);
}

function hydrateExecutions(): void {
  if (!bridge?.listExecutions) return;
  void bridge.listExecutions().then((value) => {
    if (!Array.isArray(value)) return;
    const snapshots = value.filter((item): item is ExecutionSnapshot => {
      if (!item || typeof item !== 'object') return false;
      const snapshot = item as Partial<ExecutionSnapshot>;
      return typeof snapshot.chatId === 'string' && typeof snapshot.runId === 'string' && typeof snapshot.state === 'string' && typeof snapshot.startedAt === 'number';
    });
    const activeSnapshots = new Map(snapshots.filter((snapshot) => snapshot.state === 'running' || snapshot.state === 'waiting_approval').map((snapshot) => [snapshot.chatId, snapshot]));
    for (const [chatId, state] of states) {
      if (!activeSnapshots.has(chatId)) {
        state.active = false;
        state.waitingApproval = false;
        state.pausedAt = 0;
      }
    }
    for (const snapshot of activeSnapshots.values()) {
      const state = getState(snapshot.chatId)!;
      if (!state.active || state.runStartedAt !== snapshot.startedAt) {
        state.active = true;
        state.waitingApproval = snapshot.state === 'waiting_approval';
        state.runStartedAt = snapshot.startedAt;
        state.accumulatedMs = snapshot.state === 'waiting_approval' ? Math.max(0, snapshot.updatedAt - snapshot.startedAt) : 0;
        state.pausedAt = snapshot.state === 'waiting_approval' ? snapshot.updatedAt : 0;
        state.runToken += 1;
      }
    }
    syncActiveChat();
  }).catch(() => {
    // Renderer hydration is best-effort and must never interrupt the chat UI.
  });
}

function handleEvent(event: StreamEvent): void {
  const chatId = event.chatId || currentChatId();
  if (!chatId) return;
  const state = getState(chatId)!;
  if (event.type === 'start') {
    const continuingRun = state.active;
    state.active = true;
    state.waitingApproval = false;
    state.runStartedAt = Date.now();
    if (!continuingRun) {
      state.accumulatedMs = 0;
      state.runToken += 1;
    }
    state.pausedAt = 0;
    if (chatId === activeChatId) ensureStatus();
    return;
  }
  if (!state.active) return;
  if (event.type === 'tool_call') {
    if (state.waitingApproval) {
      state.runStartedAt = Date.now();
      state.pausedAt = 0;
      state.waitingApproval = false;
    }
    if (chatId === activeChatId) ensureStatus();
    return;
  }
  if (event.type === 'approval_required') {
    state.accumulatedMs = elapsed(state);
    state.pausedAt = Date.now();
    state.waitingApproval = true;
    if (chatId === activeChatId) ensureStatus();
    return;
  }
  if (event.type === 'delta') {
    if (state.waitingApproval) {
      state.waitingApproval = false;
      state.runStartedAt = Date.now();
      state.pausedAt = 0;
    }
    if (chatId === activeChatId) ensureStatus();
    return;
  }
  if (event.type === 'activity') {
    if (event.activity?.type === 'complete' && event.activity.status === 'success') finishRun(chatId);
    else if (chatId === activeChatId) ensureStatus();
    return;
  }
  if (event.type === 'error') finishRun(chatId);
}

function observeMessages(): void {
  const root = messages();
  if (!root) return;
  const observer = new MutationObserver(() => {
    syncActiveChat();
    const state = getState(activeChatId);
    if (state?.active) ensureStatus();
  });
  observer.observe(root, { childList: true, subtree: true });
  const navObserver = new MutationObserver(() => {
    syncActiveChat();
    hydrateExecutions();
  });
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) {
    navObserver.observe(nav, { childList: true, subtree: true });
    nav.addEventListener('click', () => {
      queueMicrotask(() => {
        syncActiveChat();
        hydrateExecutions();
      });
    }, true);
  }
}

function initialize(): void {
  installStyle();
  activeChatId = currentChatId();
  if (bridge?.onStreamEvent) bridge.onStreamEvent(handleEvent);
  observeMessages();
  hydrateExecutions();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();