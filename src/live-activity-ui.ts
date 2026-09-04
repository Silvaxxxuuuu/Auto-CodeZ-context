type ToolName =
  | 'read_file'
  | 'write_file'
  | 'create_file'
  | 'delete_file'
  | 'rename_file'
  | 'search_files'
  | 'run_command'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'git_branches'
  | 'git_create_branch'
  | 'git_checkout'
  | 'git_stage'
  | 'git_stage_all'
  | 'git_commit';

type StreamEvent = {
  type?: string;
  chatId?: string;
  activity?: {
    type?: string;
    message?: string;
    status?: string;
    toolName?: ToolName;
  };
};

type Bridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: Bridge }).autoCodez;
if (!bridge?.onStreamEvent) throw new Error('Stream de atividades indisponível.');

const style = document.createElement('style');
style.id = 'auto-codez-live-activity-style';
style.textContent = `
  #messages > .activity-card{display:none!important}
  .ac-live-activity{width:min(820px,calc(100% - 56px));margin:4px auto 10px;display:flex;align-items:center;gap:7px;color:#7f8997;font:10px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;min-height:18px}
  .ac-live-activity[hidden]{display:none}
  .ac-live-activity-icon{display:grid;place-items:center;width:15px;height:15px;flex:0 0 15px;color:#8792a0}
  .ac-live-activity-icon svg{display:block;width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .ac-live-activity-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-live-activity-dots{display:inline-flex;margin-left:1px;letter-spacing:1px;opacity:.7}
  .ac-live-activity-dots span{animation:ac-live-dot 1.05s infinite;opacity:.25}
  .ac-live-activity-dots span:nth-child(2){animation-delay:.15s}.ac-live-activity-dots span:nth-child(3){animation-delay:.3s}
  #messages.ac-has-live-activity .ac-thinking-status{display:none!important}
  @keyframes ac-live-dot{0%,100%{opacity:.25}40%{opacity:1}70%{opacity:.25}}
  @media(max-width:720px){.ac-live-activity{width:calc(100% - 24px)}}
  @media(prefers-reduced-motion:reduce){.ac-live-activity-dots span{animation:none;opacity:.65}}
`;
document.head.appendChild(style);

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function iconFor(toolName?: ToolName): string {
  if (toolName === 'run_command') return '<svg viewBox="0 0 24 24"><path d="m7 8 4 4-4 4"/><path d="M13 16h4"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>';
  if (toolName === 'search_files') return '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  if (toolName?.startsWith('git_')) return '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v5a7 7 0 0 0 7 7h3"/></svg>';
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'create_file' || toolName === 'delete_file' || toolName === 'rename_file') return '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.22 4.22 2.12 2.12"/><path d="m17.66 17.66 2.12 2.12"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m4.22 19.78 2.12-2.12"/><path d="m17.66 6.34 2.12-2.12"/></svg>';
}

function messagesRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#messages');
}

function remove(): void {
  const messages = messagesRoot();
  messages?.querySelector('.ac-live-activity')?.remove();
  messages?.classList.remove('ac-has-live-activity');
}

function render(message: string, toolName?: ToolName): void {
  const messages = messagesRoot();
  if (!messages) return;
  remove();
  const row = document.createElement('div');
  row.className = 'ac-live-activity';
  row.setAttribute('role', 'status');
  row.innerHTML = `<span class="ac-live-activity-icon" aria-hidden="true">${iconFor(toolName)}</span><span class="ac-live-activity-text"></span><span class="ac-live-activity-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  row.querySelector<HTMLElement>('.ac-live-activity-text')!.textContent = message;
  const streaming = messages.querySelector('.message.assistant.streaming');
  const approval = messages.querySelector('.ac-approval-root');
  const anchor = streaming || approval;
  if (anchor) messages.insertBefore(row, anchor);
  else messages.appendChild(row);
  messages.classList.add('ac-has-live-activity');
}

bridge.onStreamEvent((event) => {
  if (event.chatId && event.chatId !== selectedChatId()) return;
  if (event.type === 'activity' && event.activity?.type === 'thought' && event.activity.status === 'running' && event.activity.message?.trim()) {
    render(event.activity.message.trim(), event.activity.toolName);
    return;
  }
  if (event.type === 'approval_required' || event.type === 'complete' || event.type === 'error' || event.type === 'cancelled') remove();
});

const nav = document.querySelector<HTMLElement>('#nav-panel');
if (nav) new MutationObserver(remove).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
window.addEventListener('beforeunload', remove, { once: true });
