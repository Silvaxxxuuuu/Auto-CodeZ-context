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
    const url = new URL(candidate, 'https://duckduckgo.com/');
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

function appendResult(results: WebSearchResult[], seen: Set<string>, title: string, href: string, snippet?: string): void {
  const url = decodeResultUrl(href);
  const normalizedTitle = stripWebHtmlFragment(title);
  if (!url || !normalizedTitle || seen.has(url)) return;
  seen.add(url);
  results.push({ title: normalizedTitle, url, ...(snippet ? { snippet } : {}) });
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
    appendResult(results, seen, match[0], href, snippetAfter(html, anchorPattern.lastIndex));
  }
  return results;
}

export function parseDuckDuckGoLite(html: string, limit = 6): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    const className = attribute(tag, 'class') || '';
    if (!className.split(/\s+/).includes('result-link')) continue;
    const href = attribute(tag, 'href');
    if (!href) continue;
    const tail = html.slice(anchorPattern.lastIndex, anchorPattern.lastIndex + 1800);
    const snippetMatch = /<td\b[^>]*class\s*=\s*(["'])result-snippet\1[^>]*>([\s\S]*?)<\/td>/i.exec(tail);
    const snippet = snippetMatch ? stripWebHtmlFragment(snippetMatch[2]) || undefined : undefined;
    appendResult(results, seen, match[0], href, snippet);
  }
  return results;
}

export class DuckDuckGoHtmlSearchAdapter implements WebSearchAdapter {
  readonly id = 'duckduckgo-html';
  readonly displayName = 'DuckDuckGo';

  constructor(private readonly requestOptions: DuckDuckGoHtmlSearchOptions = {}) {}

  private request(url: URL, signal?: AbortSignal) {
    return requestPublicText(url, {
      ...this.requestOptions,
      signal,
      timeoutMs: 15_000,
      maxBytes: 768 * 1024,
      maxRedirects: 3,
    });
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const normalized = normalizeWebSearchQuery(query);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 1), 10);
    const primary = new URL('https://html.duckduckgo.com/html/');
    primary.searchParams.set('q', normalized);
    try {
      const response = await this.request(primary, options.signal);
      const results = parseDuckDuckGoHtml(response.text, limit);
      if (results.length) return results;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
    }

    const fallback = new URL('https://lite.duckduckgo.com/lite/');
    fallback.searchParams.set('q', normalized);
    const response = await this.request(fallback, options.signal);
    const results = parseDuckDuckGoLite(response.text, limit);
    if (!results.length) throw new Error('A busca web não retornou resultados utilizáveis nos mecanismos disponíveis.');
    return results;
  }
}
