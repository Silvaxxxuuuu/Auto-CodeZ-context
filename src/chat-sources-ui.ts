import './chat-sources-ui.css';

type Source = {
  title: string;
  url: string;
  origin: 'autocodez-web' | 'provider-native';
  citation?: number;
  searchProvider?: string;
};

type StoredMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  sources?: Source[];
};

type StoredChat = {
  id: string;
  messages: StoredMessage[];
};

type SourceBridge = {
  getState: () => Promise<{ chats: StoredChat[] }>;
  openExternal: (url: string) => Promise<unknown>;
};

const bridge = (window as unknown as { autoCodez: SourceBridge }).autoCodez;
const messagesRoot = document.querySelector<HTMLElement>('#messages');
let renderTimer: number | undefined;
let revision = 0;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function safeSource(value: Source): Source | undefined {
  try {
    const url = new URL(value.url);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined;
    url.hash = '';
    const title = typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    if (!title) return undefined;
    return {
      title,
      url: url.toString(),
      origin: value.origin === 'provider-native' ? 'provider-native' : 'autocodez-web',
      ...(Number.isInteger(value.citation) && Number(value.citation) > 0 ? { citation: Number(value.citation) } : {}),
      ...(typeof value.searchProvider === 'string' && value.searchProvider.trim() ? { searchProvider: value.searchProvider.trim().slice(0, 120) } : {}),
    };
  } catch {
    return undefined;
  }
}

function sourceLabel(source: Source): string {
  if (source.origin === 'provider-native') return 'Fonte do provider';
  return source.searchProvider || 'Web Auto CodeZ';
}

function renderSources(sources: Source[]): string {
  const safe = sources.flatMap((source) => {
    const normalized = safeSource(source);
    return normalized ? [normalized] : [];
  });
  if (!safe.length) return '';
  const unique = [...new Map(safe.map((source) => [source.url, source])).values()];
  return `<div class="message-sources" data-auto-codez-sources="${escapeHtml(unique.map((source) => source.url).join('|'))}">
    <div class="message-sources-head"><span>Fontes</span><span class="message-sources-count">${unique.length} verificada${unique.length === 1 ? '' : 's'}</span></div>
    <div class="message-sources-list">${unique.map((source, index) => {
      const hostname = new URL(source.url).hostname.replace(/^www\./, '');
      const citation = source.citation ?? index + 1;
      return `<button class="message-source" type="button" data-auto-codez-source-url="${encodeURIComponent(source.url)}" title="Abrir ${escapeHtml(source.title)}">
        <span class="message-source-number">${citation}</span>
        <span class="message-source-copy"><span class="message-source-title">${escapeHtml(source.title)}</span><span class="message-source-meta">${escapeHtml(hostname)} · ${escapeHtml(sourceLabel(source))}</span></span>
        <span class="message-source-open" aria-hidden="true">↗</span>
      </button>`;
    }).join('')}</div>
  </div>`;
}

async function syncSources(): Promise<void> {
  if (!messagesRoot || !bridge?.getState) return;
  const selected = document.querySelector<HTMLElement>('.chat-item.selected[data-chat]');
  const chatId = selected?.dataset.chat;
  if (!chatId) return;
  const currentRevision = ++revision;
  try {
    const state = await bridge.getState();
    if (currentRevision !== revision) return;
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
    const articles = Array.from(messagesRoot.querySelectorAll<HTMLElement>(':scope > article.message:not(.streaming)'));
    for (let index = 0; index < Math.min(articles.length, chat.messages.length); index += 1) {
      const article = articles[index];
      const message = chat.messages[index];
      const existing = article.querySelector<HTMLElement>(':scope > .message-sources');
      if (message.role !== 'assistant' || !message.sources?.length) {
        existing?.remove();
        continue;
      }
      const markup = renderSources(message.sources);
      if (!markup) {
        existing?.remove();
        continue;
      }
      const marker = /data-auto-codez-sources="([^"]*)"/.exec(markup)?.[1] || '';
      if (existing?.dataset.autoCodezSources === marker) continue;
      existing?.remove();
      article.insertAdjacentHTML('beforeend', markup);
    }
  } catch (error) {
    window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível renderizar as fontes.' }));
  }
}

function scheduleSync(): void {
  if (renderTimer !== undefined) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;
    void syncSources();
  }, 45);
}

if (messagesRoot) {
  const observer = new MutationObserver(scheduleSync);
  observer.observe(messagesRoot, { childList: true, subtree: true });
  messagesRoot.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-auto-codez-source-url]');
    const encodedUrl = target?.dataset.autoCodezSourceUrl;
    if (!encodedUrl) return;
    event.preventDefault();
    try {
      const url = decodeURIComponent(encodedUrl);
      void bridge.openExternal(url).catch((error: unknown) => {
        window.dispatchEvent(new CustomEvent('auto-codez-ui-error', { detail: error instanceof Error ? error.message : 'Não foi possível abrir a fonte.' }));
      });
    } catch {
    }
  });
  document.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-chat], [data-panel]')) scheduleSync();
  });
  scheduleSync();
}
