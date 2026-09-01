type Project = { id: string; name: string; rootPath: string; createdAt: number; updatedAt: number };

type TerminalSession = {
  id: string;
  projectId: string;
  cwd: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  signal?: string;
  status: 'running' | 'exited' | 'failed' | 'killed';
};

type TerminalHistoryEntry = TerminalSession & { output: string };

type TerminalEvent =
  | { type: 'output'; sessionId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'exit'; session: TerminalSession };

type TerminalApi = {
  start: (input: { projectId: string; command: string }) => Promise<TerminalSession>;
  kill: (sessionId: string) => Promise<TerminalSession>;
  listSessions: () => Promise<TerminalSession[]>;
  getOutput: (sessionId: string) => Promise<string>;
  listHistory: (projectId?: string) => Promise<TerminalHistoryEntry[]>;
  clearHistory: (projectId?: string) => Promise<void>;
  onEvent: (listener: (event: TerminalEvent) => void) => () => void;
};

type AppBridge = {
  getState: () => Promise<{ providers: unknown[]; chats: unknown[]; projects: Project[] }>;
  terminal: TerminalApi;
};

const bridge = window.autoCodez as unknown as AppBridge;
const terminal = bridge.terminal;

const style = document.createElement('style');
style.textContent = `
.terminal-rail-button:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm2.2 4.1 3 2.9-3 2.9 1 1 4-3.9-4-3.9-1 1Zm6.1 5.9h5.2v1.5h-5.2V15Z'/%3E%3C/svg%3E")}
.terminal-panel{display:none;position:relative;flex:none;height:300px;min-height:180px;border-top:1px solid #202631;background:#080a0e;color:#d9dee7;flex-direction:column;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.terminal-panel.open{display:flex}
.terminal-toolbar{height:38px;flex:none;display:flex;align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid #202631;background:#0d1016}
.terminal-title{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:10px;font-weight:650;color:#dce2ea;margin-right:5px}
.terminal-select,.terminal-command{height:27px;border:1px solid #252c36;border-radius:6px;background:#11151c;color:#bfc7d2;outline:none;font:inherit;font-size:10px}
.terminal-select{max-width:190px;padding:0 7px}.terminal-select:focus,.terminal-command:focus{border-color:#465365}
.terminal-command{flex:1;min-width:100px;padding:0 9px}
.terminal-run,.terminal-kill,.terminal-clear,.terminal-history-button,.terminal-close{height:27px;padding:0 9px;border:1px solid #252c36;border-radius:6px;background:#11151c;color:#aeb7c4;cursor:pointer;font:inherit;font-size:10px}
.terminal-run:hover,.terminal-kill:hover,.terminal-clear:hover,.terminal-history-button:hover,.terminal-close:hover{background:#171c24;color:#eef2f7;border-color:#303845}
.terminal-run{background:#151b24;color:#dbe3ed}.terminal-kill{color:#d7a0a0}.terminal-close{font-size:14px;width:27px;padding:0;margin-left:2px}
.terminal-history-button{padding:0 8px}
.terminal-history-menu{display:none;position:absolute;z-index:5;top:40px;right:40px;width:min(420px,calc(100% - 30px));max-height:260px;overflow:auto;padding:6px;border:1px solid #29313c;border-radius:7px;background:#0d1016;box-shadow:0 10px 28px #00000066}
.terminal-history-menu.open{display:block}.terminal-history-empty{padding:12px;color:#626c7a;font:10px Inter,ui-sans-serif,system-ui,sans-serif}
.terminal-history-item{display:flex;flex-direction:column;gap:3px;width:100%;padding:8px;border:0;border-radius:5px;background:transparent;color:#c5cdd7;text-align:left;cursor:pointer;font:inherit}
.terminal-history-item:hover{background:#171c24}.terminal-history-command{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.terminal-history-meta{display:flex;gap:8px;color:#697483;font:9px Inter,ui-sans-serif,system-ui,sans-serif}
.terminal-tabs{height:31px;flex:none;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid #181d25;background:#0b0e13;overflow:auto}
.terminal-tab{height:25px;display:flex;align-items:center;gap:7px;padding:0 8px;border:1px solid transparent;border-radius:5px;background:transparent;color:#707a88;cursor:pointer;font:inherit;font-size:9px;white-space:nowrap}
.terminal-tab:hover{background:#141920;color:#aeb7c4}.terminal-tab.active{background:#161b23;border-color:#252c36;color:#e1e6ed}
.terminal-tab-dot{width:5px;height:5px;border-radius:50%;background:#6f7885}.terminal-tab-dot.running{background:#aeb8c5;box-shadow:0 0 7px #aeb8c555}
.terminal-body{min-height:0;flex:1;display:flex;overflow:hidden}.terminal-output{flex:1;min-width:0;overflow:auto;padding:10px 13px 14px;background:#080a0e;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.terminal-empty{color:#596371}.terminal-prompt{color:#8f9baa}.terminal-status{flex:none;width:150px;border-left:1px solid #181d25;background:#0b0e13;padding:10px;overflow:auto;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:9px;color:#737d8a}
.terminal-status strong{display:block;color:#b9c1cc;font-size:10px;margin-bottom:8px}.terminal-status-row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid #151a21}.terminal-status-value{color:#aeb7c4;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.terminal-status-value.running{color:#dbe2ea}.terminal-status-value.failed,.terminal-status-value.killed{color:#d49a9a}
@media (max-width:900px){.terminal-panel{height:260px}.terminal-status{display:none}.terminal-select{max-width:130px}.terminal-title{display:none}}
`;
document.head.appendChild(style);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return 'agora';
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

const chatArea = document.querySelector<HTMLElement>('.chat-area');
const rail = document.querySelector<HTMLElement>('.rail');
if (!chatArea || !rail) throw new Error('Estrutura principal da interface não encontrada.');

const profileButton = rail.querySelector<HTMLButtonElement>('[data-action="profile"]');
if (!profileButton) throw new Error('Botão de perfil não encontrado.');

const terminalButton = document.createElement('button');
terminalButton.className = 'rail-button terminal-rail-button';
terminalButton.type = 'button';
terminalButton.title = 'Terminal';
terminalButton.setAttribute('aria-label', 'Terminal');
terminalButton.setAttribute('aria-expanded', 'false');
terminalButton.innerHTML = '<span aria-hidden="true"></span>';
rail.insertBefore(terminalButton, profileButton);

const terminalPanel = document.createElement('section');
terminalPanel.className = 'terminal-panel';
terminalPanel.setAttribute('aria-label', 'Terminal');
terminalPanel.innerHTML = `
  <div class="terminal-toolbar">
    <span class="terminal-title">TERMINAL</span>
    <select class="terminal-select" id="terminal-project" aria-label="Projeto do terminal"></select>
    <input class="terminal-command" id="terminal-command" type="text" placeholder="Digite um comando e pressione Enter" aria-label="Comando do terminal" autocomplete="off" spellcheck="false">
    <button class="terminal-run" id="terminal-run" type="button">Executar</button>
    <button class="terminal-kill" id="terminal-kill" type="button" disabled>Parar</button>
    <button class="terminal-history-button" id="terminal-history" type="button" aria-expanded="false">Histórico</button>
    <button class="terminal-clear" id="terminal-clear" type="button">Limpar</button>
    <button class="terminal-close" id="terminal-close" type="button" title="Fechar terminal" aria-label="Fechar terminal">×</button>
  </div>
  <div class="terminal-history-menu" id="terminal-history-menu" role="menu"></div>
  <div class="terminal-tabs" id="terminal-tabs"></div>
  <div class="terminal-body">
    <div class="terminal-output" id="terminal-output"><span class="terminal-empty">Selecione um projeto e execute um comando.</span></div>
    <aside class="terminal-status" id="terminal-status"></aside>
  </div>
`;
chatArea.appendChild(terminalPanel);

const projectSelect = terminalPanel.querySelector<HTMLSelectElement>('#terminal-project')!;
const commandInput = terminalPanel.querySelector<HTMLInputElement>('#terminal-command')!;
const runButton = terminalPanel.querySelector<HTMLButtonElement>('#terminal-run')!;
const killButton = terminalPanel.querySelector<HTMLButtonElement>('#terminal-kill')!;
const historyButton = terminalPanel.querySelector<HTMLButtonElement>('#terminal-history')!;
const clearButton = terminalPanel.querySelector<HTMLButtonElement>('#terminal-clear')!;
const closeButton = terminalPanel.querySelector<HTMLButtonElement>('#terminal-close')!;
const historyMenu = terminalPanel.querySelector<HTMLDivElement>('#terminal-history-menu')!;
const tabs = terminalPanel.querySelector<HTMLDivElement>('#terminal-tabs')!;
const output = terminalPanel.querySelector<HTMLDivElement>('#terminal-output')!;
const status = terminalPanel.querySelector<HTMLElement>('#terminal-status')!;

let projects: Project[] = [];
let sessions: TerminalSession[] = [];
let activeSessionId = '';
let outputs = new Map<string, string>();
let history: TerminalHistoryEntry[] = [];
let open = false;
let unsubscribe: (() => void) | undefined;

function activeSession(): TerminalSession | undefined {
  return sessions.find((session) => session.id === activeSessionId);
}

function selectedProjectId(): string {
  return projectSelect.value;
}

function renderProjects(): void {
  const previous = projectSelect.value;
  projectSelect.innerHTML = projects.length
    ? projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')
    : '<option value="">Nenhum projeto</option>';
  if (projects.some((project) => project.id === previous)) projectSelect.value = previous;
  projectSelect.disabled = projects.length === 0;
  runButton.disabled = projects.length === 0 || !commandInput.value.trim();
}

function renderTabs(): void {
  const projectSessions = sessions.filter((session) => !selectedProjectId() || session.projectId === selectedProjectId());
  tabs.innerHTML = projectSessions.length
    ? projectSessions.map((session) => `<button class="terminal-tab ${session.id === activeSessionId ? 'active' : ''}" data-terminal-session="${escapeHtml(session.id)}" type="button"><span class="terminal-tab-dot ${session.status === 'running' ? 'running' : ''}"></span>${escapeHtml(session.command.slice(0, 28))}${session.command.length > 28 ? '…' : ''}</button>`).join('')
    : '<span class="terminal-empty">Nenhuma sessão</span>';
}

function renderOutput(): void {
  const session = activeSession();
  if (!session) {
    output.innerHTML = '<span class="terminal-empty">Selecione um projeto e execute um comando.</span>';
    return;
  }
  const text = outputs.get(session.id) || '';
  output.innerHTML = `<span class="terminal-prompt">${escapeHtml(session.cwd)} &gt; ${escapeHtml(session.command)}</span>\n${escapeHtml(text) || '<span class="terminal-empty">Aguardando saída...</span>'}`;
  output.scrollTop = output.scrollHeight;
}

function renderStatus(): void {
  const session = activeSession();
  if (!session) {
    status.innerHTML = '<strong>Terminal</strong><div class="terminal-status-row"><span>Status</span><span class="terminal-status-value">Inativo</span></div>';
    killButton.disabled = true;
    return;
  }
  const statusClass = session.status === 'running' ? 'running' : session.status;
  status.innerHTML = `<strong>Sessão</strong>
    <div class="terminal-status-row"><span>Status</span><span class="terminal-status-value ${statusClass}">${escapeHtml(session.status)}</span></div>
    <div class="terminal-status-row"><span>Início</span><span class="terminal-status-value">${formatTime(session.startedAt)}</span></div>
    <div class="terminal-status-row"><span>Fim</span><span class="terminal-status-value">${formatTime(session.endedAt)}</span></div>
    <div class="terminal-status-row"><span>Exit code</span><span class="terminal-status-value">${session.exitCode === undefined ? '•' : String(session.exitCode)}</span></div>
    <div class="terminal-status-row"><span>Projeto</span><span class="terminal-status-value">${escapeHtml(projects.find((project) => project.id === session.projectId)?.name || 'Projeto')}</span></div>`;
  killButton.disabled = session.status !== 'running';
}

function renderHistory(): void {
  historyMenu.innerHTML = history.length
    ? history.slice(0, 30).map((entry) => {
      const project = projects.find((item) => item.id === entry.projectId);
      const result = entry.status === 'exited' ? `exit ${entry.exitCode ?? 0}` : entry.status;
      return `<button class="terminal-history-item" data-history-id="${escapeHtml(entry.id)}" type="button" role="menuitem">
        <span class="terminal-history-command">${escapeHtml(entry.command)}</span>
        <span class="terminal-history-meta"><span>${escapeHtml(project?.name || 'Projeto')}</span><span>${formatTime(entry.endedAt || entry.startedAt)}</span><span>${escapeHtml(result)}</span></span>
      </button>`;
    }).join('')
    : '<div class="terminal-history-empty">Nenhum comando concluído neste projeto.</div>';
}

function render(): void {
  renderProjects();
  renderTabs();
  renderOutput();
  renderStatus();
  renderHistory();
}

async function refreshHistory(): Promise<void> {
  history = await terminal.listHistory(selectedProjectId() || undefined);
  renderHistory();
}

async function refreshSessions(): Promise<void> {
  sessions = await terminal.listSessions();
  const projectSessions = sessions.filter((session) => !selectedProjectId() || session.projectId === selectedProjectId());
  const running = projectSessions.find((session) => session.status === 'running');
  if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId) || (selectedProjectId() && activeSession()?.projectId !== selectedProjectId())) {
    activeSessionId = running?.id || projectSessions[0]?.id || '';
  }
  for (const session of sessions) {
    if (!outputs.has(session.id)) outputs.set(session.id, await terminal.getOutput(session.id));
  }
  render();
}

async function openTerminal(): Promise<void> {
  open = true;
  terminalPanel.classList.add('open');
  terminalButton.classList.add('active');
  terminalButton.setAttribute('aria-expanded', 'true');
  if (!unsubscribe) unsubscribe = terminal.onEvent(handleTerminalEvent);
  const state = await bridge.getState();
  projects = state.projects;
  renderProjects();
  if (projects.length && !projectSelect.value) projectSelect.value = projects[0].id;
  await refreshSessions();
  await refreshHistory();
  render();
  commandInput.focus();
}

function closeHistory(): void {
  historyMenu.classList.remove('open');
  historyButton.setAttribute('aria-expanded', 'false');
}

function closeTerminal(): void {
  open = false;
  closeHistory();
  terminalPanel.classList.remove('open');
  terminalButton.classList.remove('active');
  terminalButton.setAttribute('aria-expanded', 'false');
}

async function handleTerminalEvent(event: TerminalEvent): Promise<void> {
  if (event.type === 'output') {
    outputs.set(event.sessionId, `${outputs.get(event.sessionId) || ''}${event.chunk}`);
    if (open && event.sessionId === activeSessionId) renderOutput();
    return;
  }
  const index = sessions.findIndex((session) => session.id === event.session.id);
  if (index >= 0) sessions[index] = event.session;
  else sessions.unshift(event.session);
  activeSessionId = event.session.id;
  if (open) {
    render();
    void refreshHistory();
  }
}

async function runCommand(): Promise<void> {
  const projectId = selectedProjectId();
  const command = commandInput.value.trim();
  if (!projectId || !command) return;
  runButton.disabled = true;
  closeHistory();
  try {
    const session = await terminal.start({ projectId, command });
    sessions.unshift(session);
    activeSessionId = session.id;
    outputs.set(session.id, '');
    commandInput.value = '';
    render();
  } catch {
    runButton.disabled = false;
  }
}

async function killActive(): Promise<void> {
  const session = activeSession();
  if (!session || session.status !== 'running') return;
  killButton.disabled = true;
  try {
    const updated = await terminal.kill(session.id);
    const index = sessions.findIndex((item) => item.id === updated.id);
    if (index >= 0) sessions[index] = updated;
    else sessions.unshift(updated);
    render();
  } catch {
    renderStatus();
  }
}

terminalButton.addEventListener('click', () => {
  if (open) closeTerminal();
  else void openTerminal();
});
closeButton.addEventListener('click', closeTerminal);
runButton.addEventListener('click', () => void runCommand());
killButton.addEventListener('click', () => void killActive());
historyButton.addEventListener('click', () => {
  const shouldOpen = !historyMenu.classList.contains('open');
  if (shouldOpen) {
    void refreshHistory();
    historyMenu.classList.add('open');
    historyButton.setAttribute('aria-expanded', 'true');
  } else closeHistory();
});
clearButton.addEventListener('click', () => {
  const projectId = selectedProjectId() || undefined;
  void terminal.clearHistory(projectId).then(async () => {
    await refreshHistory();
    closeHistory();
  });
});
projectSelect.addEventListener('change', () => {
  const projectSessions = sessions.filter((session) => session.projectId === projectSelect.value);
  activeSessionId = projectSessions.find((session) => session.status === 'running')?.id || projectSessions[0]?.id || '';
  closeHistory();
  render();
  void refreshHistory();
});
commandInput.addEventListener('input', () => {
  runButton.disabled = !selectedProjectId() || !commandInput.value.trim();
});
commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void runCommand();
  }
  if (event.key === 'Escape') closeHistory();
});
historyMenu.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-id]');
  if (!target) return;
  const entry = history.find((item) => item.id === target.dataset.historyId);
  if (!entry) return;
  projectSelect.value = entry.projectId;
  commandInput.value = entry.command;
  closeHistory();
  renderProjects();
  commandInput.focus();
  commandInput.select();
});
tabs.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-terminal-session]');
  if (!target) return;
  activeSessionId = target.dataset.terminalSession || '';
  render();
});
document.addEventListener('click', (event) => {
  if (!terminalPanel.contains(event.target as Node) && !terminalButton.contains(event.target as Node)) closeHistory();
});

void terminal.listSessions().then((loaded) => {
  sessions = loaded;
  const running = sessions.find((session) => session.status === 'running');
  activeSessionId = running?.id || sessions[0]?.id || '';
}).catch((): void => undefined);
