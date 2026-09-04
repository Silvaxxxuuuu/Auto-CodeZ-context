type StopBridge = { stopChat: (chatId: string) => Promise<{ stopped: boolean }> };

let installed = false;
let syncing = false;
let promptObserver: MutationObserver | null = null;
let buttonObserver: MutationObserver | null = null;
let domObserver: MutationObserver | null = null;

function bridge(): StopBridge { return (window as unknown as { autoCodez: StopBridge }).autoCodez; }
function selectedChatId(): string | undefined { return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat; }

function syncStopButton(): void {
  if (syncing) return;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;

  syncing = true;
  try {
    const approvalVisible = Boolean(document.querySelector('[data-approve], [data-deny]'));
    const stopping = prompt.disabled && !approvalVisible;

    if (button.classList.contains('is-stop') !== stopping) button.classList.toggle('is-stop', stopping);

    const title = stopping ? 'Parar' : 'Enviar';
    if (button.title !== title) button.title = title;
    if (button.getAttribute('aria-label') !== title) button.setAttribute('aria-label', title);

    if (stopping) {
      if (!button.querySelector(':scope > .stop-icon')) {
        const stopIcon = document.createElement('span');
        stopIcon.className = 'stop-icon';
        button.replaceChildren(stopIcon);
      }
      if (button.disabled) button.disabled = false;
      return;
    }

    if (button.querySelector(':scope > .stop-icon')) button.replaceChildren();
    const disabled = !selectedChatId() || !prompt.value.trim();
    if (button.disabled !== disabled) button.disabled = disabled;
  } finally {
    syncing = false;
  }
}

function disconnectObservers(): void {
  promptObserver?.disconnect();
  buttonObserver?.disconnect();
  domObserver?.disconnect();
  promptObserver = null;
  buttonObserver = null;
  domObserver = null;
}

function installWhenReady(): void {
  if (installed) return;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;

  installed = true;
  disconnectObservers();

  promptObserver = new MutationObserver(syncStopButton);
  promptObserver.observe(prompt, { attributes: true, attributeFilter: ['disabled'] });

  buttonObserver = new MutationObserver(syncStopButton);
  buttonObserver.observe(button, { attributes: true, attributeFilter: ['disabled'], childList: true });

  prompt.addEventListener('input', syncStopButton);

  button.addEventListener('click', (event): void => {
    if (!button.classList.contains('is-stop')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const chatId = selectedChatId();
    if (!chatId) {
      syncStopButton();
      return;
    }
    if (!button.disabled) button.disabled = true;
    void bridge().stopChat(chatId).catch((): undefined => undefined);
  }, true);

  syncStopButton();
}

function install(): void {
  installWhenReady();
  if (installed) return;
  domObserver = new MutationObserver(installWhenReady);
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
}

install();
