type RenameApi = {
  getState: () => Promise<{ chats: Array<{ id: string; title: string }> }>;
  renameChat: (input: { chatId: string; title: string }) => Promise<{ id: string; title: string }>;
};

const bridge = window.autoCodez as unknown as RenameApi;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

async function renameChat(chatId: string, currentTitle: string, item: HTMLElement): Promise<void> {
  const copy = item.querySelector<HTMLElement>('.chat-item-copy');
  if (!copy) return;

  const input = document.createElement('input');
  input.className = 'chat-rename-input';
  input.type = 'text';
  input.value = currentTitle;
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Novo nome do chat');

  copy.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    if (!save) {
      copy.innerHTML = `<span>${escapeHtml(currentTitle)}</span>`;
      return;
    }
    const title = input.value.trim().replace(/\s+/g, ' ');
    if (!title || title === currentTitle) {
      copy.innerHTML = `<span>${escapeHtml(currentTitle)}</span>`;
      return;
    }
    try {
      const updated = await bridge.renameChat({ chatId, title });
      copy.innerHTML = `<span>${escapeHtml(updated.title)}</span><small>${escapeHtml((await bridge.getState()).chats.find((chat) => chat.id === chatId)?.title ? '' : '')}</small>`;
      const headerTitle = document.querySelector<HTMLElement>('.chat-header h1');
      const activeItem = document.querySelector<HTMLElement>(`.chat-item[data-chat="${CSS.escape(chatId)}"]`);
      if (activeItem) {
        const activeCopy = activeItem.querySelector<HTMLElement>('.chat-item-copy > span:first-child');
        if (activeCopy) activeCopy.textContent = updated.title;
      }
      if (headerTitle) headerTitle.textContent = updated.title;
      const state = await bridge.getState();
      const provider = state.chats.find((chat) => chat.id === chatId);
      if (provider) {
        const small = copy.querySelector('small');
        if (small) small.textContent = '';
      }
    } catch (error) {
      copy.innerHTML = `<span>${escapeHtml(currentTitle)}</span>`;
      window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível renomear o chat.' }));
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
  });
  input.addEventListener('blur', () => { void finish(true); });
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>('[data-chat-settings]');
  if (!button || button.hasAttribute('data-chat-settings-gear')) return;
  const item = button.closest<HTMLElement>('.chat-item');
  if (!item) return;
  const chatId = button.dataset.chatSettings;
  const title = item.querySelector<HTMLElement>('.chat-item-copy > span:first-child')?.textContent?.trim();
  if (!chatId || !title) return;
  event.preventDefault();
  event.stopPropagation();
  void renameChat(chatId, title, item);
}, true);
