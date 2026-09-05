const EMPTY_STATE_HTML = `
  <div class="ac-empty-chat" role="status" aria-live="polite">
    <div class="ac-empty-chat-icon" aria-hidden="true"></div>
    <h2>Abra um chat</h2>
    <p>Selecione uma conversa na barra lateral ou crie um novo chat para começar.</p>
  </div>
`;

const style = document.createElement('style');
style.textContent = `
.composer-wrap.ac-empty-chat-hidden{display:none!important}
`;
document.head.appendChild(style);

function syncEmptyState(): void {
  const messages = document.querySelector<HTMLElement>('#messages');
  const composer = document.querySelector<HTMLElement>('.composer-wrap');
  if (!messages) return;

  const welcome = messages.querySelector<HTMLElement>(':scope > .welcome');
  if (welcome) welcome.outerHTML = EMPTY_STATE_HTML;

  const empty = Boolean(messages.querySelector(':scope > .ac-empty-chat'));
  composer?.classList.toggle('ac-empty-chat-hidden', empty);
}

function initialize(): void {
  syncEmptyState();
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;

  const observer = new MutationObserver(syncEmptyState);
  observer.observe(messages, { childList: true });

  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
