import { createHash } from 'node:crypto';

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"__undefined__"';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

export function deterministicProviderToolCallId(input: {
  providerId: string;
  model: string;
  toolName: string;
  arguments: Record<string, unknown>;
  ordinal: number;
}): string {
  const payload = stableSerialize({
    providerId: input.providerId,
    model: input.model,
    toolName: input.toolName,
    arguments: input.arguments,
    ordinal: input.ordinal,
  });
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 20);
  return `${input.providerId}_tool_${digest}`;
}
