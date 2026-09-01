export function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} não pode estar vazio.`);
  }
  return value.trim();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && ((codePoint >= 0 && codePoint <= 0x1f) || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function requireIdentifier(value: unknown, fieldName: string): string {
  const normalized = requireNonEmptyString(value, fieldName);
  if (normalized.length > 256 || containsControlCharacter(normalized)) {
    throw new Error(`${fieldName} é inválido.`);
  }
  return normalized;
}

export function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} é inválido.`);
  }
  return value as Record<string, unknown>;
}
