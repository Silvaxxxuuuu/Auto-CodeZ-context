type TerminalShell = 'cmd' | 'powershell';
type TerminalSession = { id: string; projectId: string; shell: TerminalShell; cwd: string; command: string; startedAt: number; finishedAt?: number; exitCode?: number; signal?: string; status: 'running' | 'exited' | 'failed' | 'killed' };
type TerminalEvent = { type: 'output'; event: { sessionId: string; stream: 'stdout' | 'stderr'; text: string } } | { type: 'exit'; event: { sessionId: string; exitCode: number; signal?: string }; session: TerminalSession; history: unknown };
type TerminalApi = { start: (input: { projectId: string; command: string }) => Promise<TerminalSession>; kill: (sessionId: string) => Promise<TerminalSession>; listSessions: () => Promise<TerminalSession[]>; getOutput: (sessionId: string) => Promise<string>; onEvent: (listener: (event: TerminalEvent) => void) => () => void };
type Bridge = { terminal: TerminalApi };
const terminal = (window.autoCodez as unknown as Bridge).terminal;
const chatArea = document.querySelector<HTMLElement>('.chat-area');
const rail = document.querySelector<HTMLElement>('.rail');
if (!chatArea || !rail) throw new Error('Estrutura principal da interface não encontrada.');

const style = document.createElement('style');
style.textContent = `
.terminal-rail-button:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='m7 7 5 5-5 5 1.5 1.5 6.5-6.5-6.5-6.5L7 7Zm8 9h5v2h-5v-2Z'/%3E%3C/svg%3E")}
.terminal-panel{display:none;position:relative;flex:none;height:360px;min-height:240px;border-top:1px solid #202631;background:#080a0e;color:#d9dee7;flex-direction:column;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace}.terminal-panel.open{display:flex}
.terminal-toolbar{height:38px;flex:none;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid #202631;background:#0d1016}.terminal-title{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:10px;font-weight:700;color:#dce2ea;margin-right:auto;letter-spacing:.08em}.terminal-shell-select,.terminal-toolbar-button{height:27px;border:1px solid #252c36;border-radius:6px;background:#11151c;color:#c4ccd6;outline:none;font:inherit;font-size:10px}.terminal-shell-select{padding:0 8px}.terminal-toolbar-button{padding:0 9px;cursor:pointer}.terminal-toolbar-button:hover{background:#171c24;color:#eef2f7;border-color:#303845}.terminal-toolbar-button:disabled{opacity:.45;cursor:default}
.terminal-tabs{height:31px;flex:none;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid #181d25;background:#0b0e13;overflow:auto}.terminal-tab{height:25px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid transparent;border-radius:5px;background:transparent;color:#707a88;cursor:pointer;font:inherit;font-size:9px;white-space:nowrap}.terminal-tab:hover{background:#141920;color:#aeb7c4}.terminal-tab.active{background:#161b23;border-color:#252c36;color:#e1e6ed}.terminal-tab-dot{width:6px;height:6px;border-radius:50%;background:#5e6876}.terminal-tab-dot.running{background:#c2cbd6;box-shadow:0 0 7px #c2cbd655}
.terminal-output{min-height:0;flex:1;overflow:auto;padding:10px 13px 6px;background:#080a0e;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#d5dbe4}.terminal-empty{color:#596371}.terminal-input-row{display:flex;align-items:center;gap:8px;flex:none;padding:7px 12px 9px;border-top:1px solid #181d25;background:#0b0e13}.terminal-prompt{flex:none;color:#8f9baa;font-size:11px;user-select:none}.terminal-input{flex:1;min-width:0;height:30px;padding:0;border:0;outline:0;background:transparent;color:#e8edf4;font:11px/1.4 inherit}.terminal-input::placeholder{color:#596371}.terminal-status{flex:none;color:#626c79;font:9px Inter,ui-sans-serif,system-ui,sans-serif;margin-left:8px}@media(max-width:900px){.terminal-panel{height:300px}.terminal-status{display:none}}
`;
document.head.appendChild(style);

const button = document.createElement('button');
button.className = 'rail-button terminal-rail-button';
button.type = 'button';
button.title = 'Terminal';
button.setAttribute('aria-label', 'Terminal');
button.setAttribute('aria-expanded', 'false');
rail.insertBefore(button, rail.querySelector('.rail-spacer'));

const panel = document.createElement('section');
panel.className = 'terminal-panel';
panel.setAttribute('aria-label', 'Terminal');
panel.innerHTML = `<div class="terminal-toolbar"><strong class="terminal-title">TERMINAL</strong><select class="terminal-shell-select" id="terminal-shell" aria-label="Shell"><option value="powershell">PowerShell</option><option value="cmd">Command Prompt (cmd)</option></select><button class="terminal-toolbar-button" id="terminal-new" type="button">Novo</button><button class="terminal-toolbar-button" id="terminal-kill" type="button" disabled>Parar</button><button class="terminal-toolbar-button" id="terminal-clear" type="button">Limpar</button><button class="terminal-toolbar-button" id="terminal-close" type="button" aria-label="Fechar terminal">×</button></div><div class="terminal-tabs" id="terminal-tabs"></div><div class="terminal-output" id="terminal-output"><span class="terminal-empty">Abra uma sessão e digite um comando.</span></div><div class="terminal-input-row"><span class="terminal-prompt" id="terminal-prompt">&gt;</span><input class="terminal-input" id="terminal-input" type="text" autocomplete="off" spellcheck="false" placeholder="Digite um comando..."><span class="terminal-status" id="terminal-status">Nenhuma sessão ativa</span></div>`;
chatArea.appendChild(panel);

const shellSelect = panel.querySelector<HTMLSelectElement>('#terminal-shell')!;
const newButton = panel.querySelector<HTMLButtonElement>('#terminal-new')!;
const killButton = panel.querySelector<HTMLButtonElement>('#terminal-kill')!;
const clearButton = panel.querySelector<HTMLButtonElement>('#terminal-clear')!;
const closeButton = panel.querySelector<HTMLButtonElement>('#terminal-close')!;
const tabs = panel.querySelector<HTMLDivElement>('#terminal-tabs')!;
const output = panel.querySelector<HTMLDivElement>('#terminal-output')!;
const input = panel.querySelector<HTMLInputElement>('#terminal-input')!;
const promptLabel = panel.querySelector<HTMLSpanElement>('#terminal-prompt')!;
const status = panel.querySelector<HTMLSpanElement>('#terminal-status')!;
let sessions: TerminalSession[] = [];
let activeSessionId = '';
const outputBuffers = new Map<string, string>();
let open = false;

function activeSession(): TerminalSession | undefined { return sessions.find((session) => session.id === activeSessionId); }
function shellLabel(shell: TerminalShell): string { return shell === 'powershell' ? 'PowerShell' : 'cmd'; }
function renderTabs(): void { tabs.innerHTML = sessions.map((session) => `<button class="terminal-tab ${session.id === activeSessionId ? 'active' : ''}" data-terminal-session="${session.id}" type="button"><span class="terminal-tab-dot ${session.status === 'running' ? 'running' : ''}"></span>${shellLabel(session.shell)}</button>`).join('') || '<span class="terminal-empty">Nenhuma sessão</span>'; }
function renderOutput(): void { const session = activeSession(); if (!session) { output.innerHTML = '<span class="terminal-empty">Abra uma sessão e digite um comando.</span>'; return; } output.textContent = outputBuffers.get(session.id) || ''; output.scrollTop = output.scrollHeight; promptLabel.textContent = `${session.cwd}>`; }
function renderStatus(): void { const session = activeSession(); const running = session?.status === 'running'; killButton.disabled = !running; input.disabled = !running; status.textContent = session ? `${shellLabel(session.shell)} · ${session.status}${session.exitCode !== undefined ? ` · exit ${session.exitCode}` : ''}` : 'Nenhuma sessão ativa'; }
function render(): void { renderTabs(); renderOutput(); renderStatus(); }
async function refreshSessions(): Promise<void> { sessions = await terminal.listSessions(); if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId)) activeSessionId = sessions.find((session) => session.status === 'running')?.id || sessions[0]?.id || ''; for (const session of sessions) if (!outputBuffers.has(session.id)) outputBuffers.set(session.id, await terminal.getOutput(session.id)); render(); }
async function openSession(shell: TerminalShell): Promise<void> { try { const existing = sessions.find((session) => session.shell === shell && session.status === 'running'); if (existing) { activeSessionId = existing.id; render(); input.focus(); return; } const session = await terminal.start({ projectId: '__global__', command: `__AUTO_CODEZ_SHELL__${shell}` }); sessions = [session, ...sessions.filter((item) => item.id !== session.id)]; activeSessionId = session.id; outputBuffers.set(session.id, ''); render(); input.focus(); } catch (error) { status.textContent = error instanceof Error ? error.message : 'Não foi possível abrir o terminal.'; } }
function toggle(): void { open = !open; panel.classList.toggle('open', open); button.setAttribute('aria-expanded', String(open)); button.classList.toggle('active', open); if (open) { void refreshSessions(); input.focus(); } }
button.addEventListener('click', toggle);
closeButton.addEventListener('click', () => { open = false; panel.classList.remove('open'); button.classList.remove('active'); button.setAttribute('aria-expanded', 'false'); });
shellSelect.addEventListener('change', () => void openSession(shellSelect.value as TerminalShell));
newButton.addEventListener('click', () => void openSession(shellSelect.value as TerminalShell));
killButton.addEventListener('click', () => { const session = activeSession(); if (session) void terminal.kill(session.id).then(() => refreshSessions()); });
clearButton.addEventListener('click', () => { const session = activeSession(); if (session) { outputBuffers.set(session.id, ''); renderOutput(); } });
tabs.addEventListener('click', (event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-terminal-session]'); if (target?.dataset.terminalSession) { activeSessionId = target.dataset.terminalSession; render(); input.focus(); } });
input.addEventListener('keydown', (event) => { if (event.key !== 'Enter' || event.shiftKey) return; event.preventDefault(); const session = activeSession(); const value = input.value.trim(); if (!session || session.status !== 'running' || !value) return; input.value = ''; void terminal.start({ projectId: '__global__', command: `__AUTO_CODEZ_WRITE__${JSON.stringify({ sessionId: session.id, command: value })}` }).then((updated) => { const index = sessions.findIndex((item) => item.id === updated.id); if (index >= 0) sessions[index] = updated; render(); }).catch((error) => { status.textContent = error instanceof Error ? error.message : 'Não foi possível enviar o comando.'; }); });
terminal.onEvent((event) => { if (event.type === 'output') { const current = outputBuffers.get(event.event.sessionId) || ''; outputBuffers.set(event.event.sessionId, (current + event.event.text).slice(-2_000_000)); if (activeSessionId === event.event.sessionId) renderOutput(); return; } const index = sessions.findIndex((session) => session.id === event.session.id); if (index >= 0) sessions[index] = event.session; outputBuffers.set(event.session.id, outputBuffers.get(event.session.id) || ''); if (activeSessionId === event.session.id) render(); });
void refreshSessions();
