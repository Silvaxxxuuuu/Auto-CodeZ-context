export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type WebSearchOptions = {
  limit?: number;
  signal?: AbortSignal;
};

export type WebFetchedDocument = {
  url: string;
  title?: string;
  text: string;
  contentType: string;
  retrievedAt: number;
};

export interface WebSearchAdapter {
  readonly id: string;
  readonly displayName: string;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}
