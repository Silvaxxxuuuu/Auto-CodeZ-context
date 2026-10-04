import type { AIAttachment } from '../../types';
import { isNativeImageMediaType } from '../../provider-attachments';
import type { AttachmentStore } from '../../attachment-store';
import type { ReverseImageSearchProvider, ReverseImageSearchResult } from '../visual-grounding-types';

type GoogleVisionWebDetection = {
  bestGuessLabels?: Array<{ label?: string }>;
  webEntities?: Array<{ description?: string; score?: number }>;
  pagesWithMatchingImages?: Array<{ url?: string; pageTitle?: string; score?: number }>;
  fullMatchingImages?: Array<{ url?: string }>;
  partialMatchingImages?: Array<{ url?: string }>;
  visuallySimilarImages?: Array<{ url?: string }>;
};

type GoogleVisionResponse = {
  responses?: Array<{
    error?: { message?: string };
    webDetection?: GoogleVisionWebDetection;
  }>;
};

export type GoogleVisionWebProviderOptions = {
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

function urls(values: Array<{ url?: string }> | undefined): string[] {
  return (values ?? []).flatMap((value) => typeof value.url === 'string' && /^https?:\/\//i.test(value.url) ? [value.url] : []);
}

export class GoogleVisionWebProvider implements ReverseImageSearchProvider {
  readonly id = 'google-vision-web';
  readonly displayName = 'Google Cloud Vision Web Detection';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: AttachmentStore,
    options: GoogleVisionWebProviderOptions = {},
  ) {
    this.apiKey = options.apiKey?.trim() ?? '';
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 6_000, 1_000), 20_000);
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async search(attachment: AIAttachment, signal?: AbortSignal): Promise<ReverseImageSearchResult> {
    if (!this.available()) throw new Error('Google Vision Web Detection não está configurado.');
    if (attachment.kind !== 'image' || !isNativeImageMediaType(attachment.mediaType)) {
      throw new Error('O formato da imagem não é compatível com Web Detection.');
    }

    const startedAt = this.now();
    const bytes = await this.store.readBytes(attachment);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: bytes.toString('base64') },
            features: [{ type: 'WEB_DETECTION', maxResults: 10 }],
          }],
        }),
        signal: combined,
      },
    );
    if (!response.ok) throw new Error(`Google Vision respondeu com HTTP ${response.status}.`);
    const payload = await response.json() as GoogleVisionResponse;
    const first = payload.responses?.[0];
    if (first?.error?.message) throw new Error(first.error.message);
    const detection = first?.webDetection ?? {};

    return {
      bestGuess: detection.bestGuessLabels?.map((item) => item.label?.trim()).find(Boolean),
      entities: (detection.webEntities ?? []).flatMap((item) => {
        const name = item.description?.trim();
        return name ? [{ name, ...(typeof item.score === 'number' ? { score: item.score } : {}) }] : [];
      }),
      pages: (detection.pagesWithMatchingImages ?? []).flatMap((item) => {
        const url = item.url?.trim();
        if (!url || !/^https?:\/\//i.test(url)) return [];
        return [{ url, ...(item.pageTitle?.trim() ? { title: item.pageTitle.trim() } : {}), ...(typeof item.score === 'number' ? { score: item.score } : {}) }];
      }),
      fullMatches: urls(detection.fullMatchingImages),
      partialMatches: urls(detection.partialMatchingImages),
      similarImages: urls(detection.visuallySimilarImages),
      provider: this.id,
      durationMs: Math.max(0, this.now() - startedAt),
    };
  }
}
