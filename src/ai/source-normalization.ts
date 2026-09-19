import { requirePublicExternalUrl } from '../core/external-url-policy';
import type { AISource, AISourceOrigin } from './types';

const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 1200;
const MAX_PROVIDER_LENGTH = 120;

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function safePublicUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(requirePublicExternalUrl(value));
  } catch {
    return undefined;
  }
}

function sourceOrigin(value: unknown): AISourceOrigin | undefined {
  if (value === 'autocodez-web' || value === 'provider-native') return value;
  return undefined;
}

export function normalizeAISource(value: unknown): AISource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AISource>;
  const url = safePublicUrl(candidate.url);
  const origin = sourceOrigin(candidate.origin);
  if (!url || !origin) return undefined;
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
    origin,
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
