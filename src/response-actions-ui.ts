import type { ExecutionReport } from './execution-report';

const STYLE_ID = 'auto-codez-response-actions';
type ReportBridge = { getExecutionReport?: (input: { chatId: string; runId: string }) => Promise<ExecutionReport | null> };
const reportBridge = (window as unknown as { autoCodez?: ReportBridge }).autoCodez;

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ac-response-actions{display:flex;align-items:center;gap:3px;margin-top:8px;min-height:24px}
    .ac-response-action{display:grid;place-items:center;width:25px;height:25px;padding:0;border:0;border-radius:6px;background:transparent;color:#66717f;cursor:pointer}
    .ac-response-action:hover,.ac-response-action:focus-visible{background:#161c24;color:#dbe2ea;outline:none}
    .ac-response-action svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    .ac-response-action[data-state='done']{color:#78a989}
    .ac-response-action[hidden]{display:none}
    .ac-work-report-backdrop{position:fixed;inset:0;z-index:12500;display:grid;place-items:center;padding:24px;background:rgba(4,7,10,.72);backdrop-filter:blur(5px)}
    .ac-work-report{width:min(620px,calc(100vw - 32px));max-height:min(720px,calc(100vh - 48px));overflow:auto;border:1px solid #303843;border-radius:14px;background:#0f141a;box-shadow:0 30px 90px #0009}
    .ac-work-report-head{display:flex;justify-content:space-between;gap:18px;padding:15px 16px;border-bottom:1px solid #222a33}.ac-work-report-head strong{font-size:13px}.ac-work-report-head span{display:block;margin-top:4px;color:#74808d;font-size:9px}
    .ac-work-report-close{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:#84909d;cursor:pointer;font-size:18px}.ac-work-report-close:hover{background:#1a212a;color:#eef2f6}
    .ac-work-report-body{padding:13px 16px 16px}.ac-work-report-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.ac-work-fact{padding:9px;border:1px solid #222a33;border-radius:9px;background:#0c1015}.ac-work-fact b{display:block;font-size:16px;color:#e5e9ee}.ac-work-fact span{font-size:9px;color:#74808d}
    .ac-work-tools{margin-top:12px;border-top:1px solid #222a33;padding-top:10px}.ac-work-tool{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:10px;color:#b5bec8}.ac-work-tool span:last-child{color:#74808d}
    @media(max-width:560px){.ac-work-report-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  document.head.appendChild(style);
}

function icon(kind: 'copy' | 'work' | 'changes'): string {
  if (kind === 'copy') return '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  if (kind === 'changes') return '<svg viewBox="0 0 24 24"><path d="M8 6h11"/><path d="M8 12h11"/><path d="M8 18h11"/><path d="m3 6 1 1 2-2"/><path d="m3 12 1 1 2-2"/><path d="m3 18 1 1 2-2"/></svg>';
  return '<svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-4 3 2 5-6"/></svg>';
}

function button(kind: 'copy' | 'work' | 'changes', title: string, runId?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'ac-response-action';
  element.dataset.responseAction = kind;
  if (runId) element.dataset.runId = runId;
  element.title = title;
  element.setAttribute('aria-label', title);
  element.innerHTML = icon(kind);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function selectedChatId(): string {
  return document.querySelector<HTMLElement>('.chat-item.selected[data-chat]')?.dataset.chat || '';
}

function phaseLabel(phase: string): string {
  return ({ completed: 'Concluída', failed: 'Falhou', waiting: 'Aguardando', cancelled: 'Cancelada', running: 'Em andamento', queued: 'Na fila' } as Record<string, string>)[phase] || phase;
}

function showWorkReport(report: ExecutionReport): void {
  document.querySelector('.ac-work-report-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'ac-work-report-backdrop';
  const digest = report.recordedTools;
  backdrop.innerHTML = `<section class="ac-work-report" role="dialog" aria-modal="true" aria-label="Trabalho realizado"><header class="ac-work-report-head"><div><strong>Trabalho realizado</strong><span>Execução ${escapeHtml(report.runId)}</span></div><button type="button" class="ac-work-report-close" aria-label="Fechar">×</button></header><div class="ac-work-report-body"><div class="ac-work-report-facts"><div class="ac-work-fact"><b>${digest.observed}</b><span>operações observadas</span></div><div class="ac-work-fact"><b>${digest.completed}</b><span>concluídas</span></div><div class="ac-work-fact"><b>${digest.failed}</b><span>falharam</span></div><div class="ac-work-fact"><b>${digest.waiting}</b><span>aguardando</span></div><div class="ac-work-fact"><b>${report.steps.completed}/${report.steps.total}</b><span>passos concluídos</span></div><div class="ac-work-fact"><b>${report.evidence.file + report.evidence.test + report.evidence.build + report.evidence.result + report.evidence.tool}</b><span>evidências</span></div></div><div class="ac-work-tools">${digest.tools.length ? digest.tools.map((tool) => `<div class="ac-work-tool"><span>${escapeHtml(tool.toolName)}</span><span>${escapeHtml(phaseLabel(tool.phase))}</span></div>`).join('') : '<div class="ac-work-tool"><span>Nenhuma operação V2 registrada para esta execução.</span></div>'}</div></div></section>`;
  const close = () => backdrop.remove();
  backdrop.querySelector('.ac-work-report-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.body.appendChild(backdrop);
}

async function openWorkReport(runId: string): Promise<void> {
  const chatId = selectedChatId();
  if (!chatId || !reportBridge?.getExecutionReport) {
    revealRun(runId, false);
    return;
  }
  const report = await reportBridge.getExecutionReport({ chatId, runId });
  if (!report || report.chatId !== chatId || report.runId !== runId) {
    revealRun(runId, false);
    return;
  }
  showWorkReport(report);
}

function matchingRun(runId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.execution-run[data-run-id="${CSS.escape(runId)}"]`);
}

function hasVisibleChanges(runId: string): boolean {
  return Boolean(matchingRun(runId)?.querySelector('.activity-result-changes'));
}

function hydrate(): void {
  document.querySelectorAll<HTMLElement>('.message.assistant[data-final-assistant="true"]').forEach((message) => {
    let actions = message.querySelector<HTMLElement>(':scope > .ac-response-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'ac-response-actions';
      actions.appendChild(button('copy', 'Copiar resposta'));
      const runId = message.dataset.runId;
      if (runId) {
        actions.appendChild(button('work', 'Ver trabalho realizado', runId));
        const changes = button('changes', 'Ver alterações', runId);
        changes.hidden = !hasVisibleChanges(runId);
        actions.appendChild(changes);
      }
      message.appendChild(actions);
    } else {
      const changes = actions.querySelector<HTMLButtonElement>('[data-response-action="changes"]');
      const runId = changes?.dataset.runId;
      if (changes && runId) changes.hidden = !hasVisibleChanges(runId);
    }
  });
}

async function copyResponse(buttonElement: HTMLButtonElement): Promise<void> {
  const message = buttonElement.closest<HTMLElement>('.message.assistant');
  const content = message?.querySelector<HTMLElement>(':scope > .message-content')?.innerText ?? '';
  if (!content.trim()) return;
  await navigator.clipboard.writeText(content);
  buttonElement.dataset.state = 'done';
  buttonElement.title = 'Copiado';
  buttonElement.setAttribute('aria-label', 'Copiado');
  window.setTimeout(() => {
    if (!buttonElement.isConnected) return;
    delete buttonElement.dataset.state;
    buttonElement.title = 'Copiar resposta';
    buttonElement.setAttribute('aria-label', 'Copiar resposta');
  }, 1200);
}

function revealRun(runId: string, changesOnly: boolean): void {
  window.dispatchEvent(new CustomEvent('auto-codez-execution-refresh'));
  const run = matchingRun(runId);
  const target = changesOnly ? run?.querySelector<HTMLElement>('.activity-result-changes') : run;
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (run) {
    run.animate([
      { boxShadow: '0 0 0 0 rgba(140,155,175,0)' },
      { boxShadow: '0 0 0 1px rgba(140,155,175,.35)' },
      { boxShadow: '0 0 0 0 rgba(140,155,175,0)' },
    ], { duration: 900 });
  }
}

function initialize(): void {
  installStyle();
  hydrate();
  document.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-response-action]');
    if (!target) return;
    const action = target.dataset.responseAction;
    if (action === 'copy') {
      void copyResponse(target).catch(() => {
        target.title = 'Não foi possível copiar';
        target.setAttribute('aria-label', 'Não foi possível copiar');
      });
      return;
    }
    const runId = target.dataset.runId;
    if (!runId) return;
    if (action === 'work') { void openWorkReport(runId); return; }
    revealRun(runId, true);
  });
  const messages = document.querySelector<HTMLElement>('#messages');
  if (messages) new MutationObserver(hydrate).observe(messages, { childList: true, subtree: true });
  window.addEventListener('auto-codez-execution-run-rendered', hydrate);
  window.addEventListener('auto-codez-execution-refresh', hydrate);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
