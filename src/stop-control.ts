type StopBridge = { stopChat: (chatId: string) => Promise<{ stopped: boolean }> };

let installed = false;
let promptObserver: MutationObserver | null = null;
let messagesObserver: MutationObserver | null = null;
let domObserver: MutationObserver | null = null;

function stopBridge(): StopBridge {
  return (window as unknown as { autoCodez: StopBridge }).autoCodez;
}

function syncStopButton(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;

  const approvalVisible = Boolean(document.querySelector('[data-approve], [data-deny]'));
  const stopping = prompt.disabled && !approvalVisible;
  button.classList.toggle('is-stop', stopping);
  button.title = stopping ? 'Parar' : 'Enviar';
  button.setAttribute('aria-label', stopping ? 'Parar' : 'Enviar');
  if (stopping) button.disabled = false;
}

function selectedChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function disconnectObservers(): void {
  promptObserver?.disconnect();
  messagesObserver?.disconnect();
  domObserver?.disconnect();
  promptObserver = null;
  messagesObserver = null;
  domObserver = null;
}

function installWhenReady(): void {
  if (installed) return;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!prompt || !button || !messages) return;

  installed = true;
  disconnectObservers();

  promptObserver = new MutationObserver(syncStopButton);
  promptObserver.observe(prompt, { attributes: true, attributeFilter: ['disabled'] });

  messagesObserver = new MutationObserver(syncStopButton);
  messagesObserver.observe(messages, { childList: true, subtree: true });

  button.addEventListener('click', (event) => {
    if (!button.classList.contains('is-stop')) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const chatId = selectedChatId();
    if (!chatId) {
      syncStopButton();
      return;
    }

    prompt.disabled = false;
    prompt.focus();
    void stopBridge().stopChat(chatId).catch((): void => undefined);
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
