const EMPTY_STATE_HTML = `
  <div class="ac-empty-chat" role="status" aria-live="polite">
    <div class="ac-empty-chat-icon" aria-hidden="true"></div>
    <h2>Abra um chat</h2>
    <p>Selecione uma conversa na barra lateral ou crie um novo chat para começar.</p>
  </div>
`;

function syncEmptyState(): void {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  const welcome = messages.querySelector<HTMLElement>('.welcome');
  if (welcome) welcome.outerHTML = EMPTY_STATE_HTML;
}

function initialize(): void {
  syncEmptyState();
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  const observer = new MutationObserver(syncEmptyState);
  observer.observe(messages, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
