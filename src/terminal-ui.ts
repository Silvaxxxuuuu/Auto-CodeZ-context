import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type TerminalShell = 'cmd' | 'powershell';
type TerminalSession = {
  id: string;
  projectId: string;
  shell: TerminalShell;
  cwd: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: string;
  status: 'running' | 'exited' | 'failed' | 'killed';
  interactive: boolean;
  cols?: number;
  rows?: number;
  pty: boolean;
};
type TerminalEvent =
  | { type: 'output'; event: { sessionId: string; stream: 'stdout' | 'stderr'; text: string } }
  | { type: 'exit'; event: { sessionId: string; exitCode: number; signal?: string }; session: TerminalSession; history: unknown };
type TerminalApi = {
  start: (input: { projectId: string; command: string }) => Promise<TerminalSession>;
  writeInput: (input: { sessionId: string; data: string }) => Promise<TerminalSession>;
  resize: (input: { sessionId: string; cols: number; rows: number }) => Promise<TerminalSession>;
  kill: (sessionId: string) => Promise<TerminalSession>;
  listSessions: () => Promise<TerminalSession[]>;
  getOutput: (sessionId: string) => Promise<string>;
  onEvent: (listener: (event: TerminalEvent) => void) => () => void;
};
type Bridge = { terminal: TerminalApi };
type SessionView = { host: HTMLDivElement; terminal: Terminal; fit: FitAddon };

const terminalApi = (window.autoCodez as unknown as Bridge).terminal;
const chatArea = document.querySelector<HTMLElement>('.chat-area');
const rail = document.querySelector<HTMLElement>('.rail');
if (!chatArea || !rail) throw new Error('Estrutura principal da interface não encontrada.');

const MIN_PANEL_HEIGHT = 180;
const DEFAULT_PANEL_HEIGHT = 360;
const MIN_CHAT_REMAINDER = 190;
const PANEL_HEIGHT_STORAGE_KEY = 'auto-codez-terminal-height';

function readStoredPanelHeight(): number {
  const value = Number(window.localStorage.getItem(PANEL_HEIGHT_STORAGE_KEY));
  return Number.isFinite(value) && value >= MIN_PANEL_HEIGHT ? value : DEFAULT_PANEL_HEIGHT;
}

const style = document.createElement('style');
style.textContent = `
.terminal-rail-button:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='m7 7 5 5-5 5 1.5 1.5 6.5-6.5-6.5-6.5L7 7Zm8 9h5v2h-5v-2Z'/%3E%3C/svg%3E")}
.terminal-panel{display:none;position:relative;flex:none;height:360px;min-height:${MIN_PANEL_HEIGHT}px;border-top:1px solid #202631;background:#080a0e;color:#d9dee7;flex-direction:column;overflow:hidden}.terminal-panel.open{display:flex}
.terminal-resize-handle{position:absolute;z-index:12;top:0;left:0;right:0;height:12px;transform:translateY(-6px);cursor:ns-resize;touch-action:none}.terminal-resize-handle:after{content:'';position:absolute;left:50%;top:5px;width:52px;height:2px;border-radius:2px;background:#697586;opacity:0;transform:translateX(-50%);transition:opacity .12s}.terminal-resize-handle:hover:after,.terminal-panel.resizing .terminal-resize-handle:after{opacity:.9}.terminal-panel.resizing,.terminal-panel.resizing *{user-select:none!important;cursor:ns-resize!important}
.terminal-toolbar{height:38px;flex:none;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid #202631;background:#0d1016}.terminal-title{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:10px;font-weight:700;color:#dce2ea;margin-right:auto;letter-spacing:.08em}.terminal-shell-select,.terminal-toolbar-button{height:27px;border:1px solid #252c36;border-radius:6px;background:#11151c;color:#c4ccd6;outline:none;font:10px Inter,ui-sans-serif,system-ui,sans-serif}.terminal-shell-select{padding:0 8px}.terminal-toolbar-button{padding:0 9px;cursor:pointer}.terminal-toolbar-button:hover{background:#171c24;color:#eef2f7;border-color:#303845}.terminal-toolbar-button:disabled{opacity:.45;cursor:default}
.terminal-tabs{height:31px;flex:none;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid #181d25;background:#0b0e13;overflow:auto}.terminal-tab{height:25px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid transparent;border-radius:5px;background:transparent;color:#707a88;cursor:pointer;font:9px Inter,ui-sans-serif,system-ui,sans-serif;white-space:nowrap}.terminal-tab:hover{background:#141920;color:#aeb7c4}.terminal-tab.active{background:#161b23;border-color:#252c36;color:#e1e6ed}.terminal-tab-dot{width:6px;height:6px;border-radius:50%;background:#5e6876}.terminal-tab-dot.running{background:#c2cbd6;box-shadow:0 0 7px #c2cbd655}
.terminal-body{position:relative;min-height:0;flex:1;background:#080a0e}.terminal-session-host{display:none;position:absolute;inset:0;padding:8px 10px 6px;overflow:hidden}.terminal-session-host.active{display:block}.terminal-session-host .xterm{height:100%}.terminal-session-host .xterm-viewport{scrollbar-width:thin}.terminal-placeholder{position:absolute;inset:0;display:flex;align-items:flex-start;padding:13px;color:#596371;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;pointer-events:none}.terminal-placeholder.hidden{display:none}.terminal-footer{height:25px;flex:none;display:flex;align-items:center;padding:0 12px;border-top:1px solid #181d25;background:#0b0e13}.terminal-status{color:#626c79;font:9px Inter,ui-sans-serif,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.terminal-panel .xterm-screen,.terminal-panel .xterm-rows{font-variant-ligatures:none}
@media(max-width:900px){.terminal-panel{height:300px}}
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
panel.style.height = `${readStoredPanelHeight()}px`;
panel.innerHTML = `<div class="terminal-resize-handle" id="terminal-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Redimensionar terminal" title="Arraste para redimensionar · duplo clique restaura"></div><div class="terminal-toolbar"><strong class="terminal-title">TERMINAL</strong><select class="terminal-shell-select" id="terminal-shell" aria-label="Shell"><option value="powershell">PowerShell</option><option value="cmd">Command Prompt (cmd)</option></select><button class="terminal-toolbar-button" id="terminal-new" type="button">Novo</button><button class="terminal-toolbar-button" id="terminal-kill" type="button" disabled>Parar</button><button class="terminal-toolbar-button" id="terminal-clear" type="button">Limpar</button><button class="terminal-toolbar-button" id="terminal-close" type="button" aria-label="Fechar terminal">×</button></div><div class="terminal-tabs" id="terminal-tabs"></div><div class="terminal-body" id="terminal-body"><div class="terminal-placeholder" id="terminal-placeholder">Abra uma sessão para usar o terminal.</div></div><div class="terminal-footer"><span class="terminal-status" id="terminal-status">Nenhuma sessão ativa</span></div>`;
chatArea.appendChild(panel);

const resizeHandle = panel.querySelector<HTMLDivElement>('#terminal-resize-handle')!;
const shellSelect = panel.querySelector<HTMLSelectElement>('#terminal-shell')!;
const newButton = panel.querySelector<HTMLButtonElement>('#terminal-new')!;
const killButton = panel.querySelector<HTMLButtonElement>('#terminal-kill')!;
const clearButton = panel.querySelector<HTMLButtonElement>('#terminal-clear')!;
const closeButton = panel.querySelector<HTMLButtonElement>('#terminal-close')!;
const tabs = panel.querySelector<HTMLDivElement>('#terminal-tabs')!;
const body = panel.querySelector<HTMLDivElement>('#terminal-body')!;
const placeholder = panel.querySelector<HTMLDivElement>('#terminal-placeholder')!;
const status = panel.querySelector<HTMLSpanElement>('#terminal-status')!;

let sessions: TerminalSession[] = [];
let activeSessionId = '';
let open = false;
let fitFrame = 0;
let interruptPending = false;
let openingDefaultSession = false;
let resizePointerId: number | null = null;
let resizeStartY = 0;
let resizeStartHeight = 0;
const outputBuffers = new Map<string, string>();
const views = new Map<string, SessionView>();

function activeSession(): TerminalSession | undefined {
  return sessions.find((session) => session.id === activeSessionId);
}

function shellLabel(shell: TerminalShell): string {
  return shell === 'powershell' ? 'PowerShell' : 'cmd';
}

function sessionLabel(session: TerminalSession): string {
  const transport = session.pty ? 'PTY' : session.interactive ? 'compatibilidade' : 'processo';
  const exit = session.exitCode === undefined ? '' : ` · exit ${session.exitCode}`;
  return `${shellLabel(session.shell)} · ${transport} · ${session.status}${exit}`;
}

function renderTabs(): void {
  tabs.innerHTML = sessions.map((session) => `<button class="terminal-tab ${session.id === activeSessionId ? 'active' : ''}" data-terminal-session="${session.id}" type="button"><span class="terminal-tab-dot ${session.status === 'running' ? 'running' : ''}"></span>${shellLabel(session.shell)}</button>`).join('') || '<span class="terminal-placeholder-text">Nenhuma sessão</span>';
}

function renderStatus(): void {
  const session = activeSession();
  killButton.disabled = session?.status !== 'running' || !session.interactive || interruptPending;
  clearButton.disabled = !session;
  status.textContent = session ? sessionLabel(session) : 'Nenhuma sessão ativa';
  placeholder.classList.toggle('hidden', Boolean(session));
  if (session) shellSelect.value = session.shell;
}

function updateSession(updated: TerminalSession): void {
  const index = sessions.findIndex((session) => session.id === updated.id);
  if (index >= 0) sessions[index] = updated;
  else sessions.unshift(updated);
}

function createTerminal(sessionId: string): SessionView {
  const host = document.createElement('div');
  host.className = 'terminal-session-host';
  host.dataset.terminalHost = sessionId;
  body.insertBefore(host, placeholder);

  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'Cascadia Mono, Consolas, ui-monospace, SFMono-Regular, monospace',
    fontSize: 12,
    lineHeight: 1.18,
    scrollback: 10_000,
    tabStopWidth: 4,
    theme: {
      background: '#080a0e',
      foreground: '#d5dbe4',
      cursor: '#dce2ea',
      cursorAccent: '#080a0e',
      selectionBackground: '#33415599',
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === 'a') {
      terminal.selectAll();
      return false;
    }
    if (key === 'c') {
      if (terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
          status.textContent = 'Não foi possível copiar o texto selecionado.';
        });
      } else if (activeSessionId === sessionId) {
        void interruptActiveSession();
      }
      return false;
    }
    return true;
  });

  terminal.onData((data) => {
    if (activeSessionId !== sessionId) return;
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || session.status !== 'running' || !session.interactive) return;
    void terminalApi.writeInput({ sessionId, data }).then(updateSession).catch((error) => {
      status.textContent = error instanceof Error ? error.message : 'Não foi possível enviar dados ao terminal.';
    });
  });

  terminal.onResize(({ cols, rows }) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || session.status !== 'running' || !session.interactive) return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    void terminalApi.resize({ sessionId, cols, rows }).then(updateSession).catch((error) => {
      status.textContent = error instanceof Error ? error.message : 'Não foi possível redimensionar o terminal.';
    });
  });

  const view = { host, terminal, fit };
  views.set(sessionId, view);
  const snapshot = outputBuffers.get(sessionId) || '';
  if (snapshot) terminal.write(snapshot, () => terminal.scrollToBottom());
  return view;
}

function ensureView(sessionId: string): SessionView {
  return views.get(sessionId) || createTerminal(sessionId);
}

function activateView(): void {
  for (const [sessionId, view] of views) view.host.classList.toggle('active', sessionId === activeSessionId);
  const session = activeSession();
  if (!session) return;
  const view = ensureView(session.id);
  view.host.classList.add('active');
}

function render(): void {
  renderTabs();
  renderStatus();
  activateView();
  scheduleFit();
}

async function refreshSessions(): Promise<void> {
  sessions = await terminalApi.listSessions();
  if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId)) {
    activeSessionId = sessions.find((session) => session.status === 'running')?.id || sessions[0]?.id || '';
  }
  await Promise.all(sessions.map(async (session) => {
    if (!outputBuffers.has(session.id)) outputBuffers.set(session.id, await terminalApi.getOutput(session.id));
  }));
  render();
}

async function openSession(shell: TerminalShell): Promise<void> {
  try {
    const session = await terminalApi.start({ projectId: '__global__', command: `__AUTO_CODEZ_SHELL__${shell}` });
    updateSession(session);
    activeSessionId = session.id;
    if (!outputBuffers.has(session.id)) outputBuffers.set(session.id, await terminalApi.getOutput(session.id));
    render();
    ensureView(session.id).terminal.focus();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Não foi possível abrir o terminal.';
  }
}

async function interruptActiveSession(): Promise<void> {
  const session = activeSession();
  if (!session || session.status !== 'running' || !session.interactive || interruptPending) return;
  interruptPending = true;
  renderStatus();
  try {
    updateSession(await terminalApi.writeInput({ sessionId: session.id, data: '\x03' }));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Não foi possível interromper o comando.';
  } finally {
    interruptPending = false;
    renderStatus();
    views.get(session.id)?.terminal.focus();
  }
}

async function clearActiveSession(): Promise<void> {
  const session = activeSession();
  if (!session) return;
  outputBuffers.set(session.id, '');
  const view = ensureView(session.id);
  view.terminal.clear();
  if (session.status === 'running' && session.interactive) {
    try {
      const clearCommand = session.shell === 'powershell' ? 'Clear-Host\r' : 'cls\r';
      updateSession(await terminalApi.writeInput({ sessionId: session.id, data: clearCommand }));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Não foi possível limpar o terminal.';
    }
  }
  view.terminal.focus();
}

function scheduleFit(): void {
  if (!open || !activeSessionId) return;
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const view = views.get(activeSessionId);
    if (!view || !view.host.classList.contains('active')) return;
    try {
      view.fit.fit();
    } catch {}
  });
}

function setOpen(value: boolean): void {
  open = value;
  panel.classList.toggle('open', open);
  button.setAttribute('aria-expanded', String(open));
  button.classList.toggle('active', open);
  if (!open) return;
  void refreshSessions().then(async () => {
    if (!activeSession() && !openingDefaultSession) {
      openingDefaultSession = true;
      shellSelect.value = 'powershell';
      try {
        await openSession('powershell');
      } finally {
        openingDefaultSession = false;
      }
    }
    scheduleFit();
    views.get(activeSessionId)?.terminal.focus();
  });
}

function maxPanelHeight(): number {
  return Math.max(MIN_PANEL_HEIGHT, Math.floor(chatArea.getBoundingClientRect().height - MIN_CHAT_REMAINDER));
}

function setPanelHeight(height: number): void {
  const nextHeight = Math.min(maxPanelHeight(), Math.max(MIN_PANEL_HEIGHT, height));
  panel.style.height = `${Math.round(nextHeight)}px`;
  scheduleFit();
}

function finishPanelResize(): void {
  if (resizePointerId === null) return;
  try {
    resizeHandle.releasePointerCapture(resizePointerId);
  } catch {}
  resizePointerId = null;
  panel.classList.remove('resizing');
  window.localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(Math.round(panel.getBoundingClientRect().height)));
  scheduleFit();
}

resizeHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  resizePointerId = event.pointerId;
  resizeStartY = event.clientY;
  resizeStartHeight = panel.getBoundingClientRect().height;
  panel.classList.add('resizing');
  resizeHandle.setPointerCapture(event.pointerId);
  event.preventDefault();
});
resizeHandle.addEventListener('pointermove', (event) => {
  if (resizePointerId !== event.pointerId) return;
  setPanelHeight(resizeStartHeight + resizeStartY - event.clientY);
});
resizeHandle.addEventListener('pointerup', finishPanelResize);
resizeHandle.addEventListener('pointercancel', finishPanelResize);
resizeHandle.addEventListener('dblclick', () => {
  setPanelHeight(DEFAULT_PANEL_HEIGHT);
  window.localStorage.setItem(PANEL_HEIGHT_STORAGE_KEY, String(DEFAULT_PANEL_HEIGHT));
});

button.addEventListener('click', () => setOpen(!open));
closeButton.addEventListener('click', () => setOpen(false));
shellSelect.addEventListener('change', () => void openSession(shellSelect.value as TerminalShell));
newButton.addEventListener('click', () => void openSession(shellSelect.value as TerminalShell));
killButton.addEventListener('click', () => void interruptActiveSession());
clearButton.addEventListener('click', () => void clearActiveSession());
tabs.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-terminal-session]');
  if (!target?.dataset.terminalSession) return;
  activeSessionId = target.dataset.terminalSession;
  render();
  views.get(activeSessionId)?.terminal.focus();
});

const unsubscribeTerminal = terminalApi.onEvent((event) => {
  if (event.type === 'output') {
    const current = outputBuffers.get(event.event.sessionId) || '';
    outputBuffers.set(event.event.sessionId, (current + event.event.text).slice(-2_000_000));
    const view = views.get(event.event.sessionId);
    if (view) {
      const wasNearBottom = view.terminal.buffer.active.viewportY >= view.terminal.buffer.active.baseY - 1;
      view.terminal.write(event.event.text, () => {
        if (wasNearBottom) view.terminal.scrollToBottom();
      });
    }
    return;
  }
  updateSession(event.session);
  renderStatus();
  renderTabs();
});

const resizeObserver = new ResizeObserver(() => scheduleFit());
resizeObserver.observe(body);
window.addEventListener('resize', () => {
  if (open) setPanelHeight(panel.getBoundingClientRect().height);
});
window.addEventListener('beforeunload', () => {
  unsubscribeTerminal();
  resizeObserver.disconnect();
  if (fitFrame) cancelAnimationFrame(fitFrame);
  for (const view of views.values()) view.terminal.dispose();
  views.clear();
}, { once: true });

void refreshSessions();
