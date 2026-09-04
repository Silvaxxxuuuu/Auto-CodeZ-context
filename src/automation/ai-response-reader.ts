import type {
  AiProviderId,
  AiResponse,
} from '../ai/aiConnector';

import {
  readWindowText,
} from './windows-ui';

const RESPONSE_STABILITY_MS = 1000;
const MIN_RESPONSE_LENGTH = 8;

const IGNORED_TEXT = new Set([
  'Copy',
  'Copied',
  'Retry',
  'Regenerate',
  'Edit',
  'Like',
  'Dislike',
  'Share',
  'More',
  'Stop generating',
  'New chat',
]);

function normalizeText(
  value: string,
): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isCandidate(
  value: string,
): boolean {
  const normalized =
    normalizeText(value);

  if (
    normalized.length <
    MIN_RESPONSE_LENGTH
  ) {
    return false;
  }

  if (
    IGNORED_TEXT.has(
      normalized,
    )
  ) {
    return false;
  }

  if (
    normalized.startsWith('http://') ||
    normalized.startsWith('https://')
  ) {
    return false;
  }

  return true;
}

function uniqueTexts(
  values: string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized =
      normalizeText(value);

    if (
      !normalized ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export class AiResponseReader {
  private baseline =
    new Set<string>();

  private handle: number | null =
    null;

  private candidate = '';
  private candidateSince = 0;

  capture(
    handle: number,
    texts: string[],
  ): void {
    this.handle = handle;
    this.baseline = new Set(
      uniqueTexts(texts),
    );
    this.candidate = '';
    this.candidateSince = 0;
  }

  async captureFromWindow(
    handle: number,
  ): Promise<void> {
    const texts =
      await readWindowText(
        handle,
      );

    this.capture(
      handle,
      texts,
    );
  }

  async read(
    provider: AiProviderId,
  ): Promise<AiResponse | null> {
    if (
      !this.handle ||
      this.handle <= 0
    ) {
      return null;
    }

    const texts =
      uniqueTexts(
        await readWindowText(
          this.handle,
        ),
      );

    const candidates =
      texts.filter(
        (text) =>
          !this.baseline.has(text) &&
          isCandidate(text),
      );

    if (
      candidates.length === 0
    ) {
      this.candidate = '';
      this.candidateSince = 0;
      return null;
    }

    const nextCandidate =
      candidates.sort(
        (left, right) =>
          right.length -
          left.length,
      )[0];

    if (
      nextCandidate !==
      this.candidate
    ) {
      this.candidate =
        nextCandidate;
      this.candidateSince =
        Date.now();
      return null;
    }

    if (
      Date.now() -
        this.candidateSince <
      RESPONSE_STABILITY_MS
    ) {
      return null;
    }

    return {
      provider,
      content:
        nextCandidate,
      receivedAt:
        Date.now(),
    };
  }
}
