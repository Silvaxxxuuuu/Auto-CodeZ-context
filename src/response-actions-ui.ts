const STYLE_ID = 'auto-codez-response-actions';

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
    revealRun(runId, action === 'changes');
  });
  const messages = document.querySelector<HTMLElement>('#messages');
  if (messages) new MutationObserver(hydrate).observe(messages, { childList: true, subtree: true });
  window.addEventListener('auto-codez-execution-run-rendered', hydrate);
  window.addEventListener('auto-codez-execution-refresh', hydrate);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
