function simplifyProviderError(message: string): string {
  const normalized = message.toLowerCase();

  if (/não há créditos|sem créditos|no credits|insufficient funds|billing|faturamento|payment required|spending limit/.test(normalized)) {
    return 'Sua API Key está sem créditos ou sem faturamento disponível. Adicione créditos ou troque de API Key para continuar.';
  }

  if (/cota disponível|quota|resource exhausted|free tier/.test(normalized)) {
    return 'A cota disponível desta API Key ou deste modelo foi atingida. Aguarde, adicione créditos ou troque de API Key ou modelo para continuar.';
  }

  if (/limite de requisições|rate limit|rate_limit|too many requests/.test(normalized)) {
    return 'O limite de requisições da API foi atingido. Aguarde um pouco e tente novamente.';
  }

  if (/api key foi recusada|invalid api key|invalid key|authentication|unauthorized|forbidden/.test(normalized)) {
    return 'A API Key foi recusada pelo provedor. Verifique a chave ou selecione outra em Configurações de IA.';
  }

  if (/não foi possível alcançar|network|fetch failed|timed out|timeout|socket|econn|enotfound|dns/.test(normalized)) {
    return 'Não foi possível conectar ao provedor de IA. Verifique sua conexão e tente novamente.';
  }

  if (/erro temporário|service unavailable|temporarily unavailable|server unavailable/.test(normalized)) {
    return 'O provedor de IA está com uma falha temporária. Tente novamente em alguns instantes.';
  }

  return message;
}

type VisibleProviderError = {
  chatId?: string;
  message: string;
};

let visibleError: VisibleProviderError | null = null;
let renderScheduled = false;

function activeChatId(): string | undefined {
  return document.querySelector<HTMLElement>('.chat-item.selected')?.dataset.chat;
}

function ensureVisibleError(): void {
  renderScheduled = false;
  if (!visibleError) return;
  if (visibleError.chatId && activeChatId() !== visibleError.chatId) return;

  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages || messages.querySelector('[data-auto-codez-provider-error="true"]')) return;

  const article = document.createElement('article');
  article.className = 'message assistant auto-codez-provider-error';
  article.dataset.autoCodezProviderError = 'true';

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = 'Auto CodeZ';

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = visibleError.message;

  article.append(label, content);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  window.setTimeout(ensureVisibleError, 0);
}

window.autoCodez.onStreamEvent((event) => {
  if (event.type === 'start') {
    visibleError = null;
    document.querySelector('[data-auto-codez-provider-error="true"]')?.remove();
    return;
  }

  if (event.type !== 'error' || !event.error) return;
  visibleError = {
    chatId: event.chatId,
    message: simplifyProviderError(event.error),
  };
  scheduleRender();
});

const observer = new MutationObserver(() => {
  if (visibleError) scheduleRender();
});

observer.observe(document.body, { childList: true, subtree: true });
