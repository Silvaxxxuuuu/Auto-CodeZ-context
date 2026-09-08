type LocalModel = { id: string; name: string; capabilities: string[]; contextWindow?: number };
type LocalProvider = { id: string; displayName: string; configured: boolean; apiKeyConfigured: boolean; requiresApiKey?: boolean };
type LocalAiBridge = {
  getState: () => Promise<{ providers: LocalProvider[] }>;
  listModels: (providerId: string) => Promise<LocalModel[]>;
};

const bridge = (window as unknown as { autoCodez?: LocalAiBridge }).autoCodez;
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
let renderToken = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function badge(value: string, tone = '', extra = ''): string {
  return `<span class="settings-value-badge${tone ? ` ${tone}` : ''}"${extra}>${escapeHtml(value)}</span>`;
}

function row(label: string, description: string, control: string): string {
  return `<div class="settings-row"><div class="settings-row-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(description)}</span></div><div class="settings-row-value">${control}</div></div>`;
}

function actionButton(label: string): string {
  return `<button class="settings-action-button" type="button" data-local-ai-action="retry">${escapeHtml(label)}</button>`;
}

function localAiIcon(): string {
  return '<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M12 2v3M15 2v3M9 19v3M12 19v3M15 19v3M2 9h3M2 12h3M2 15h3M19 9h3M19 12h3M19 15h3"/><circle cx="12" cy="12" r="2"/></svg>';
}

function installLocalAiNavigation(): void {
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const nav = overlay?.querySelector<HTMLElement>('.settings-nav');
  if (!overlay || !nav || nav.querySelector('[data-local-ai-settings]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'settings-nav-item';
  button.dataset.localAiSettings = '';
  button.innerHTML = `<span class="settings-nav-icon">${localAiIcon()}</span><span><strong>IA Local</strong><small>Ollama e modelos locais</small></span>`;
  const aiButton = nav.querySelector<HTMLElement>('[data-settings-section="ai"]');
  if (aiButton) aiButton.insertAdjacentElement('afterend', button);
  else nav.appendChild(button);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    nav.querySelectorAll('.settings-nav-item').forEach((item) => item.classList.toggle('active', item === button));
    void renderLocalAi();
  });
}

function capabilityCount(models: LocalModel[], capability: string): number {
  return models.filter((model) => model.capabilities.includes(capability)).length;
}

async function renderLocalAi(): Promise<void> {
  const token = ++renderToken;
  const overlay = document.querySelector<HTMLElement>('.settings-overlay');
  const body = overlay?.querySelector<HTMLElement>('.settings-body');
  const localButton = overlay?.querySelector<HTMLElement>('[data-local-ai-settings]');
  if (!overlay || !body || !localButton?.classList.contains('active')) return;

  body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Modelos executados no seu computador sem enviar prompts para um provider cloud.</p></header><section class="settings-card"><div class="settings-loading">Verificando Ollama…</div></section>';

  try {
    if (!bridge?.getState || !bridge.listModels) throw new Error('Infraestrutura de IA local indisponível.');
    const state = await bridge.getState();
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    const ollama = state.providers.find((provider) => provider.id === 'ollama');
    if (!ollama || ollama.requiresApiKey !== false) throw new Error('O provider local Ollama não está disponível no runtime atual.');

    const models = await bridge.listModels('ollama');
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    const names = models.slice(0, 5).map((model) => model.name || model.id).join(', ');
    const remaining = Math.max(0, models.length - 5);
    const modelDescription = models.length
      ? `${names}${remaining ? ` e mais ${remaining}` : ''}.`
      : 'O serviço respondeu, mas nenhum modelo de geração de texto foi encontrado.';
    const card = `<section class="settings-card" data-local-ai-status="connected">${[
      row('Ollama', 'Runtime local detectado e respondendo ao Auto CodeZ.', badge('Conectado', 'good')),
      row('Endpoint', 'Endpoint local padrão usado pelo provider nativo.', badge(DEFAULT_ENDPOINT)),
      row('Modelos instalados', modelDescription, badge(String(models.length))),
      row('Ferramentas', 'Modelos que declararam suporte nativo a tool calling em /api/show.', badge(`${capabilityCount(models, 'tools')}/${models.length}`)),
      row('Raciocínio', 'Modelos que declararam capability thinking. O trace interno não é exibido no chat.', badge(`${capabilityCount(models, 'reasoning')}/${models.length}`)),
      row('Visão', 'Modelos locais que declararam entrada de imagem.', badge(`${capabilityCount(models, 'vision')}/${models.length}`)),
      row('Conexão', 'Refaz a descoberta de modelos e capacidades sem reiniciar o aplicativo.', actionButton('Testar novamente')),
    ].join('')}</section>`;
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Modelos executados no seu computador sem enviar prompts para um provider cloud.</p></header>' + card + '<div class="settings-footnote">Capacidades são lidas do próprio Ollama por /api/tags e /api/show. Modelos sem suporte declarado a tools não recebem ferramentas do agente.</div>';
  } catch (error) {
    if (token !== renderToken || !localButton.isConnected || !localButton.classList.contains('active')) return;
    const message = error instanceof Error ? error.message : 'O Ollama não respondeu.';
    const card = `<section class="settings-card" data-local-ai-status="offline">${[
      row('Ollama', 'O serviço local não respondeu neste computador.', badge('Não detectado', 'locked')),
      row('Endpoint', 'O Auto CodeZ procura o Ollama no endpoint local padrão.', badge(DEFAULT_ENDPOINT)),
      row('Modelos instalados', 'A lista ficará disponível assim que o serviço local responder.', badge('Indisponível', 'locked')),
      row('Conexão', 'Tente novamente depois de iniciar o Ollama.', actionButton('Testar novamente')),
    ].join('')}</section>`;
    body.innerHTML = '<header class="settings-section-header"><div class="settings-eyebrow">LOCAL</div><h2>IA Local</h2><p>Modelos executados no seu computador sem enviar prompts para um provider cloud.</p></header>' + card + `<div class="settings-footnote">${escapeHtml(message)} O Auto CodeZ não instala nem inicia o Ollama silenciosamente.</div>`;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('[data-settings-section]')) {
    document.querySelector<HTMLElement>('[data-local-ai-settings]')?.classList.remove('active');
    return;
  }
  if (target.closest('[data-local-ai-action="retry"]')) void renderLocalAi();
}, true);

const observer = new MutationObserver(() => installLocalAiNavigation());
observer.observe(document.body, { childList: true, subtree: true });
installLocalAiNavigation();
