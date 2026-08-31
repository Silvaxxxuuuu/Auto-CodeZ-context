export function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} não pode estar vazio.`);
  }
  return value.trim();
}

export function requireIdentifier(value: unknown, fieldName: string): string {
  const normalized = requireNonEmptyString(value, fieldName);
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
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
