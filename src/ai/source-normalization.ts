import type { AISource, AISourceOrigin } from './types';

const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 1200;
const MAX_PROVIDER_LENGTH = 120;

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function safePublicUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password || isPrivateHostname(url.hostname)) return undefined;
    url.hash = '';
    return url;
  } catch {
    return undefined;
  }
}

function sourceOrigin(value: unknown): AISourceOrigin {
  return value === 'provider-native' ? 'provider-native' : 'autocodez-web';
}

export function normalizeAISource(value: unknown): AISource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AISource>;
  const url = safePublicUrl(candidate.url);
  if (!url) return undefined;
  const title = boundedText(candidate.title, MAX_TITLE_LENGTH) || url.hostname;
  const snippet = boundedText(candidate.snippet, MAX_SNIPPET_LENGTH);
  const providerId = boundedText(candidate.providerId, MAX_PROVIDER_LENGTH);
  const searchProvider = boundedText(candidate.searchProvider, MAX_PROVIDER_LENGTH);
  const citation = Number.isInteger(candidate.citation) && Number(candidate.citation) > 0 && Number(candidate.citation) <= 999
    ? Number(candidate.citation)
    : undefined;
  const retrievedAt = typeof candidate.retrievedAt === 'number' && Number.isFinite(candidate.retrievedAt) && candidate.retrievedAt >= 0
    ? candidate.retrievedAt
    : undefined;
  return {
    title,
    url: url.toString(),
    origin: sourceOrigin(candidate.origin),
    ...(citation === undefined ? {} : { citation }),
    ...(snippet ? { snippet } : {}),
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
    ...(providerId ? { providerId } : {}),
    ...(searchProvider ? { searchProvider } : {}),
  };
}

export function mergeAISources(...groups: Array<ReadonlyArray<AISource> | undefined>): AISource[] {
  const byUrl = new Map<string, AISource>();
  for (const group of groups) {
    if (!group) continue;
    for (const candidate of group) {
      const source = normalizeAISource(candidate);
      if (!source) continue;
      const existing = byUrl.get(source.url);
      if (!existing) {
        byUrl.set(source.url, source);
        continue;
      }
      byUrl.set(source.url, {
        ...existing,
        title: existing.title.length >= source.title.length ? existing.title : source.title,
        ...(existing.snippet || !source.snippet ? {} : { snippet: source.snippet }),
        ...(existing.retrievedAt !== undefined || source.retrievedAt === undefined ? {} : { retrievedAt: source.retrievedAt }),
        ...(existing.providerId || !source.providerId ? {} : { providerId: source.providerId }),
        ...(existing.searchProvider || !source.searchProvider ? {} : { searchProvider: source.searchProvider }),
        ...(existing.citation !== undefined || source.citation === undefined ? {} : { citation: source.citation }),
      });
    }
  }
  return [...byUrl.values()];
}

export function sourcesFromMessages(messages: ReadonlyArray<{ sources?: AISource[] }>): AISource[] {
  return mergeAISources(...messages.map((message) => message.sources));
}
