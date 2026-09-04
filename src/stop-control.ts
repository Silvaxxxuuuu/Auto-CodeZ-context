declare global {
  interface Window {
    autoCodez: {
      stopChat: (chatId: string) => Promise<{ stopped: boolean }>;
    };
  }
}

function syncStopButton(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;
  const approvalVisible = Boolean(document.querySelector('[data-approve], [data-deny]'));
  const stopping = prompt.disabled && !approvalVisible;
  button.classList.toggle('is-stop', stopping);
  if (stopping) {
    button.disabled = false;
    button.title = 'Parar';
    button.setAttribute('aria-label', 'Parar');
  } else {
    button.title = 'Enviar';
    button.setAttribute('aria-label', 'Enviar');
  }
}

function selectedChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function install(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const button = document.querySelector<HTMLButtonElement>('#send-button');
  if (!prompt || !button) return;

  const observer = new MutationObserver(syncStopButton);
  observer.observe(prompt, { attributes: true, attributeFilter: ['disabled'] });

  button.addEventListener('click', (event) => {
    if (!button.classList.contains('is-stop')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const chatId = selectedChatId();
    if (chatId) void window.autoCodez.stopChat(chatId).catch(() => undefined);
  }, true);

  syncStopButton();
}

install();
