const FULL_CONTENT_BYTES = 32 * 1024;
const DEFAULT_EXCERPT_BYTES = 64 * 1024;
const PREFIX_LINES = 12;
const WINDOW_RADIUS = 6;
const MAX_ANCHORS = 8;

const STOP_WORDS = new Set([
  'a', 'as', 'o', 'os', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'no', 'na',
  'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'para', 'por', 'com', 'sem', 'que',
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without',
  'this', 'that', 'these', 'those', 'fix', 'add', 'create', 'update', 'change',
  'corrigir', 'adicionar', 'criar', 'atualizar', 'alterar', 'implementar',
]);

type Interval = { start: number; end: number };
type RankedLine = { index: number; score: number };

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u)
    .flatMap((part) => part.split(/[_-]+/))
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)))];
}

function clipUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
}

function scoreLine(line: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const normalized = normalizeSearchText(line);
  let score = 0;
  for (const token of tokens) {
    let position = normalized.indexOf(token);
    let occurrences = 0;
    while (position >= 0 && occurrences < 4) {
      occurrences += 1;
      position = normalized.indexOf(token, position + token.length);
    }
    score += occurrences;
  }
  return score;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (const current of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end + 1) previous.end = Math.max(previous.end, current.end);
    else merged.push({ ...current });
  }
  return merged;
}

function omissionMarker(count: number): string {
  return `... [${count} lines omitted] ...`;
}

function renderIntervals(lines: string[], intervals: Interval[]): string {
  const rendered: string[] = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start > cursor) rendered.push(omissionMarker(interval.start - cursor));
    rendered.push(...lines.slice(interval.start, interval.end + 1));
    cursor = interval.end + 1;
  }
  if (cursor < lines.length) rendered.push(omissionMarker(lines.length - cursor));
  return rendered.join('\n');
}

export function buildTaskFocusedExcerpt(content: string, query: string, maxBytes = DEFAULT_EXCERPT_BYTES): string {
  if (maxBytes <= 0 || !content) return '';
  const totalBytes = Buffer.byteLength(content, 'utf8');
  if (totalBytes <= Math.min(FULL_CONTENT_BYTES, maxBytes)) return content;

  const lines = content.split(/\r?\n/);
  const tokens = searchTokens(query);
  if (!tokens.length) return clipUtf8(content, Math.min(maxBytes, FULL_CONTENT_BYTES));

  const ranked: RankedLine[] = lines
    .map((line, index) => ({ index, score: scoreLine(line, tokens) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_ANCHORS);

  if (!ranked.length) return clipUtf8(content, Math.min(maxBytes, FULL_CONTENT_BYTES));

  const intervals: Interval[] = [];
  if (lines.length) intervals.push({ start: 0, end: Math.min(PREFIX_LINES - 1, lines.length - 1) });
  for (const anchor of ranked) {
    intervals.push({
      start: Math.max(0, anchor.index - WINDOW_RADIUS),
      end: Math.min(lines.length - 1, anchor.index + WINDOW_RADIUS),
    });
  }

  return clipUtf8(renderIntervals(lines, mergeIntervals(intervals)), maxBytes);
}
