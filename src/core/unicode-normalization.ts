const suspiciousPatterns = [
  /Ã./g,
  /Â./g,
  /â[€-™]/g,
  /ï¿½/g,
  /ðŸ/g,
];

function suspiciousScore(value: string): number {
  return suspiciousPatterns.reduce((score, pattern) => score + (value.match(pattern)?.length ?? 0), 0);
}

function latin1Bytes(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 255) return null;
    bytes[index] = code;
  }
  return bytes;
}

export function normalizeUnicodeText(value: string): string {
  if (!value || suspiciousScore(value) === 0) return value;
  const bytes = latin1Bytes(value);
  if (!bytes) return value;
  let repaired: string;
  try {
    repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
  if (!repaired || repaired.includes('\uFFFD')) return value;
  return suspiciousScore(repaired) < suspiciousScore(value) ? repaired : value;
}
