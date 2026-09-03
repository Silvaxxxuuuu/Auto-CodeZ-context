type StreamEvent = {
  type?: string;
  chatId?: string;
  text?: string;
  activity?: { message?: string; status?: string; type?: string };
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

function elapsed(now = Date.now()): number {
  if (!runStartedAt || (waitingApproval && pausedAt)) return accumulatedMs;
  return accumulatedMs + Math.max(0, now - runStartedAt);
}

function formatSeconds(ms: number): string {
  const seconds = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
  return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
}

function ensureStatus(): HTMLElement | null {
  const root = messages();
  if (!root) return null;
  const status = root.querySelector<HTMLElement>('.ac-thinking-status') || document.createElement('div');
  status.className = 'ac-thinking-status';
  const desired = waitingApproval
    ? '<span class="ac-thinking-label">Aguardando sua aprovação</span>'
    : '<span class="ac-thinking-label">Pensando</span><span class="ac-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
  if (status.innerHTML !== desired) status.innerHTML = desired;
  const anchor = root.querySelector<HTMLElement>('.message.assistant.streaming, .activity-card');
  if (anchor) root.insertBefore(status, anchor);
  else if (!status.parentElement) root.appendChild(status);
  return status;
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
  if (root.querySelector<HTMLElement>(`[data-ac-thought-token="${token}"]`)) return;
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
    runToken += 1;
    ensureStatus();
    return;
  }
  if (!active) return;
  if (event.type === 'tool_call') {
    if (waitingApproval) {
      runStartedAt = Date.now();
      pausedAt = 0;
      waitingApproval = false;
    }
    ensureStatus();
    return;
  }
  if (event.type === 'approval_required') {
    accumulatedMs = elapsed();
    pausedAt = Date.now();
    waitingApproval = true;
    ensureStatus();
    return;
  }
  if (event.type === 'delta') {
    if (waitingApproval) {
      waitingApproval = false;
      runStartedAt = Date.now();
      pausedAt = 0;
    }
    ensureStatus();
    return;
  }
  if (event.type === 'activity') {
    if (event.activity?.type === 'complete' && event.activity.status === 'success') finishRun();
    else ensureStatus();
    return;
  }
  if (event.type === 'error') finishRun();
}

function observeMessages(): void {
  const root = messages();
  if (!root) return;
  const observer = new MutationObserver(() => {
    if (active) ensureStatus();
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