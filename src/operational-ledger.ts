import crypto from 'node:crypto';

export type OperationalLedgerActor = 'user' | 'agent' | 'plugin' | 'runtime' | 'external';
export type OperationalLedgerCategory = 'execution' | 'tool' | 'approval' | 'plugin' | 'job' | 'artifact' | 'test' | 'web' | 'system';
export type OperationalLedgerState = 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'cancelled';

export type OperationalLedgerDetail = string | number | boolean | null;

export type OperationalLedgerEvent = {
  eventId: string;
  sequence: number;
  timestamp: number;
  actor: OperationalLedgerActor;
  category: OperationalLedgerCategory;
  state: OperationalLedgerState;
  summary: string;
  chatId?: string;
  runId?: string;
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  clientId?: string;
  pluginId?: string;
  toolCallId?: string;
  toolName?: string;
  jobId?: string;
  causationId?: string;
  artifactIds?: string[];
  resources?: string[];
  sourceRefs?: string[];
  diff?: { files: number; addedLines: number; removedLines: number };
  progress?: number;
  durationMs?: number;
  error?: string;
  details?: Record<string, OperationalLedgerDetail>;
};

export type OperationalLedgerInput = Omit<OperationalLedgerEvent, 'eventId' | 'sequence' | 'timestamp'> & {
  timestamp?: number;
};

export type OperationalLedgerQuery = {
  afterSequence?: number;
  beforeSequence?: number;
  chatId?: string;
  runId?: string;
  projectId?: string;
  sessionId?: string;
  pluginId?: string;
  toolCallId?: string;
  jobId?: string;
  artifactId?: string;
  category?: OperationalLedgerCategory;
  state?: OperationalLedgerState;
  limit?: number;
};

export type OperationalLedgerPage = {
  events: OperationalLedgerEvent[];
  firstSequence?: number;
  lastSequence?: number;
  hasMore: boolean;
};

export type OperationalLedgerListener = (event: OperationalLedgerEvent) => void;

const ACTORS = new Set<OperationalLedgerActor>(['user', 'agent', 'plugin', 'runtime', 'external']);
const CATEGORIES = new Set<OperationalLedgerCategory>(['execution', 'tool', 'approval', 'plugin', 'job', 'artifact', 'test', 'web', 'system']);
const STATES = new Set<OperationalLedgerState>(['pending', 'running', 'waiting', 'success', 'failed', 'cancelled']);

const MAX_EVENTS = 5000;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_SUMMARY = 512;
const MAX_ERROR = 2048;
const MAX_ID = 160;
const MAX_ARTIFACTS = 32;
const MAX_RESOURCES = 64;
const MAX_SOURCE_REFS = 32;
const MAX_RESOURCE = 512;
const MAX_SOURCE_REF = 2048;
const MAX_DETAILS = 32;
const MAX_DETAIL_KEY = 96;
const MAX_DETAIL_STRING = 512;

function sanitizeText(value: string, maxLength: number, label: string): string {
  const normalized = value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  if (!normalized || normalized.length > maxLength) {
    if (!normalized) throw new Error(`${label} inválido.`);
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function normalizeId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} inválido.`);
  return normalized;
}

function normalizeDetails(value: Record<string, OperationalLedgerDetail> | undefined): Record<string, OperationalLedgerDetail> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_DETAILS) throw new Error('Detalhes do ledger excedem o limite.');
  const result: Record<string, OperationalLedgerDetail> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > MAX_DETAIL_KEY || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Chave de detalhe do ledger inválida.');
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Valor de detalhe do ledger inválido.');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Número de detalhe do ledger inválido.');
    result[key] = typeof item === 'string' ? sanitizeText(item, MAX_DETAIL_STRING, 'Detalhe do ledger') : item;
  }
  return result;
}

function cloneEvent(event: OperationalLedgerEvent): OperationalLedgerEvent {
  return {
    ...event,
    ...(event.artifactIds ? { artifactIds: [...event.artifactIds] } : {}),
    ...(event.resources ? { resources: [...event.resources] } : {}),
    ...(event.sourceRefs ? { sourceRefs: [...event.sourceRefs] } : {}),
    ...(event.diff ? { diff: { ...event.diff } } : {}),
    ...(event.details ? { details: { ...event.details } } : {}),
  };
}

export function isOperationalLedgerEvent(value: unknown): value is OperationalLedgerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<OperationalLedgerEvent>;
  if (typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > MAX_ID) return false;
  if (!Number.isInteger(event.sequence) || Number(event.sequence) <= 0) return false;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp < 0) return false;
  if (!ACTORS.has(event.actor as OperationalLedgerActor)) return false;
  if (!CATEGORIES.has(event.category as OperationalLedgerCategory)) return false;
  if (!STATES.has(event.state as OperationalLedgerState)) return false;
  if (typeof event.summary !== 'string' || !event.summary.trim() || event.summary.length > MAX_SUMMARY) return false;
  for (const id of [event.chatId, event.runId, event.projectId, event.sessionId, event.providerId, event.clientId, event.pluginId, event.toolCallId, event.toolName, event.jobId, event.causationId]) {
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > MAX_ID)) return false;
  }
  if (event.progress !== undefined && (typeof event.progress !== 'number' || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1)) return false;
  if (event.durationMs !== undefined && (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs) || event.durationMs < 0)) return false;
  if (event.error !== undefined && (typeof event.error !== 'string' || event.error.length > MAX_ERROR)) return false;
  if (event.artifactIds !== undefined) {
    if (!Array.isArray(event.artifactIds) || event.artifactIds.length > MAX_ARTIFACTS) return false;
    if (!event.artifactIds.every((id) => typeof id === 'string' && id.trim() && id.length <= MAX_ID)) return false;
    if (new Set(event.artifactIds).size !== event.artifactIds.length) return false;
  }
  if (event.resources !== undefined) {
    if (!Array.isArray(event.resources) || event.resources.length > MAX_RESOURCES) return false;
    if (!event.resources.every((item) => typeof item === 'string' && item.trim() && item.length <= MAX_RESOURCE)) return false;
    if (new Set(event.resources).size !== event.resources.length) return false;
  }
  if (event.sourceRefs !== undefined) {
    if (!Array.isArray(event.sourceRefs) || event.sourceRefs.length > MAX_SOURCE_REFS) return false;
    if (!event.sourceRefs.every((item) => typeof item === 'string' && item.trim() && item.length <= MAX_SOURCE_REF)) return false;
    if (new Set(event.sourceRefs).size !== event.sourceRefs.length) return false;
  }
  if (event.diff !== undefined) {
    if (!event.diff || typeof event.diff !== 'object') return false;
    if (![event.diff.files, event.diff.addedLines, event.diff.removedLines].every((item) => Number.isInteger(item) && item >= 0)) return false;
  }
  if (event.details !== undefined) {
    if (!event.details || typeof event.details !== 'object' || Array.isArray(event.details) || Object.keys(event.details).length > MAX_DETAILS) return false;
    for (const [key, item] of Object.entries(event.details)) {
      if (!key || key.length > MAX_DETAIL_KEY) return false;
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) return false;
      if (typeof item === 'string' && item.length > MAX_DETAIL_STRING) return false;
      if (typeof item === 'number' && !Number.isFinite(item)) return false;
    }
  }
  return true;
}

export class OperationalLedger {
  private sequence = 0;
  private readonly events: OperationalLedgerEvent[] = [];
  private readonly listeners = new Set<OperationalLedgerListener>();

  constructor(private readonly maxEvents = MAX_EVENTS) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000) throw new Error('Limite do ledger inválido.');
  }

  restore(events: OperationalLedgerEvent[]): void {
    if (!Array.isArray(events)) throw new Error('Ledger persistido inválido.');
    const seenIds = new Set<string>();
    const seenSequences = new Set<number>();
    const restored = events
      .filter(isOperationalLedgerEvent)
      .sort((left, right) => left.sequence - right.sequence)
      .filter((event) => {
        if (seenIds.has(event.eventId) || seenSequences.has(event.sequence)) return false;
        if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) return false;
        seenIds.add(event.eventId);
        seenSequences.add(event.sequence);
        return true;
      })
      .slice(-this.maxEvents)
      .map(cloneEvent);

    const pending = this.events.map(cloneEvent);
    this.events.length = 0;
    this.events.push(...restored);
    this.sequence = restored.reduce((highest, event) => Math.max(highest, event.sequence), 0);

    const restoredIds = new Set(restored.map((event) => event.eventId));
    for (const event of pending) {
      if (restoredIds.has(event.eventId)) continue;
      const resequenced = { ...event, sequence: ++this.sequence };
      this.events.push(resequenced);
    }
    this.prune();
  }

  record(input: OperationalLedgerInput): OperationalLedgerEvent {
    if (!ACTORS.has(input.actor)) throw new Error('Actor do ledger inválido.');
    if (!CATEGORIES.has(input.category)) throw new Error('Categoria do ledger inválida.');
    if (!STATES.has(input.state)) throw new Error('Estado do ledger inválido.');
    const timestamp = input.timestamp ?? Date.now();
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) throw new Error('Timestamp do ledger inválido.');

    const artifactIds = input.artifactIds === undefined
      ? undefined
      : [...new Set(input.artifactIds.map((id) => normalizeId(id, 'Artifact')!))];
    if (artifactIds && artifactIds.length > MAX_ARTIFACTS) throw new Error('Evento do ledger possui artifacts demais.');
    const resources = input.resources === undefined
      ? undefined
      : [...new Set(input.resources.map((item) => sanitizeText(item, MAX_RESOURCE, 'Recurso do ledger')))];
    if (resources && resources.length > MAX_RESOURCES) throw new Error('Evento do ledger possui recursos demais.');
    const sourceRefs = input.sourceRefs === undefined
      ? undefined
      : [...new Set(input.sourceRefs.map((item) => sanitizeText(item, MAX_SOURCE_REF, 'Fonte do ledger')))];
    if (sourceRefs && sourceRefs.length > MAX_SOURCE_REFS) throw new Error('Evento do ledger possui fontes demais.');
    if (input.diff && (![input.diff.files, input.diff.addedLines, input.diff.removedLines].every((item) => Number.isInteger(item) && item >= 0))) {
      throw new Error('Resumo de diff do ledger inválido.');
    }
    if (input.progress !== undefined && (!Number.isFinite(input.progress) || input.progress < 0 || input.progress > 1)) throw new Error('Progresso do ledger inválido.');
    if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) throw new Error('Duração do ledger inválida.');

    const event: OperationalLedgerEvent = {
      eventId: crypto.randomUUID(),
      sequence: ++this.sequence,
      timestamp,
      actor: input.actor,
      category: input.category,
      state: input.state,
      summary: sanitizeText(input.summary, MAX_SUMMARY, 'Resumo do ledger'),
      ...(normalizeId(input.chatId, 'Chat') ? { chatId: normalizeId(input.chatId, 'Chat') } : {}),
      ...(normalizeId(input.runId, 'Run') ? { runId: normalizeId(input.runId, 'Run') } : {}),
      ...(normalizeId(input.projectId, 'Projeto') ? { projectId: normalizeId(input.projectId, 'Projeto') } : {}),
      ...(normalizeId(input.sessionId, 'Sessão') ? { sessionId: normalizeId(input.sessionId, 'Sessão') } : {}),
      ...(normalizeId(input.providerId, 'Provider') ? { providerId: normalizeId(input.providerId, 'Provider') } : {}),
      ...(normalizeId(input.clientId, 'Cliente') ? { clientId: normalizeId(input.clientId, 'Cliente') } : {}),
      ...(normalizeId(input.pluginId, 'Plugin') ? { pluginId: normalizeId(input.pluginId, 'Plugin') } : {}),
      ...(normalizeId(input.toolCallId, 'Tool call') ? { toolCallId: normalizeId(input.toolCallId, 'Tool call') } : {}),
      ...(normalizeId(input.toolName, 'Tool') ? { toolName: normalizeId(input.toolName, 'Tool') } : {}),
      ...(normalizeId(input.jobId, 'Job') ? { jobId: normalizeId(input.jobId, 'Job') } : {}),
      ...(normalizeId(input.causationId, 'Causation') ? { causationId: normalizeId(input.causationId, 'Causation') } : {}),
      ...(artifactIds?.length ? { artifactIds } : {}),
      ...(resources?.length ? { resources } : {}),
      ...(sourceRefs?.length ? { sourceRefs } : {}),
      ...(input.diff ? { diff: { ...input.diff } } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.error ? { error: sanitizeText(input.error, MAX_ERROR, 'Erro do ledger') } : {}),
      ...(input.details ? { details: normalizeDetails(input.details) } : {}),
    };

    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) throw new Error('Evento do ledger excede o limite de 128 KB.');
    this.events.push(event);
    this.prune();
    const snapshot = cloneEvent(event);
    for (const listener of this.listeners) {
      try {
        listener(cloneEvent(snapshot));
      } catch {
      }
    }
    return snapshot;
  }

  query(query: OperationalLedgerQuery = {}): OperationalLedgerPage {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Limite de consulta do ledger inválido.');
    if (query.afterSequence !== undefined && (!Number.isInteger(query.afterSequence) || query.afterSequence < 0)) throw new Error('Cursor afterSequence inválido.');
    if (query.beforeSequence !== undefined && (!Number.isInteger(query.beforeSequence) || query.beforeSequence < 1)) throw new Error('Cursor beforeSequence inválido.');
    if (query.category !== undefined && !CATEGORIES.has(query.category)) throw new Error('Categoria de consulta inválida.');
    if (query.state !== undefined && !STATES.has(query.state)) throw new Error('Estado de consulta inválido.');

    const filtered = this.events.filter((event) => {
      if (query.afterSequence !== undefined && event.sequence <= query.afterSequence) return false;
      if (query.beforeSequence !== undefined && event.sequence >= query.beforeSequence) return false;
      if (query.chatId !== undefined && event.chatId !== query.chatId) return false;
      if (query.runId !== undefined && event.runId !== query.runId) return false;
      if (query.projectId !== undefined && event.projectId !== query.projectId) return false;
      if (query.sessionId !== undefined && event.sessionId !== query.sessionId) return false;
      if (query.pluginId !== undefined && event.pluginId !== query.pluginId) return false;
      if (query.toolCallId !== undefined && event.toolCallId !== query.toolCallId) return false;
      if (query.jobId !== undefined && event.jobId !== query.jobId) return false;
      if (query.artifactId !== undefined && !event.artifactIds?.includes(query.artifactId)) return false;
      if (query.category !== undefined && event.category !== query.category) return false;
      if (query.state !== undefined && event.state !== query.state) return false;
      return true;
    });

    const events = filtered.slice(0, limit).map(cloneEvent);
    return {
      events,
      ...(events.length ? { firstSequence: events[0].sequence, lastSequence: events[events.length - 1].sequence } : {}),
      hasMore: filtered.length > events.length,
    };
  }

  listAll(): OperationalLedgerEvent[] {
    return this.events.map(cloneEvent);
  }

  subscribe(listener: OperationalLedgerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.events.length = 0;
  }

  private prune(): void {
    while (this.events.length > this.maxEvents) this.events.shift();
    let bytes = this.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
    while (bytes > MAX_LEDGER_BYTES && this.events.length > 1) {
      const removed = this.events.shift();
      if (removed) bytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
    }
  }
}

export const operationalLedger = new OperationalLedger();
