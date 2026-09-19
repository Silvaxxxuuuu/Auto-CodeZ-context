export type ExtractedWebDocument = {
  title?: string;
  text: string;
};

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  rsquo: '’',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const raw = entity.slice(hex ? 2 : 1);
      const code = Number.parseInt(raw, hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtmlFragment(value: string): string {
  return normalizeText(decodeEntities(value.replace(/<[^>]*>/g, ' ')));
}

function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const value = match ? stripHtmlFragment(match[1]) : '';
  return value || undefined;
}

export function extractReadableWebContent(raw: string, contentType: string, maxCharacters = 48_000): ExtractedWebDocument {
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();
  if (!normalizedType.includes('html') && !normalizedType.includes('xml')) {
    return { text: normalizeText(raw).slice(0, maxCharacters) };
  }

  const title = extractTitle(raw);
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, ' ');
  const text = normalizeText(decodeEntities(cleaned)).slice(0, maxCharacters);
  return { ...(title ? { title } : {}), text };
}

export function stripWebHtmlFragment(value: string): string {
  return stripHtmlFragment(value);
}
