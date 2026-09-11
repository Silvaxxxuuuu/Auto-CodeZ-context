import { extractReadableWebContent } from './web-content';
import { requestPublicText, type PublicTextRequestOptions } from './web-http-client';
import { assertSafeWebUrlText, normalizeWebSearchQuery } from './web-query-policy';
import { DuckDuckGoHtmlSearchAdapter } from './search/duckduckgo-html';
import type { WebFetchedDocument, WebSearchAdapter, WebSearchOptions, WebSearchResult } from './web-types';

export type WebRetrievalRuntimeOptions = {
  searchAdapter?: WebSearchAdapter;
  requestOptions?: Pick<PublicTextRequestOptions, 'resolver' | 'transport'>;
  now?: () => number;
};

export class WebRetrievalRuntime {
  readonly searchAdapter: WebSearchAdapter;
  private readonly requestOptions: Pick<PublicTextRequestOptions, 'resolver' | 'transport'>;
  private readonly now: () => number;

  constructor(options: WebRetrievalRuntimeOptions = {}) {
    this.requestOptions = options.requestOptions ?? {};
    this.searchAdapter = options.searchAdapter ?? new DuckDuckGoHtmlSearchAdapter(this.requestOptions);
    this.now = options.now ?? Date.now;
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const normalized = normalizeWebSearchQuery(query);
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 1), 10);
    return await this.searchAdapter.search(normalized, { ...options, limit });
  }

  async fetch(url: string, signal?: AbortSignal): Promise<WebFetchedDocument> {
    const safeUrl = assertSafeWebUrlText(url);
    const response = await requestPublicText(safeUrl, {
      ...this.requestOptions,
      signal,
      timeoutMs: 15_000,
      maxBytes: 1024 * 1024,
      maxRedirects: 5,
    });
    const extracted = extractReadableWebContent(response.text, response.contentType);
    if (!extracted.text) throw new Error('A fonte web não contém texto utilizável.');
    return {
      url: response.url,
      ...(extracted.title ? { title: extracted.title } : {}),
      text: extracted.text,
      contentType: response.contentType,
      retrievedAt: this.now(),
    };
  }
}
