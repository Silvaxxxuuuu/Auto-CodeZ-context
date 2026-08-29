import type {
  AiProviderId,
  AiResponse,
} from '../ai/aiConnector';

import {
  readWindowText,
} from './windows-ui';

export type AiResponseReaderState = {
  handle: number;
  prompt: string;
  baseline: string[];
  startedAt: number;
};

const ignoredTexts = new Set([
  'stop generating',
  'regenerate',
  'retry',
  'copy',
  'share',
  'edit',
  'good response',
  'bad response',
  'send',
  'new chat',
]);

function normalize(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanCandidate(
  value: string,
  prompt: string,
): string {
  let candidate = normalize(value);
  const normalizedPrompt = normalize(prompt);

  if (
    normalizedPrompt &&
    candidate.startsWith(normalizedPrompt)
  ) {
    candidate = normalize(
      candidate.slice(
        normalizedPrompt.length,
      ),
    );
  }

  return candidate;
}

function isIgnored(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return (
    normalized.length < 3 ||
    ignoredTexts.has(normalized)
  );
}

export async function captureResponseReaderState(
  handle: number,
  prompt: string,
): Promise<AiResponseReaderState> {
  return {
    handle,
    prompt,
    baseline:
      await readWindowText(handle),
    startedAt:
      Date.now(),
  };
}

export async function readNewAiResponse(
  state: AiResponseReaderState | null,
  provider: AiProviderId,
): Promise<AiResponse | null> {
  if (!state) {
    return null;
  }

  const current =
    await readWindowText(
      state.handle,
    );

  if (current.length === 0) {
    return null;
  }

  const baseline =
    state.baseline.map(
      normalize,
    );

  const candidates: string[] = [];

  for (const raw of current) {
    const normalized =
      normalize(raw);

    if (
      !normalized ||
      isIgnored(normalized)
    ) {
      continue;
    }

    if (
      baseline.includes(normalized)
    ) {
      continue;
    }

    const cleaned =
      cleanCandidate(
        normalized,
        state.prompt,
      );

    if (
      !cleaned ||
      isIgnored(cleaned)
    ) {
      continue;
    }

    if (
      baseline.some(
        (previous) =>
          cleaned === previous ||
          cleaned.startsWith(previous),
      )
    ) {
      continue;
    }

    candidates.push(cleaned);
  }

  for (const raw of current) {
    const normalized =
      normalize(raw);

    if (
      !normalized ||
      isIgnored(normalized)
    ) {
      continue;
    }

    for (const previous of baseline) {
      if (
        !normalized.startsWith(previous) ||
        normalized.length <= previous.length
      ) {
        continue;
      }

      const suffix =
        cleanCandidate(
          normalized.slice(
            previous.length,
          ),
          state.prompt,
        );

      if (
        suffix &&
        !isIgnored(suffix)
      ) {
        candidates.push(suffix);
      }
    }
  }

  const unique = [
    ...new Set(
      candidates.map(normalize),
    ),
  ];

  if (unique.length === 0) {
    return null;
  }

  unique.sort(
    (a, b) =>
      b.length - a.length,
  );

  return {
    provider,
    content: unique[0],
    receivedAt: Date.now(),
  };
}
