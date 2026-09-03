type StreamEvent = {
  type?: string;
  chatId?: string;
  runId?: string;
  activity?: { message?: string; status?: string; type?: string };
};

type ExecutionSnapshot = {
  chatId: string;
  runId: string;
  state: 'idle' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  updatedAt: number;
};

type Bridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
  listExecutions?: () => Promise<unknown>;
};

type ThinkingState = {
  active: boolean;
  waitingApproval: boolean;
  runId?: string;
  startedAt: number;
  accumulatedMs: number;
  pausedAt: number;
  token: number;
};

const bridge = (window as unknown as { autoCodez?: Bridge }).autoCodez;
const states = new Map<string, ThinkingState>();
let activeChatId: string | undefined;
let observer: MutationObserver | undefined;

function currentChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function stateFor(chatId: string): ThinkingState {
  const existing = states.get(chatId);
  if (existing) return existing;
  const state: ThinkingState = { active: false, waitingApproval: false, startedAt: 0, accumulatedMs: 0, pausedAt: 0, token: 0 };
  states.set(chatId, state);
  return state;
}

function elapsed(state: ThinkingState, now = Date.now()): number {
  if (!state.startedAt || (state.waitingApproval && state.pausedAt)) return state.accumulatedMs;
  return state.accumulatedMs + Math.max(0, now - state.startedAt);
}

function seconds(ms: number): string {
  const value = Math.max(1, Math.round(ms / 1000));
  return `${value} ${value === 1 ? 'segundo' : 'segundos'}`;
}

function installStyle(): void {
  if (document.getElementById('auto-codez-thinking-ui')) return;
  const style = document.createElement('style');
  style.id = 'auto-codez-thinking-ui';
  style.textContent = `
    .ac-thinking-status{max-width:800px;margin:0 auto 7px;color:#7b8491;font-size:11px;line-height:18px}
    .ac-thinking-dots{display:inline-flex;min-width:17px;margin-left:4px;letter-spacing:2px}
    .ac-thinking-dots span{opacity:.25;animation:ac-thinking-dot 1.05s infinite}
    .ac-thinking-dots span:nth-child(2){animation-delay:.15s}
    .ac-thinking-dots span:nth-child(3){animation-delay:.3s}
    .ac-thought-time{margin:0 0 6px;color:#737d8a;font-size:10px;line-height:16px}
    @keyframes ac-thinking-dot{0%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-1px)}70%{opacity:.25;transform:translateY(0)}}
    @media(prefers-reduced-motion:reduce){.ac-thinking-dots span{animation:none;opacity:.7}}
  `;
  document.head.appendChild(style);
}

function removeLiveStatus(): void {
  document.querySelectorAll('.ac-thinking-status').forEach((node) => node.remove());
}

function renderLiveStatus(): void {
  const chatId = activeChatId;
  if (!chatId) return;
  const state = stateFor(chatId);
  removeLiveStatus();
  if (!state.active) return;
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  const status = document.createElement('div');
  status.className = 'ac-thinking-status';
  status.innerHTML = state.waitingApproval
    ? '<span>Aguardando sua aprovação</span>'
    : '<span>Pensando</span><span class="ac-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
  const anchor = messages.querySelector('.message.assistant.streaming, .activity-card, .ac-approval-root');
  if (anchor) messages.insertBefore(status, anchor);
  else messages.appendChild(status);
}

function insertThoughtTime(chatId: string, token: number, durationMs: number): void {
  if (chatId !== activeChatId) return;
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  const state = stateFor(chatId);
  if (state.active || state.token !== token) return;
  const assistant = [...messages.querySelectorAll<HTMLElement>('.message.assistant:not(.streaming)')].at(-1);
  if (!assistant) return;
  assistant.querySelectorAll<HTMLElement>('.ac-thought-time').forEach((node) => node.remove());
  const label = document.createElement('div');
  label.className = 'ac-thought-time';
  label.dataset.acThoughtToken = String(token);
  label.textContent = `Pensou por ${seconds(durationMs)}`;
  assistant.prepend(label);
}

function finish(chatId: string): void {
  const state = stateFor(chatId);
  if (!state.active) return;
  state.accumulatedMs = elapsed(state);
  state.active = false;
  state.waitingApproval = false;
  state.pausedAt = 0;
  const token = state.token;
  const duration = state.accumulatedMs;
  if (chatId !== activeChatId) return;
  removeLiveStatus();
  const retry = () => insertThoughtTime(chatId, token, duration);
  retry();
  window.setTimeout(retry, 0);
  window.setTimeout(retry, 60);
  window.setTimeout(retry, 250);
}

function handleEvent(event: StreamEvent): void {
  const chatId = event.chatId || currentChatId();
  if (!chatId) return;
  const state = stateFor(chatId);
  if (event.type === 'start') {
    state.active = true;
    state.waitingApproval = false;
    state.startedAt = Date.now();
    state.accumulatedMs = 0;
    state.pausedAt = 0;
    state.runId = event.runId;
    state.token += 1;
    if (chatId === activeChatId) renderLiveStatus();
    return;
  }
  if (event.runId && state.runId && event.runId !== state.runId) return;
  if (event.type === 'approval_required') {
    state.accumulatedMs = elapsed(state);
    state.waitingApproval = true;
    state.pausedAt = Date.now();
    if (chatId === activeChatId) renderLiveStatus();
    return;
  }
  if (event.type === 'tool_call' && state.waitingApproval) {
    state.waitingApproval = false;
    state.startedAt = Date.now();
    state.pausedAt = 0;
    if (chatId === activeChatId) renderLiveStatus();
    return;
  }
  if (event.type === 'activity' && event.activity?.type === 'complete' && event.activity.status === 'success') {
    finish(chatId);
    return;
  }
  if (event.type === 'complete' || event.type === 'error') finish(chatId);
}

function hydrate(): void {
  if (!bridge?.listExecutions) return;
  void bridge.listExecutions().then((value) => {
    if (!Array.isArray(value)) return;
    const active = value.filter((item): item is ExecutionSnapshot => {
      if (!item || typeof item !== 'object') return false;
      const snapshot = item as Partial<ExecutionSnapshot>;
      return typeof snapshot.chatId === 'string' && typeof snapshot.runId === 'string' && typeof snapshot.state === 'string' && typeof snapshot.startedAt === 'number';
    });
    const live = new Map(active.filter((item) => item.state === 'running' || item.state === 'waiting_approval').map((item) => [item.chatId, item]));
    for (const [chatId, state] of states) if (!live.has(chatId)) state.active = false;
    for (const snapshot of live.values()) {
      const state = stateFor(snapshot.chatId);
      if (state.runId === snapshot.runId && state.active) continue;
      state.active = true;
      state.waitingApproval = snapshot.state === 'waiting_approval';
      state.runId = snapshot.runId;
      state.startedAt = snapshot.startedAt;
      state.accumulatedMs = state.waitingApproval ? Math.max(0, snapshot.updatedAt - snapshot.startedAt) : 0;
      state.pausedAt = state.waitingApproval ? snapshot.updatedAt : 0;
      state.token += 1;
    }
    if (currentChatId() === activeChatId) renderLiveStatus();
  }).catch(() => undefined);
}

function syncChat(): void {
  const next = currentChatId();
  if (next === activeChatId) return;
  activeChatId = next;
  removeLiveStatus();
  if (next) {
    const state = stateFor(next);
    if (state.active) renderLiveStatus();
  }
}

function observe(): void {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  observer = new MutationObserver(() => {
    syncChat();
    const state = activeChatId ? stateFor(activeChatId) : undefined;
    if (state?.active) renderLiveStatus();
    else if (state && !state.active) removeLiveStatus();
    if (activeChatId && state && !state.active) insertThoughtTime(activeChatId, state.token, state.accumulatedMs);
  });
  observer.observe(messages, { childList: true, subtree: true });
  const nav = document.querySelector<HTMLElement>('#nav-panel');
  if (nav) new MutationObserver(() => { syncChat(); hydrate(); }).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-chat'] });
}

function initialize(): void {
  installStyle();
  activeChatId = currentChatId();
  bridge?.onStreamEvent(handleEvent);
  observe();
  hydrate();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
