import type {
  LocalModelDescriptor,
  LocalModelInstallProgress,
  LocalModelRuntimeAdapter,
  LocalModelRuntimeInfo,
} from '../local-model-runtime';
import { fetchWithTimeout } from '../sse';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 60 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeEndpoint(value?: string): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function modelIdFrom(value: unknown): string {
  const record = asRecord(value);
  const id = typeof record?.model === 'string' ? record.model : typeof record?.name === 'string' ? record.name : '';
  return id.trim();
}

async function* parseNdjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('Ollama não retornou um stream de instalação legível.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseLine = (line: string): Record<string, unknown> => {
    const parsed = asRecord(JSON.parse(line) as unknown);
    if (!parsed) throw new Error('Ollama retornou progresso de instalação inválido.');
    return parsed;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield parseLine(tail);
}

export class OllamaLocalRuntimeAdapter implements LocalModelRuntimeAdapter {
  readonly id = 'ollama';
  readonly displayName = 'Ollama';
  private readonly endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = normalizeEndpoint(endpoint);
  }

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    try {
      const response = await fetchWithTimeout(`${this.endpoint}/api/tags`, {}, REQUEST_TIMEOUT_MS);
      return { id: this.id, displayName: this.displayName, available: response.ok, endpoint: this.endpoint };
    } catch {
      return { id: this.id, displayName: this.displayName, available: false, endpoint: this.endpoint };
    }
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    const response = await fetchWithTimeout(`${this.endpoint}/api/tags`, {}, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Ollama models request failed: ${response.status}`);
    if (!Array.isArray(data.models)) throw new Error('Ollama retornou uma lista de modelos inválida.');

    const models: LocalModelDescriptor[] = [];
    for (const item of data.models) {
      const record = asRecord(item) ?? {};
      const details = asRecord(record.details) ?? {};
      const id = modelIdFrom(item);
      if (!id) continue;
      models.push({
        id,
        name: id,
        runtimeId: this.id,
        installed: true,
        ...(typeof record.size === 'number' && Number.isFinite(record.size) ? { sizeBytes: record.size } : {}),
        ...(typeof details.parameter_size === 'string' ? { parameterSize: details.parameter_size } : {}),
        ...(typeof details.quantization_level === 'string' ? { quantization: details.quantization_level } : {}),
        ...(typeof details.family === 'string' ? { family: details.family } : {}),
      });
    }
    return models;
  }

  async *install(modelId: string, signal?: AbortSignal): AsyncGenerator<LocalModelInstallProgress> {
    const model = modelId.trim();
    if (!model) throw new Error('Modelo local inválido.');
    const response = await fetchWithTimeout(`${this.endpoint}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    }, INSTALL_TIMEOUT_MS);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const message = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : `Ollama pull failed: ${response.status}`;
      throw new Error(message);
    }

    let emittedDone = false;
    for await (const chunk of parseNdjson(response)) {
      if (typeof chunk.error === 'string' && chunk.error.trim()) throw new Error(chunk.error.trim());
      const totalBytes = typeof chunk.total === 'number' && Number.isFinite(chunk.total) && chunk.total > 0 ? chunk.total : undefined;
      const completedBytes = typeof chunk.completed === 'number' && Number.isFinite(chunk.completed) && chunk.completed >= 0 ? chunk.completed : undefined;
      const status = typeof chunk.status === 'string' && chunk.status.trim() ? chunk.status.trim() : 'Processando';
      const done = status.toLowerCase() === 'success';
      if (done) emittedDone = true;
      yield {
        runtimeId: this.id,
        modelId: model,
        status,
        ...(completedBytes !== undefined ? { completedBytes } : {}),
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(completedBytes !== undefined && totalBytes ? { percent: Math.min(100, Math.max(0, completedBytes / totalBytes * 100)) } : {}),
        ...(typeof chunk.digest === 'string' ? { digest: chunk.digest } : {}),
        done,
      };
    }
    if (!emittedDone) throw new Error('Ollama encerrou a instalação sem confirmar sucesso.');
  }

  async remove(modelId: string): Promise<void> {
    const model = modelId.trim();
    if (!model) throw new Error('Modelo local inválido.');
    const response = await fetchWithTimeout(`${this.endpoint}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }, REQUEST_TIMEOUT_MS);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const message = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : `Ollama delete failed: ${response.status}`;
      throw new Error(message);
    }
  }
}
