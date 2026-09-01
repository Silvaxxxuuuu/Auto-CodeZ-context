import crypto from 'node:crypto';
import type { AIRequest, AIResponse } from './types';

export type ProviderRequestStatus = 'pending' | 'completed' | 'failed';

export interface ProviderRequestJournalEntry {
  requestId: string;
  fingerprint: string;
  providerId: string;
  model: string;
  status: ProviderRequestStatus;
  createdAt: number;
  updatedAt: number;
  response?: AIResponse;
  error?: string;
}

export interface ProviderRequestJournalStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

const STATE_FILE = 'provider-requests.json';
const STATE_VERSION = 1;

type PersistedState = {
  version: typeof STATE_VERSION;
  entries: ProviderRequestJournalEntry[];
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function fingerprintRequest(request: AIRequest): string {
  const normalized = stableValue({
    providerId: request.providerId,
    model: request.model,
    messages: request.messages,
    intelligence: request.intelligence,
    projectContext: request.projectContext,
    toolsEnabled: request.toolsEnabled,
    tools: request.tools,
  });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export class ProviderRequestJournal {
  private entries = new Map<string, ProviderRequestJournalEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage?: ProviderRequestJournalStorage) {}

  async init(): Promise<void> {
    if (!this.storage) return;
    const state = await this.storage.read<PersistedState>(STATE_FILE, { version: STATE_VERSION, entries: [] });
    this.entries.clear();
    if (state?.version !== STATE_VERSION || !Array.isArray(state.entries)) return;
    for (const entry of state.entries) {
      if (!entry?.requestId || !entry.fingerprint || !entry.providerId || !entry.model) continue;
      this.entries.set(entry.requestId, { ...entry });
    }
  }

  async begin(request: AIRequest): Promise<{ requestId: string; cachedResponse?: AIResponse }> {
    const fingerprint = fingerprintRequest(request);
    const existing = [...this.entries.values()].find((entry) => entry.fingerprint === fingerprint);
    if (existing?.status === 'completed' && existing.response) return { requestId: existing.requestId, cachedResponse: existing.response };
    if (existing?.status === 'pending') throw new Error('Existe uma solicitação ao provider interrompida para este contexto. Recupere ou descarte a solicitação antes de tentar novamente.');

    const now = Date.now();
    const entry: ProviderRequestJournalEntry = {
      requestId: crypto.randomUUID(),
      fingerprint,
      providerId: request.providerId,
      model: request.model,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(entry.requestId, entry);
    await this.persist();
    return { requestId: entry.requestId };
  }

  async complete(requestId: string, response: AIResponse): Promise<void> {
    const entry = this.require(requestId);
    entry.status = 'completed';
    entry.response = response;
    delete entry.error;
    entry.updatedAt = Date.now();
    await this.persist();
  }

  async fail(requestId: string, error: string): Promise<void> {
    const entry = this.require(requestId);
    entry.status = 'failed';
    entry.error = error;
    delete entry.response;
    entry.updatedAt = Date.now();
    await this.persist();
  }

  list(): ProviderRequestJournalEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry, response: entry.response ? { ...entry.response, toolCalls: entry.response.toolCalls ? [...entry.response.toolCalls] : undefined } : undefined }));
  }

  listInterrupted(): ProviderRequestJournalEntry[] {
    return this.list().filter((entry) => entry.status === 'pending');
  }

  async discard(requestId: string): Promise<void> {
    if (!this.entries.delete(requestId)) throw new Error('Solicitação do provider não encontrada.');
    await this.persist();
  }

  private require(requestId: string): ProviderRequestJournalEntry {
    const entry = this.entries.get(requestId);
    if (!entry) throw new Error('Solicitação do provider não encontrada.');
    return entry;
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedState = { version: STATE_VERSION, entries: this.list() };
    const write = this.writeQueue.then(() => this.storage!.write(STATE_FILE, state));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}
