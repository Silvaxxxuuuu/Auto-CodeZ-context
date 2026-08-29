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
  candidate: string | null;
  candidateSince: number | null;
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
  'stop response',
]);

const busyTerms = [
  'stop generating',
  'stop response',
  'generating',
  'responding',
];

const RESPONSE_STABILITY_MS = 900;

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
      candidate.slice(normalizedPrompt.length),
    );
  }

  if (
    normalizedPrompt &&
    candidate === normalizedPrompt
  ) {
    return '';
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

function containsBusyIndicator(
  values: string[],
): boolean {
  return values.some((value) => {
    const normalized = normalize(value).toLowerCase();

    return busyTerms.some((term) =>
      normalized.includes(term),
    );
  });
}

function collectCandidates(
  current: string[],
  baseline: string[],
  prompt: string,
): string[] {
  const candidates: string[] = [];

  for (const raw of current) {
    const normalized = normalize(raw);

    if (!normalized || isIgnored(normalized)) {
      continue;
    }

    if (baseline.includes(normalized)) {
      continue;
    }

    const cleaned = cleanCandidate(
      normalized,
      prompt,
    );

    if (!cleaned || isIgnored(cleaned)) {
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
    const normalized = normalize(raw);

    if (!normalized || isIgnored(normalized)) {
      continue;
    }

    for (const previous of baseline) {
      if (
        !normalized.startsWith(previous) ||
        normalized.length <= previous.length
      ) {
        continue;
      }

      const suffix = cleanCandidate(
        normalized.slice(previous.length),
        prompt,
      );

      if (suffix && !isIgnored(suffix)) {
        candidates.push(suffix);
      }
    }
  }

  return [
    ...new Set(
      candidates.map(normalize),
    ),
  ].sort((a, b) => b.length - a.length);
}

export async function captureResponseReaderState(
  handle: number,
  prompt: string,
): Promise<AiResponseReaderState> {
  return {
    handle,
    prompt,
    baseline: await readWindowText(handle),
    startedAt: Date.now(),
    candidate: null,
    candidateSince: null,
  };
}

export async function readNewAiResponse(
  state: AiResponseReaderState | null,
  provider: AiProviderId,
): Promise<AiResponse | null> {
  if (!state) {
    return null;
  }

  const current = await readWindowText(state.handle);

  if (current.length === 0) {
    return null;
  }

  if (containsBusyIndicator(current)) {
    state.candidate = null;
    state.candidateSince = null;
    return null;
  }

  const baseline = state.baseline.map(normalize);
  const candidates = collectCandidates(
    current,
    baseline,
    state.prompt,
  );

  if (candidates.length === 0) {
    state.candidate = null;
    state.candidateSince = null;
    return null;
  }

  const bestCandidate = candidates[0];
  const now = Date.now();

  if (state.candidate !== bestCandidate) {
    state.candidate = bestCandidate;
    state.candidateSince = now;
    return null;
  }

  if (
    state.candidateSince === null ||
    now - state.candidateSince < RESPONSE_STABILITY_MS
  ) {
    return null;
  }

  return {
    provider,
    content: bestCandidate,
    receivedAt: now,
  };
}
