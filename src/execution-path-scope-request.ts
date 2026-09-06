export function normalizeOptionalExecutionAllowedPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('Caminhos permitidos inválidos.');
  const normalized = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('Caminho permitido inválido.');
    return item.trim();
  });
  return [...new Set(normalized)];
}
