type StopBridge = { stopChat: (chatId: string) => Promise<{ stopped: boolean }> };

let installed = false;
let promptObserver: MutationObserver | null = null;
let buttonObserver: MutationObserver | null = null;
let domObserver: MutationObserver | null = null;

function bridge(): StopBridge { return (window as unknown as { autoCodez: StopBridge }).autoCodez; }
function selectedChatId(): string | undefined { return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat; }

function syncStopButton(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;
  const approvalVisible = Boolean(document.querySelector('[data-approve], [data-deny]'));
  const stopping = prompt.disabled && !approvalVisible;
  button.classList.toggle('is-stop', stopping);
  button.title = stopping ? 'Parar' : 'Enviar';
  button.setAttribute('aria-label', stopping ? 'Parar' : 'Enviar');
  if (stopping) {
    if (!button.querySelector(':scope > .stop-icon')) {
      button.replaceChildren(Object.assign(document.createElement('span'), { className: 'stop-icon' }));
    }
    button.disabled = false;
    return;
  }
  if (button.querySelector(':scope > .stop-icon')) button.replaceChildren();
  button.disabled = !selectedChatId() || !prompt.value.trim();
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
  buttonObserver.observe(button, { attributes: true, childList: true });
  button.addEventListener('click', (event): void => {
    if (!button.classList.contains('is-stop')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const chatId = selectedChatId();
    if (!chatId) return syncStopButton();
    button.disabled = true;
    void bridge().stopChat(chatId).catch((): void => undefined);
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
