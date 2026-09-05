import type { ActivityEvent, ToolName } from './ai/types';

type StreamEvent = {
  type?: string;
  chatId?: string;
  activity?: Partial<ActivityEvent>;
  toolCall?: {
    id: string;
    name: ToolName;
    input: Record<string, unknown>;
  };
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
  .ac-live-activity[hidden]{display:none}
  .ac-live-activity.status-failed{color:#d58e96}
  .ac-live-activity.status-success{color:#8995a4}
  .ac-live-activity-icon{display:grid;place-items:center;width:16px;height:16px;flex:0 0 16px;color:currentColor}
  .ac-live-activity-icon svg{display:block;width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .ac-live-activity-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-live-activity-dots{display:inline-flex;margin-left:1px;letter-spacing:1px;opacity:.7}
  .ac-live-activity-dots span{animation:ac-live-dot 1.05s infinite;opacity:.25}
  .ac-live-activity-dots span:nth-child(2){animation-delay:.15s}.ac-live-activity-dots span:nth-child(3){animation-delay:.3s}
  .ac-live-activity.status-success .ac-live-activity-dots,.ac-live-activity.status-failed .ac-live-activity-dots{display:none}
  #messages.ac-has-live-activity .ac-thinking-status{display:none!important}
  @keyframes ac-live-dot{0%,100%{opacity:.25}40%{opacity:1}70%{opacity:.25}}
  @media(max-width:720px){.ac-live-activity{width:calc(100% - 24px)}}
  @media(prefers-reduced-motion:reduce){.ac-live-activity-dots span{animation:none;opacity:.65}}
`;
document.head.appendChild(style);

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('[data-chat-settings]')?.dataset.chatSettings
    || document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat
    || '';
}

function iconFor(toolName?: ToolName): string {
  if (toolName === 'run_command') return '<svg viewBox="0 0 24 24"><path d="m7 8 4 4-4 4"/><path d="M13 16h4"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>';
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
    if (previous?.classList.contains('message') && previous.classList.contains('assistant') && !previous.classList.contains('streaming')) {
      previous.classList.add('ac-internal-transcript');
    }
  });
}

function remove(): void {
  const messages = messagesRoot();
  messages?.querySelector('.ac-live-activity')?.remove();
  messages?.classList.remove('ac-has-live-activity');
}

function render(message: string, toolName?: ToolName, status: ActivityEvent['status'] = 'running'): void {
  const messages = messagesRoot();
  if (!messages || !message.trim()) return;
  remove();
  const row = document.createElement('div');
  row.className = `ac-live-activity status-${status}`;
  row.setAttribute('role', 'status');
  row.innerHTML = `<span class="ac-live-activity-icon" aria-hidden="true">${iconFor(toolName)}</span><span class="ac-live-activity-text"></span><span class="ac-live-activity-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  row.querySelector<HTMLElement>('.ac-live-activity-text')!.textContent = message.trim();
  const streaming = messages.querySelector('.message.assistant.streaming');
  const approval = messages.querySelector('.ac-approval-root');
  const anchor = streaming || approval;
  if (anchor) messages.insertBefore(row, anchor);
  else messages.appendChild(row);
  messages.classList.add('ac-has-live-activity');
}

function toolCallFallback(event: StreamEvent): string {
  const call = event.toolCall;
  if (!call) return '';
  const value = (key: string): string | undefined => typeof call.input[key] === 'string' && String(call.input[key]).trim() ? String(call.input[key]).trim() : undefined;
  switch (call.name) {
    case 'plan_execution': return 'Preparando plano de execução.';
    case 'complete_plan_step': return 'Atualizando progresso do plano.';
    case 'read_file': return value('path') ? `Preparando leitura de ${value('path')}` : 'Preparando leitura de arquivo.';
    case 'read_symbol': return value('symbol') ? `Preparando leitura do símbolo ${value('symbol')}` : 'Preparando leitura de símbolo.';
    case 'write_file':
    case 'replace_range':
    case 'replace_text':
    case 'replace_symbol':
    case 'insert_before':
    case 'insert_after': return value('path') ? `Preparando edição de ${value('path')}` : 'Preparando edição de arquivo.';
    case 'create_file': return value('path') ? `Preparando criação de ${value('path')}` : 'Preparando criação de arquivo.';
    case 'delete_file': return value('path') ? `Preparando exclusão de ${value('path')}` : 'Preparando exclusão de arquivo.';
    case 'rename_file': return value('from') && value('to') ? `Preparando renomeação de ${value('from')} para ${value('to')}` : 'Preparando renomeação de arquivo.';
    case 'search_files': return value('query') ? `Preparando pesquisa por ${value('query')}` : 'Preparando pesquisa em arquivos.';
    case 'run_command': return 'Preparando comando.';
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_branches': return 'Preparando consulta ao Git.';
    case 'git_create_branch':
    case 'git_checkout':
    case 'git_stage':
    case 'git_stage_all':
    case 'git_commit': return 'Preparando operação Git.';
  }
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
  if (event.type === 'tool_call' && event.toolCall) {
    render(toolCallFallback(event), event.toolCall.name, 'running');
    return;
  }
  if (event.type === 'activity' && event.activity?.message?.trim()) {
    if (event.activity.type === 'complete' && event.activity.status === 'success') {
      remove();
      return;
    }
    render(event.activity.message, event.activity.toolName, event.activity.status || 'running');
    return;
  }
  if (event.type === 'approval_required' || event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') remove();
});

const unsubscribeActivity = bridge.onActivity((event) => {
  if (!matchesActiveChat(event.chatId)) return;
  if (event.type === 'complete' && event.status === 'success') return;
  if (event.message?.trim()) render(event.message, event.toolName, event.status);
});

const messages = messagesRoot();
const transcriptObserver = messages ? new MutationObserver(syncInternalTranscript) : undefined;
if (messages && transcriptObserver) transcriptObserver.observe(messages, { childList: true });
syncInternalTranscript();

const nav = document.querySelector<HTMLElement>('#nav-panel');
const navObserver = nav ? new MutationObserver(() => {
  remove();
  syncInternalTranscript();
}) : undefined;
if (nav && navObserver) navObserver.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

window.addEventListener('beforeunload', () => {
  unsubscribeStream();
  unsubscribeActivity();
  transcriptObserver?.disconnect();
  navObserver?.disconnect();
  remove();
}, { once: true });
