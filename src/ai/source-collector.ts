import type { AIMessage, AISource } from './types';
import { mergeAISources } from './source-normalization';

const WEB_CONTEXT_PREFIX = 'Contexto Web atual recuperado pelo Auto CodeZ';

type SearchToolPayload = {
  type?: string;
  searchProvider?: string;
  retrievedAt?: number;
  sources?: Array<{ id?: number; title?: string; url?: string; snippet?: string }>;
};

type FetchToolPayload = {
  type?: string;
  source?: { title?: string; url?: string; retrievedAt?: number };
};

function groundingSources(content: string): AISource[] {
  if (!content.startsWith(WEB_CONTEXT_PREFIX)) return [];
  const sources: AISource[] = [];
  const blocks = content.split(/\n(?=\[\d+\]\s)/g);
  for (const block of blocks) {
    const heading = /^\[(\d+)\]\s+(.+)$/m.exec(block);
    const url = /^URL:\s*(\S+)$/m.exec(block)?.[1];
    if (!heading || !url) continue;
    const snippet = /^Snippet:\s*(.+)$/m.exec(block)?.[1];
    sources.push({
      title: heading[2].trim(),
      url,
      origin: 'autocodez-web',
      citation: Number(heading[1]),
      ...(snippet ? { snippet: snippet.trim() } : {}),
    });
  }
  return sources;
}

function toolSources(message: AIMessage): AISource[] {
  if (message.role !== 'tool' || (message.toolName !== 'web_search' && message.toolName !== 'web_fetch')) return [];
  try {
    const payload = JSON.parse(message.content) as SearchToolPayload & FetchToolPayload;
    if (message.toolName === 'web_search' && payload.type === 'web_search_results' && Array.isArray(payload.sources)) {
      return payload.sources.flatMap((source): AISource[] => {
        if (typeof source.url !== 'string' || !source.url.trim()) return [];
        return [{
          title: typeof source.title === 'string' && source.title.trim() ? source.title : source.url,
          url: source.url,
          origin: 'autocodez-web',
          ...(Number.isInteger(source.id) && Number(source.id) > 0 ? { citation: Number(source.id) } : {}),
          ...(typeof source.snippet === 'string' && source.snippet.trim() ? { snippet: source.snippet } : {}),
          ...(typeof payload.retrievedAt === 'number' ? { retrievedAt: payload.retrievedAt } : {}),
          ...(typeof payload.searchProvider === 'string' && payload.searchProvider.trim() ? { searchProvider: payload.searchProvider } : {}),
        }];
      });
    }
    if (message.toolName === 'web_fetch' && payload.type === 'web_document' && payload.source?.url) {
      return [{
        title: payload.source.title || payload.source.url,
        url: payload.source.url,
        origin: 'autocodez-web',
        ...(typeof payload.source.retrievedAt === 'number' ? { retrievedAt: payload.source.retrievedAt } : {}),
      }];
    }
  } catch {
  }
  return [];
}

export function collectRequestSources(messages: AIMessage[]): AISource[] {
  const groups = messages.flatMap((message) => [
    ...(message.role === 'system' ? groundingSources(message.content) : []),
    ...toolSources(message),
    ...(message.sources ?? []),
  ]);
  return mergeAISources(groups);
}
