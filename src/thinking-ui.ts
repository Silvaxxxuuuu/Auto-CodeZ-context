type StreamEvent = {
  type?: string;
  chatId?: string;
  text?: string;
  toolCall?: { name?: string; input?: Record<string, unknown> };
};

type StreamBridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: StreamBridge }).autoCodez;
const messages = () => document.querySelector<HTMLElement>('#messages');
const STYLE_ID = 'auto-codez-thinking-ui';
let active = false;
let waitingApproval = false;
let runStartedAt = 0;
let accumulatedMs = 0;
let pausedAt = 0;
let runToken = 0;
let lastActivity = '';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .activity-card .activity-heading{display:none!important}
    .ac-thinking-status{display:flex;align-items:center;gap:5px;margin:2px 0 5px;color:#7b8491;font-size:11px;line-height:18px;font-weight:400}
    .ac-thinking-label{white-space:nowrap}
    .ac-thinking-dots{display:inline-flex;min-width:17px;letter-spacing:2px}
    .ac-thinking-dots span{opacity:.25;animation:ac-thinking-dot 1.05s infinite}
    .ac-thinking-dots span:nth-child(2){animation-delay:.15s}
    .ac-thinking-dots span:nth-child(3){animation-delay:.3s}
    .ac-thought-time{margin:2px 0 7px;color:#737d8a;font-size:10px;line-height:16px}
    .ac-context-line{padding:1px 0!important;margin:0!important;color:#7b8491!important;font-size:10px!important;line-height:16px!important}
    @keyframes ac-thinking-dot{0%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-1px)}70%{opacity:.25;transform:translateY(0)}}
    @media(prefers-reduced-motion:reduce){.ac-thinking-dots span{animation:none;opacity:.7}}
  `;
  document.head.appendChild(style);
}

function elapsed(now = Date.now()): number {
  if (!runStartedAt) return accumulatedMs;
  if (waitingApproval && pausedAt) return accumulatedMs;
  return accumulatedMs + Math.max(0, now - runStartedAt);
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
}

function toolContext(event: StreamEvent): string | undefined {
  const name = event.toolCall?.name?.trim();
  const input = event.toolCall?.input || {};
  if (!name) return undefined;
  const values = Object.values(input).filter((value) => typeof value === 'string' && value.trim()) as string[];
  const detail = values[0]?.trim();
  if (!detail) return `Executando ${name}...`;
  const compact = detail.length > 110 ? `${detail.slice(0, 107)}...` : detail;
  return `Executando ${compact}...`;
}

function ensureActivityCard(): HTMLElement | null {
  const root = messages();
  if (!root) return null;
  let card = root.querySelector<HTMLElement>('.activity-card');
  if (!card) {
    card = document.createElement('div');
    card.className = 'activity-card';
    root.appendChild(card);
  }
  return card;
}

function renderStatus(): void {
  const card = ensureActivityCard();
  if (!card) return;
  const status = card.querySelector<HTMLElement>('.ac-thinking-status') || document.createElement('div');
  status.className = 'ac-thinking-status';
  status.innerHTML = waitingApproval
    ? '<span class="ac-thinking-label">Aguardando sua aprovação</span>'
    : '<span class="ac-thinking-label">Pensando</span><span class="ac-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
  card.prepend(status);
}

function renderContext(): void {
  if (!lastActivity) return;
  const card = ensureActivityCard();
  if (!card) return;
  let line = card.querySelector<HTMLElement>('.ac-context-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'activity-line running ac-context-line';
    card.appendChild(line);
  }
  line.textContent = lastActivity;
}

function removeThinkingStatus(): void {
  document.querySelectorAll('.ac-thinking-status').forEach((element) => element.remove());
}

function insertThoughtTime(token: number, durationMs: number): void {
  const root = messages();
  if (!root || token !== runToken) return;
  const assistantMessages = [...root.querySelectorAll<HTMLElement>('.message.assistant:not(.streaming)')];
  const lastAssistant = assistantMessages.at(-1);
  if (!lastAssistant) return;
  const existing = root.querySelector<HTMLElement>(`[data-ac-thought-token="${token}"]`);
  if (existing) return;
  const label = document.createElement('div');
  label.className = 'ac-thought-time';
  label.dataset.acThoughtToken = String(token);
  label.textContent = `Pensou por ${formatSeconds(durationMs)}`;
  lastAssistant.before(label);
}

function finishRun(): void {
  if (!active) return;
  accumulatedMs = elapsed();
  active = false;
  waitingApproval = false;
  pausedAt = 0;
  const duration = accumulatedMs;
  const token = runToken;
  removeThinkingStatus();
  const tryInsert = () => insertThoughtTime(token, duration);
  tryInsert();
  window.setTimeout(tryInsert, 0);
  window.setTimeout(tryInsert, 60);
  window.setTimeout(tryInsert, 250);
}

function handleEvent(event: StreamEvent): void {
  if (event.type === 'start') {
    active = true;
    waitingApproval = false;
    runStartedAt = Date.now();
    accumulatedMs = 0;
    pausedAt = 0;
    lastActivity = '';
    runToken += 1;
    renderStatus();
    return;
  }
  if (!active) return;
  if (event.type === 'tool_call') {
    if (waitingApproval) {
      accumulatedMs += Math.max(0, Date.now() - pausedAt);
      runStartedAt = Date.now();
      pausedAt = 0;
      waitingApproval = false;
    }
    lastActivity = toolContext(event) || '';
    renderStatus();
    renderContext();
    return;
  }
  if (event.type === 'activity' && event.text) {
    lastActivity = event.text;
    renderContext();
    return;
  }
  if (event.type === 'approval_required') {
    accumulatedMs += Math.max(0, Date.now() - runStartedAt);
    pausedAt = Date.now();
    waitingApproval = true;
    renderStatus();
    return;
  }
  if (event.type === 'delta') {
    if (waitingApproval) {
      waitingApproval = false;
      runStartedAt = Date.now();
      pausedAt = 0;
      renderStatus();
    }
    return;
  }
  if (event.type === 'complete' || event.type === 'error') finishRun();
}

function observeMessages(): void {
  const root = messages();
  if (!root) return;
  const observer = new MutationObserver(() => {
    if (active) {
      renderStatus();
      renderContext();
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

function initialize(): void {
  installStyle();
  if (bridge?.onStreamEvent) bridge.onStreamEvent(handleEvent);
  observeMessages();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
