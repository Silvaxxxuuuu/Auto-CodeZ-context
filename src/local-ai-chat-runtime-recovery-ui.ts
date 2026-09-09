const ROOT_SELECTOR = '#chat-local-model-state';
const AI_SELECTOR = '#chat-available-ai';
const MODEL_SELECTOR = '#chat-model';
const RECOVERY_MARKER = 'data-local-runtime-recovery';

function runtimeCopy(providerId: string): { title: string; detail: string } {
  if (providerId === 'lm-studio') {
    return {
      title: 'LM Studio precisa estar com o servidor local ativo',
      detail: 'Abra o LM Studio, ative o servidor na área Developer e depois tente novamente. Assim que o servidor responder, o Auto CodeZ poderá baixar o modelo selecionado e acompanhar o progresso.',
    };
  }
  if (providerId === 'ollama') {
    return {
      title: 'Ollama precisa estar ativo',
      detail: 'Inicie o Ollama e depois tente novamente. Assim que o serviço local responder, o Auto CodeZ poderá baixar o modelo selecionado e acompanhar o progresso.',
    };
  }
  return {
    title: 'Runtime local precisa estar ativo',
    detail: 'Inicie o runtime local e tente novamente para liberar a instalação do modelo selecionado.',
  };
}

function enhanceUnavailableRuntime(): void {
  const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
  const ai = document.querySelector<HTMLSelectElement>(AI_SELECTOR);
  const model = document.querySelector<HTMLSelectElement>(MODEL_SELECTOR);
  if (!root || !ai || !model) return;
  if (!ai.value.startsWith('provider:')) return;
  if (!/não está respondendo/i.test(root.textContent || '')) return;
  if (root.hasAttribute(RECOVERY_MARKER)) return;

  const providerId = ai.value.slice('provider:'.length);
  const copy = runtimeCopy(providerId);
  const hasModel = Boolean(model.value);
  root.setAttribute(RECOVERY_MARKER, 'true');
  root.innerHTML = `
    <div class="chat-local-notice warning">
      <strong>${copy.title}</strong>
      <span>${copy.detail}</span>
      <div class="chat-local-actions">
        <button class="chat-local-button" type="button" data-local-runtime-retry> Tentar novamente </button>
      </div>
    </div>
    ${hasModel ? `<div class="chat-local-install"><div class="chat-local-install-copy"><strong>${model.selectedOptions[0]?.textContent || 'Modelo selecionado'}</strong><span>O download será liberado assim que o runtime responder.</span></div><button class="chat-local-button primary" type="button" disabled>Instalar modelo</button></div>` : ''}
  `;
}

let scheduled = false;
function scheduleEnhancement(): void {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    enhanceUnavailableRuntime();
  }, 0);
}

const observer = new MutationObserver(scheduleEnhancement);
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('[data-local-runtime-retry]')) return;
  event.preventDefault();
  const ai = document.querySelector<HTMLSelectElement>(AI_SELECTOR);
  if (!ai) return;
  ai.dispatchEvent(new Event('change', { bubbles: true }));
});

window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
scheduleEnhancement();
