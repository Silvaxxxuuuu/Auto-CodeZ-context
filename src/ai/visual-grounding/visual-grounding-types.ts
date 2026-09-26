import type { AIAttachment } from '../types';
import type { WebGroundingSource } from '../../web/web-grounding-coordinator';

export type VisualGroundingReason = 'visual-identification' | 'visual-guidance' | 'visual-error';

export type ReverseImageEntity = {
  name: string;
  score?: number;
};

export type ReverseImageSearchResult = {
  bestGuess?: string;
  entities: ReverseImageEntity[];
  pages: Array<{ title?: string; url: string; score?: number }>;
  fullMatches: string[];
  partialMatches: string[];
  similarImages: string[];
  provider: string;
  durationMs: number;
};

export interface ReverseImageSearchProvider {
  readonly id: string;
  readonly displayName: string;
  available(): boolean;
  search(attachment: AIAttachment, signal?: AbortSignal): Promise<ReverseImageSearchResult>;
}

export type VisualGroundingDecision = {
  required: boolean;
  reason?: VisualGroundingReason;
  userMessage?: string;
  attachment?: AIAttachment;
};

export type VisualGroundingResult = {
  query: string;
  reason: VisualGroundingReason;
  sources: WebGroundingSource[];
  context: string;
  retrievedAt: number;
  reverse?: ReverseImageSearchResult;
};
