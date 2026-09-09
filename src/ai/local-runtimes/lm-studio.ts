import type {
  LocalModelDescriptor,
  LocalModelInstallProgress,
  LocalModelRuntimeAdapter,
  LocalModelRuntimeInfo,
} from '../local-model-runtime';
import { fetchWithTimeout } from '../sse';

const DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

type LMStudioLocalRuntimeOptions = {
  endpoint?: string;
  apiToken?: string;
  pollIntervalMs?: number;
};

type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed' | 'already_downloaded';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeEndpoint(value?: string): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function downloadStatus(value: unknown): DownloadStatus | undefined {
  return value === 'downloading'
    || value === 'paused'
    || value === 'completed'
    || value === 'failed'
    || value === 'already_downloaded'
    ? value
    : undefined;
}

function statusLabel(status: DownloadStatus): string {
  if (status === 'downloading') return 'Baixando';
  if (status === 'paused') return 'Download pausado';
  if (status === 'completed' || status === 'already_downloaded') return 'Concluído';
  return 'Falhou';
}

function errorMessage(data: Record<string, unknown>, fallback: string): string {
  const direct = typeof data.error === 'string' ? data.error.trim() : '';
  const nested = asRecord(data.error);
  const nestedMessage = typeof nested?.message === 'string' ? nested.message.trim() : '';
  return nestedMessage || direct || fallback;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LMStudioLocalRuntimeAdapter implements LocalModelRuntimeAdapter {
  readonly id = 'lm-studio';
  readonly displayName = 'LM Studio';
  private readonly endpoint: string;
  private readonly apiToken?: string;
  private readonly pollIntervalMs: number;

  constructor(options: LMStudioLocalRuntimeOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.apiToken = options.apiToken?.trim() || undefined;
    this.pollIntervalMs = typeof options.pollIntervalMs === 'number' && Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
  }

  async getInfo(): Promise<LocalModelRuntimeInfo> {
    try {
      const response = await fetchWithTimeout(`${this.endpoint}/api/v1/models`, {
        headers: this.headers(),
      }, REQUEST_TIMEOUT_MS);
      return { id: this.id, displayName: this.displayName, available: response.ok, endpoint: this.endpoint };
    } catch {
      return { id: this.id, displayName: this.displayName, available: false, endpoint: this.endpoint };
    }
  }

  async listInstalled(): Promise<LocalModelDescriptor[]> {
    const response = await fetchWithTimeout(`${this.endpoint}/api/v1/models`, {
      headers: this.headers(),
    }, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(errorMessage(data, `LM Studio models request failed: ${response.status}`));
    if (!Array.isArray(data.models)) throw new Error('LM Studio retornou uma lista de modelos inválida.');

    const models: LocalModelDescriptor[] = [];
    for (const raw of data.models) {
      const record = asRecord(raw);
      if (!record || record.type !== 'llm') continue;
      const id = typeof record.key === 'string' ? record.key.trim() : '';
      if (!id) continue;
      const quantization = asRecord(record.quantization);
      const capabilities = asRecord(record.capabilities);
      const modelCapabilities: string[] = [];
      if (capabilities?.vision === true) modelCapabilities.push('vision');
      if (capabilities?.trained_for_tool_use === true) modelCapabilities.push('tools');
      const sizeBytes = finitePositive(record.size_bytes);
      const contextWindow = finitePositive(record.max_context_length);
      const displayName = typeof record.display_name === 'string' && record.display_name.trim() ? record.display_name.trim() : id;
      models.push({
        id,
        name: displayName,
        runtimeId: this.id,
        installed: true,
        ...(sizeBytes ? { sizeBytes } : {}),
        ...(typeof record.params_string === 'string' && record.params_string.trim() ? { parameterSize: record.params_string.trim() } : {}),
        ...(typeof quantization?.name === 'string' && quantization.name.trim() ? { quantization: quantization.name.trim() } : {}),
        ...(typeof record.architecture === 'string' && record.architecture.trim() ? { family: record.architecture.trim() } : {}),
        ...(modelCapabilities.length ? { capabilities: modelCapabilities } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
    return models;
  }

  async *install(modelId: string): AsyncGenerator<LocalModelInstallProgress> {
    const model = modelId.trim();
    if (!model) throw new Error('Modelo local inválido.');

    const initial = await this.requestDownload(model);
    const initialStatus = this.requireStatus(initial);
    if (initialStatus === 'failed') throw new Error(errorMessage(initial, 'LM Studio falhou ao iniciar o download.'));
    yield this.progress(model, initial, initialStatus);
    if (initialStatus === 'completed' || initialStatus === 'already_downloaded') return;

    const jobId = typeof initial.job_id === 'string' ? initial.job_id.trim() : '';
    if (!jobId) throw new Error('LM Studio iniciou o download sem retornar um job_id.');

    while (true) {
      await delay(this.pollIntervalMs);
      const current = await this.requestDownloadStatus(jobId);
      const status = this.requireStatus(current);
      if (status === 'failed') throw new Error(errorMessage(current, 'LM Studio informou falha durante o download.'));
      yield this.progress(model, current, status);
      if (status === 'completed' || status === 'already_downloaded') return;
    }
  }

  private headers(includeJson = false): Record<string, string> {
    return {
      ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
    };
  }

  private async requestDownload(model: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(`${this.endpoint}/api/v1/models/download`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ model }),
    }, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(errorMessage(data, `LM Studio download request failed: ${response.status}`));
    return data;
  }

  private async requestDownloadStatus(jobId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(`${this.endpoint}/api/v1/models/download/status/${encodeURIComponent(jobId)}`, {
      headers: this.headers(),
    }, REQUEST_TIMEOUT_MS);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(errorMessage(data, `LM Studio download status request failed: ${response.status}`));
    return data;
  }

  private requireStatus(data: Record<string, unknown>): DownloadStatus {
    const status = downloadStatus(data.status);
    if (!status) throw new Error('LM Studio retornou um estado de download inválido.');
    return status;
  }

  private progress(modelId: string, data: Record<string, unknown>, status: DownloadStatus): LocalModelInstallProgress {
    const totalBytes = finitePositive(data.total_size_bytes);
    const completedBytes = finiteNonNegative(data.downloaded_bytes);
    const done = status === 'completed' || status === 'already_downloaded';
    return {
      runtimeId: this.id,
      modelId,
      status: statusLabel(status),
      ...(completedBytes !== undefined ? { completedBytes } : {}),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(completedBytes !== undefined && totalBytes ? { percent: Math.min(100, Math.max(0, completedBytes / totalBytes * 100)) } : done ? { percent: 100 } : {}),
      done,
    };
  }
}
