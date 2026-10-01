import { createHash } from 'node:crypto';

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
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
