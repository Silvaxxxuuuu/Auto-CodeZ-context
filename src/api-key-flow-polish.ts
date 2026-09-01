const STYLE_ID = 'api-key-flow-polish-style';

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .api-key-manager-backdrop{animation:ac-api-backdrop-in 160ms ease-out}
    .api-key-manager{animation:ac-api-manager-in 180ms cubic-bezier(.2,.8,.2,1)}
    .api-key-manager-backdrop.is-closing{animation:ac-api-backdrop-out 120ms ease-in forwards}
    .api-key-manager-backdrop.is-closing .api-key-manager{animation:ac-api-manager-out 120ms ease-in forwards}
    .api-key-manager-head{position:relative}
    .api-key-manager-head p{max-width:520px}
    .api-key-manager-toolbar{position:relative}
    .api-key-manager-add{white-space:nowrap}
    .api-key-card{transition:border-color 120ms ease,background 120ms ease,transform 120ms ease}
    .api-key-card:hover{border-color:#303a48;background:#141922}
    .api-key-card.active:hover{border-color:#4a5666}
    .api-key-actions button{transition:background 100ms ease,color 100ms ease,opacity 100ms ease}
    .api-key-field input:focus,.api-key-field select:focus,.api-key-inline-input:focus{box-shadow:0 0 0 2px #56647633}
    .api-key-save:not(:disabled):hover{filter:brightness(1.05)}
    .api-key-empty{display:grid;place-items:center;min-height:150px}
    .api-key-empty::before{content:'API';display:grid;place-items:center;width:38px;height:38px;margin-bottom:10px;border:1px solid #2a3340;border-radius:10px;color:#8993a1;font-size:10px;font-weight:700;letter-spacing:.08em}
    .api-key-flow-status{margin:0 20px 12px;padding:9px 11px;border:1px solid #28313d;border-radius:8px;background:#11151c;color:#8c96a4;font-size:10px;line-height:1.45}
    .api-key-flow-status strong{color:#dfe5ed;font-weight:650}
    .api-key-flow-status[hidden]{display:none}
    .api-key-edit::before,.api-key-delete::before{display:none!important;content:none!important}
    .api-key-edit .ac-lucide-icon,.api-key-delete .ac-lucide-icon{display:block;width:15px;height:15px;min-width:15px;min-height:15px;color:currentColor;stroke:currentColor;fill:none;stroke-width:2;pointer-events:none}
    .api-key-rail-button .ac-lucide-icon{display:block;width:17px;height:17px;min-width:17px;min-height:17px;color:currentColor;stroke:currentColor;fill:none;stroke-width:2;pointer-events:none}
    @keyframes ac-api-backdrop-in{from{opacity:0}to{opacity:1}}
    @keyframes ac-api-manager-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes ac-api-backdrop-out{to{opacity:0}}
    @keyframes ac-api-manager-out{to{opacity:0;transform:translateY(4px) scale(.99)}}
    @media(max-width:620px){
      .api-key-manager-backdrop{padding:12px}
      .api-key-manager{width:100%;max-height:calc(100vh - 24px);border-radius:13px}
      .api-key-manager-head{padding:18px 18px 14px}
      .api-key-manager-toolbar,.api-key-list{padding-left:14px;padding-right:14px}
      .api-key-manager-add{padding:0 9px}
    }
    @media(prefers-reduced-motion:reduce){
      .api-key-manager-backdrop,.api-key-manager,.api-key-manager-backdrop.is-closing,.api-key-manager-backdrop.is-closing .api-key-manager{animation:none}
      .api-key-card,.api-key-actions button{transition:none}
    }
  `;
  document.head.appendChild(style);
}

function getBackdrop(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.api-key-manager-backdrop');
}

function lucideSvg(paths: string[], className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ac-lucide-icon', className);
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function installActionIcons(backdrop: HTMLElement): void {
  const pencilPaths = ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'];
  const trashPaths = ['M10 11v6', 'M14 11v6', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'];
  backdrop.querySelectorAll<HTMLElement>('.api-key-edit').forEach((button) => {
    if (button.querySelector(':scope > .ac-lucide-icon')) return;
    button.appendChild(lucideSvg(pencilPaths, 'api-key-pencil-icon'));
  });
  backdrop.querySelectorAll<HTMLElement>('.api-key-delete').forEach((button) => {
    if (button.querySelector(':scope > .ac-lucide-icon')) return;
    button.appendChild(lucideSvg(trashPaths, 'api-key-trash-icon'));
  });
}

function installKeyIcon(): void {
  const button = document.querySelector<HTMLElement>('.api-key-rail-button');
  if (!button || button.querySelector(':scope > .ac-lucide-icon[data-api-key-icon="true"]')) return;
  const existing = button.querySelector(':scope > .ac-lucide-icon');
  if (existing) {
    existing.remove();
  }
  const key = lucideSvg(['M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z'], 'api-key-rail-icon');
  key.dataset.apiKeyIcon = 'true';
  key.dataset.acLucideIcon = 'key-round';
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '16.5');
  circle.setAttribute('cy', '7.5');
  circle.setAttribute('r', '.5');
  circle.setAttribute('fill', 'currentColor');
  key.appendChild(circle);
  button.appendChild(key);
}

function installStatus(backdrop: HTMLElement): void {
  const toolbar = backdrop.querySelector<HTMLElement>('.api-key-manager-toolbar');
  const list = backdrop.querySelector<HTMLElement>('.api-key-list');
  if (!toolbar || !list || backdrop.querySelector('.api-key-flow-status')) return;
  const status = document.createElement('div');
  status.className = 'api-key-flow-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  toolbar.insertAdjacentElement('afterend', status);

  const update = (): void => {
    const cards = [...list.querySelectorAll<HTMLElement>('.api-key-card')];
    const active = cards.find((card) => card.classList.contains('active'));
    if (active) {
      const name = active.querySelector('.api-key-card-title strong')?.textContent?.trim();
      status.innerHTML = `<strong>IA pronta.</strong> ${name ? `A chave ativa é “${name}”.` : 'Uma API key está ativa.'}`;
      status.hidden = false;
    } else if (cards.length) {
      status.innerHTML = '<strong>Nenhuma chave ativa.</strong> Selecione uma chave antes de iniciar uma conversa.';
      status.hidden = false;
    } else {
      status.hidden = true;
    }
  };

  new MutationObserver(update).observe(list, { childList: true, subtree: true });
  update();
}

function installKeyboardBehavior(backdrop: HTMLElement): void {
  if (backdrop.dataset.keyboardReady === 'true') return;
  backdrop.dataset.keyboardReady = 'true';
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const form = backdrop.querySelector<HTMLFormElement>('.api-key-manager-form.open');
      if (form) {
        backdrop.querySelector<HTMLButtonElement>('.api-key-cancel')?.click();
        return;
      }
      backdrop.querySelector<HTMLButtonElement>('.api-key-manager-close')?.click();
    }
  });
}

function installFocusBehavior(backdrop: HTMLElement): void {
  if (backdrop.dataset.focusReady === 'true') return;
  backdrop.dataset.focusReady = 'true';
  const close = backdrop.querySelector<HTMLButtonElement>('.api-key-manager-close');
  close?.focus();
}

function enhance(): void {
  installStyles();
  installKeyIcon();
  const backdrop = getBackdrop();
  if (!backdrop) return;
  installActionIcons(backdrop);
  installStatus(backdrop);
  installKeyboardBehavior(backdrop);
  installFocusBehavior(backdrop);
}

installStyles();
const observer = new MutationObserver(enhance);
observer.observe(document.body, { childList: true, subtree: true });
enhance();
