import crypto from 'node:crypto';
import type { LocalStorage } from './core/storage';

const STATE_FILE = 'account-memories.json';
const MAX_CONTENT = 8_000;
const MAX_ENTRIES_PER_ACCOUNT = 1_000;

export type MemoryScope =
  | { type: 'global' }
  | { type: 'project'; projectId: string }
  | { type: 'chat'; chatId: string };

export type AccountMemoryEntry = {
  id: string;
  accountId: string;
  scope: MemoryScope;
  content: string;
  source?: { chatId?: string; runId?: string; messageCreatedAt?: number };
  createdAt: number;
  updatedAt: number;
};

type StoredMemoryState = { version: 1; entries: AccountMemoryEntry[] };

function cloneScope(scope: MemoryScope): MemoryScope {
  return scope.type === 'global' ? { type: 'global' } : { ...scope };
}

function cloneEntry(entry: AccountMemoryEntry): AccountMemoryEntry {
  return {
    ...entry,
    scope: cloneScope(entry.scope),
    ...(entry.source ? { source: { ...entry.source } } : {}),
  };
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new Error('A memória não pode ficar vazia.');
  if (normalized.length > MAX_CONTENT) throw new Error(`A memória deve ter no máximo ${MAX_CONTENT} caracteres.`);
  return normalized;
}

function validateScope(scope: MemoryScope): MemoryScope {
  if (scope.type === 'global') return { type: 'global' };
  if (scope.type === 'project' && scope.projectId.trim()) return { type: 'project', projectId: scope.projectId.trim() };
  if (scope.type === 'chat' && scope.chatId.trim()) return { type: 'chat', chatId: scope.chatId.trim() };
  throw new Error('Escopo de memória inválido.');
}

export class AccountMemoryRuntime {
  private entries: AccountMemoryEntry[] = [];

  constructor(
    private readonly storage: Pick<LocalStorage, 'read' | 'write'>,
    private readonly currentAccountId: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<StoredMemoryState>(STATE_FILE, { version: 1, entries: [] });
    this.entries = stored?.version === 1 && Array.isArray(stored.entries)
      ? stored.entries.filter((entry) => Boolean(entry?.id && entry.accountId && entry.content)).map(cloneEntry)
      : [];
  }

  private accountId(): string {
    const accountId = this.currentAccountId()?.trim();
    if (!accountId) throw new Error('Entre em uma conta para usar memórias persistentes.');
    return accountId;
  }

  async add(input: {
    scope: MemoryScope;
    content: string;
    source?: AccountMemoryEntry['source'];
  }): Promise<AccountMemoryEntry> {
    const accountId = this.accountId();
    const content = normalizeContent(input.content);
    const scope = validateScope(input.scope);
    const accountEntries = this.entries.filter((entry) => entry.accountId === accountId);
    if (accountEntries.length >= MAX_ENTRIES_PER_ACCOUNT) throw new Error('Limite local de memórias desta conta atingido.');
    const timestamp = this.now();
    const entry: AccountMemoryEntry = {
      id: crypto.randomUUID(),
      accountId,
      scope,
      content,
      ...(input.source ? { source: { ...input.source } } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.entries.push(entry);
    await this.persist();
    return cloneEntry(entry);
  }

  list(scope?: MemoryScope): AccountMemoryEntry[] {
    const accountId = this.accountId();
    const validated = scope ? validateScope(scope) : undefined;
    return this.entries
      .filter((entry) => entry.accountId === accountId)
      .filter((entry) => !validated || JSON.stringify(entry.scope) === JSON.stringify(validated))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneEntry);
  }

  async remove(id: string): Promise<boolean> {
    const accountId = this.accountId();
    const index = this.entries.findIndex((entry) => entry.id === id && entry.accountId === accountId);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await this.storage.write<StoredMemoryState>(STATE_FILE, { version: 1, entries: this.entries.map(cloneEntry) });
  }
}
