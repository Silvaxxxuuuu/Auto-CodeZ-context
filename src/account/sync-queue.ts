import crypto from 'node:crypto';
import { LocalStorage } from '../core/storage';
import type { DeviceId, SyncEntityType, SyncOperation, SyncQueueItem } from './types';

const STORAGE_FILE = 'sync-queue.json';

type QueueState = SyncQueueItem[];

export class SyncQueue {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorage) {}

  async list(): Promise<QueueState> {
    const items = await this.storage.read<QueueState>(STORAGE_FILE, []);
    return items.map((item) => ({ ...item }));
  }

  async enqueue<TPayload>(input: {
    entityType: SyncEntityType;
    entityId: string;
    operation: SyncOperation;
    deviceId: DeviceId;
    baseRevision: number;
    localRevision: number;
    payload: TPayload;
    now?: number;
  }): Promise<SyncQueueItem<TPayload>> {
    const now = input.now ?? Date.now();
    const item: SyncQueueItem<TPayload> = {
      id: crypto.randomUUID(),
      entityType: input.entityType,
      entityId: input.entityId,
      operation: input.operation,
      deviceId: input.deviceId,
      baseRevision: input.baseRevision,
      localRevision: input.localRevision,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
      status: 'pending',
    };

    await this.mutate((items) => items.concat(item));
    return { ...item };
  }

  async markInFlight(id: string, now = Date.now()): Promise<void> {
    await this.mutate((items) => items.map((item) => item.id === id ? { ...item, status: 'in_flight', updatedAt: now } : item));
  }

  async markPending(id: string, error?: string, nextAttemptAt = Date.now()): Promise<void> {
    await this.mutate((items) => items.map((item) => item.id === id ? {
      ...item,
      status: 'pending',
      updatedAt: Date.now(),
      attempts: item.attempts + 1,
      nextAttemptAt,
      ...(error ? { lastError: error } : { lastError: undefined }),
    } : item));
  }

  async markFailed(id: string, error: string, nextAttemptAt = Date.now()): Promise<void> {
    await this.mutate((items) => items.map((item) => item.id === id ? {
      ...item,
      status: 'failed',
      updatedAt: Date.now(),
      attempts: item.attempts + 1,
      nextAttemptAt,
      lastError: error,
    } : item));
  }

  async remove(id: string): Promise<void> {
    await this.mutate((items) => items.filter((item) => item.id !== id));
  }

  private async mutate(mutator: (items: QueueState) => QueueState): Promise<void> {
    const operation = this.mutation.then(async () => {
      const current = await this.storage.read<QueueState>(STORAGE_FILE, []);
      await this.storage.write(STORAGE_FILE, mutator(current));
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
  }
}
