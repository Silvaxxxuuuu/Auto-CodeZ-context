import type { ActivityEvent, ToolName } from './ai/types';

type StreamEvent = {
  type?: string;
  chatId?: string;
  text?: string;
  activity?: Partial<ActivityEvent>;
  toolCall?: { id: string; name: ToolName; input: Record<string, unknown> };
};

type Bridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
  onActivity: (listener: (event: ActivityEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: Bridge }).autoCodez;
if (!bridge?.onStreamEvent || !bridge.onActivity) throw new Error('Stream de atividades indisponível.');

const style = document.createElement('style');
style.id = 'auto-codez-live-activity-style';
style.textContent = `
  #messages > .activity-card{display:none!important}
  #messages > .ac-internal-transcript{display:none!important}
  .ac-live-activity{width:min(860px,calc(100% - 56px));margin:5px auto 12px;display:flex;align-items:center;gap:8px;color:#7f8997;font:11px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;min-height:20px}
  .ac-live-activity[hidden]{display:none}.ac-live-activity.status-failed{color:#d58e96}.ac-live-activity.status-success{color:#8995a4}.ac-live-activity.status-pending{color:#a89b7d}
  .ac-live-activity-icon{display:grid;place-items:center;width:16px;height:16px;flex:0 0 16px;color:currentColor}.ac-live-activity-icon svg{display:block;width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .ac-live-activity-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ac-live-activity-dots{display:inline-flex;margin-left:1px;letter-spacing:1px;opacity:.7}.ac-live-activity-dots span{animation:ac-live-dot 1.05s infinite;opacity:.25}.ac-live-activity-dots span:nth-child(2){animation-delay:.15s}.ac-live-activity-dots span:nth-child(3){animation-delay:.3s}
  .ac-live-activity.status-success .ac-live-activity-dots,.ac-live-activity.status-failed .ac-live-activity-dots,.ac-live-activity.status-pending .ac-live-activity-dots{display:none}
  #messages.ac-has-live-activity .ac-thinking-status{display:none!important}@keyframes ac-live-dot{0%,100%{opacity:.25}40%{opacity:1}70%{opacity:.25}}
  @media(max-width:720px){.ac-live-activity{width:calc(100% - 24px)}}@media(prefers-reduced-motion:reduce){.ac-live-activity-dots span{animation:none;opacity:.65}}
`;
document.head.appendChild(style);

const INFRASTRUCTURE_ACTIVITY = [
  /^Contexto do workspace anexado à solicitação\.?$/i,
  /^Enviando mensagem para /i,
  /^Transmitindo resposta de /i,
  /^Resposta recebida\.?$/i,
  /^Perfil .+ ajustado para /i,
];
const dynamicToolSummaries = new Map<string, { message: string; toolName?: ToolName }>();

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('[data-chat-settings]')?.dataset.chatSettings
    || document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat
    || '';
}

function iconFor(toolName?: ToolName): string {
  if (toolName === 'run_command') return '<svg viewBox="0 0 24 24"><path d="m7 8 4 4-4 4"/><path d="M13 16h4"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>';
  if (toolName === 'web_search' || toolName === 'web_fetch') return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>';
  if (toolName === 'search_files') return '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  if (toolName?.startsWith('git_')) return '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v5a7 7 0 0 0 7 7h3"/></svg>';
  if (toolName === 'plan_execution' || toolName === 'complete_plan_step') return '<svg viewBox="0 0 24 24"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m3 6 1 1 2-2"/><path d="m3 12 1 1 2-2"/><circle cx="4" cy="18" r="1"/></svg>';
  if (toolName === 'read_symbol' || toolName === 'replace_symbol') return '<svg viewBox="0 0 24 24"><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 7-4 10"/></svg>';
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'create_file' || toolName === 'replace_range' || toolName === 'replace_text' || toolName === 'insert_before' || toolName === 'insert_after' || toolName === 'delete_file' || toolName === 'rename_file') return '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.22 4.22 2.12 2.12"/><path d="m17.66 17.66 2.12 2.12"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m4.22 19.78 2.12-2.12"/><path d="m17.66 6.34 2.12-2.12"/></svg>';
}

function messagesRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#messages');
}

function syncInternalTranscript(): void {
  const messages = messagesRoot();
  if (!messages) return;
  messages.querySelectorAll<HTMLElement>(':scope > .message.tool').forEach((toolMessage) => {
    toolMessage.classList.add('ac-internal-transcript');
    let previous = toolMessage.previousElementSibling as HTMLElement | null;
    while (previous?.classList.contains('message') && previous.classList.contains('tool')) {
      previous.classList.add('ac-internal-transcript');
      previous = previous.previousElementSibling as HTMLElement | null;
    }
    if (previous?.classList.contains('message') && previous.classList.contains('assistant') && !previous.classList.contains('streaming')) previous.classList.add('ac-internal-transcript');
  });
}

function remove(): void {
  const messages = messagesRoot();
  messages?.querySelector('.ac-live-activity')?.remove();
  messages?.classList.remove('ac-has-live-activity');
}

function clearDynamicSummaries(): void {
  dynamicToolSummaries.clear();
}

function isInfrastructureMessage(message: string): boolean {
  return INFRASTRUCTURE_ACTIVITY.some((pattern) => pattern.test(message.trim()));
}

function normalizedActivityMessage(event: Partial<ActivityEvent>): string {
  const message = event.message?.trim() || '';
  if (!message || isInfrastructureMessage(message)) return '';
  if (event.toolName === 'web_search' && event.status === 'failed') return message.replace(/^Falha em web_search:\s*/i, 'A pesquisa na web falhou: ');
  if (event.toolName === 'web_fetch' && event.status === 'failed') return message.replace(/^Falha em web_fetch:\s*/i, 'Não foi possível abrir a fonte: ');
  return message;
}

function render(message: string, toolName?: ToolName, status: ActivityEvent['status'] = 'running'): void {
  const messages = messagesRoot();
  const normalized = message.trim();
  if (!messages || !normalized || isInfrastructureMessage(normalized)) return;
  remove();
  const row = document.createElement('div');
  row.className = `ac-live-activity status-${status}`;
  row.setAttribute('role', 'status');
  row.innerHTML = `<span class="ac-live-activity-icon" aria-hidden="true">${iconFor(toolName)}</span><span class="ac-live-activity-text"></span><span class="ac-live-activity-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  row.querySelector<HTMLElement>('.ac-live-activity-text')!.textContent = normalized;
  const streaming = messages.querySelector('.message.assistant.streaming');
  const approval = messages.querySelector('.ac-approval-root');
  const anchor = streaming || approval;
  if (anchor) messages.insertBefore(row, anchor);
  else messages.appendChild(row);
  messages.classList.add('ac-has-live-activity');
}

function matchesActiveChat(chatId?: string): boolean {
  const active = selectedChatId();
  return !chatId || !active || chatId === active;
}

const unsubscribeStream = bridge.onStreamEvent((event) => {
  if (!matchesActiveChat(event.chatId)) return;
  if (event.type === 'delta' && event.text) {
    remove();
    return;
  }
  if (event.type === 'activity' && event.activity) {
    const message = normalizedActivityMessage(event.activity);
    const toolCallId = event.activity.toolCallId;
    if (message && event.activity.type === 'thought' && toolCallId) {
      dynamicToolSummaries.set(toolCallId, { message, toolName: event.activity.toolName });
    }
    if (message) render(message, event.activity.toolName, event.activity.status || 'running');
    return;
  }
  if (event.type === 'approval_required') return;
  if (event.type === 'complete' || event.type === 'cancelled') {
    clearDynamicSummaries();
    remove();
    return;
  }
  if (event.type === 'error') {
    clearDynamicSummaries();
    const current = messagesRoot()?.querySelector<HTMLElement>('.ac-live-activity');
    if (!current?.classList.contains('status-failed')) remove();
  }
});

const unsubscribeActivity = bridge.onActivity((event) => {
  if (!matchesActiveChat(event.chatId)) return;
  const toolCallId = event.toolCallId;
  const dynamic = toolCallId ? dynamicToolSummaries.get(toolCallId) : undefined;

  if (event.status === 'running' && dynamic) {
    render(dynamic.message, dynamic.toolName || event.toolName, 'running');
    return;
  }

  if (event.status === 'failed' && toolCallId) dynamicToolSummaries.delete(toolCallId);
  if (event.status === 'success' && toolCallId) dynamicToolSummaries.delete(toolCallId);
  const message = normalizedActivityMessage(event);
  if (!message) return;
  if (event.type === 'complete' && event.status === 'success') {
    clearDynamicSummaries();
    remove();
    return;
  }
  render(message, event.toolName, event.status);
});

const messages = messagesRoot();
const transcriptObserver = messages ? new MutationObserver(syncInternalTranscript) : undefined;
if (messages && transcriptObserver) transcriptObserver.observe(messages, { childList: true });
syncInternalTranscript();

const nav = document.querySelector<HTMLElement>('#nav-panel');
const navObserver = nav ? new MutationObserver(() => {
  clearDynamicSummaries();
  remove();
  syncInternalTranscript();
}) : undefined;
if (nav && navObserver) navObserver.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

window.addEventListener('beforeunload', () => {
  unsubscribeStream();
  unsubscribeActivity();
  transcriptObserver?.disconnect();
  navObserver?.disconnect();
  clearDynamicSummaries();
  remove();
}, { once: true });
