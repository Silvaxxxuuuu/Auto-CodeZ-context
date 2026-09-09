import { requestPublicText, type PublicTextRequestOptions } from '../web-http-client';
import { stripWebHtmlFragment } from '../web-content';
import { normalizeWebSearchQuery } from '../web-query-policy';
import type { WebSearchAdapter, WebSearchOptions, WebSearchResult } from '../web-types';

export type DuckDuckGoHtmlSearchOptions = Pick<PublicTextRequestOptions, 'resolver' | 'transport'>;

function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  return pattern.exec(tag)?.[2];
}

function decodeResultUrl(href: string): string | undefined {
  try {
    const candidate = href.startsWith('//') ? `https:${href}` : href;
    const url = new URL(candidate, 'https://html.duckduckgo.com/');
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (!target) return undefined;
      const decoded = new URL(target);
      return decoded.protocol === 'http:' || decoded.protocol === 'https:' ? decoded.toString() : undefined;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function snippetAfter(html: string, endIndex: number): string | undefined {
  const tail = html.slice(endIndex, endIndex + 2400);
  const match = /<(?:a|div|span)[^>]*class\s*=\s*(["'])[^"']*result__snippet[^"']*\1[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(tail);
  const value = match ? stripWebHtmlFragment(match[2]) : '';
  return value || undefined;
}

export function parseDuckDuckGoHtml(html: string, limit = 6): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    const className = attribute(tag, 'class') || '';
    if (!className.split(/\s+/).includes('result__a')) continue;
    const href = attribute(tag, 'href');
    if (!href) continue;
    const url = decodeResultUrl(href);
    if (!url || seen.has(url)) continue;
    const title = stripWebHtmlFragment(match[0]);
    if (!title) continue;
    seen.add(url);
    const snippet = snippetAfter(html, anchorPattern.lastIndex);
    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return results;
}

export class DuckDuckGoHtmlSearchAdapter implements WebSearchAdapter {
  readonly id = 'duckduckgo-html';
  readonly displayName = 'DuckDuckGo';

  constructor(private readonly requestOptions: DuckDuckGoHtmlSearchOptions = {}) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const normalized = normalizeWebSearchQuery(query);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 1), 10);
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', normalized);
    const response = await requestPublicText(url, {
      ...this.requestOptions,
      signal: options.signal,
      timeoutMs: 15_000,
      maxBytes: 768 * 1024,
      maxRedirects: 3,
    });
    const results = parseDuckDuckGoHtml(response.text, limit);
    if (!results.length) throw new Error('A busca web não retornou resultados utilizáveis.');
    return results;
  }
}
