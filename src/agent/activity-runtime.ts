import crypto from 'node:crypto';
import type { ActivityEvent } from '../ai/types';
import type { StructuredActivityEvent } from '../agent-core/contracts';

export type ActivityListener = (event: ActivityEvent) => void;

export class ActivityRuntime {
  private readonly listeners = new Set<ActivityListener>();
  private readonly structuredListeners = new Set<(event: StructuredActivityEvent) => void>();

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStructured(listener: (event: StructuredActivityEvent) => void): () => void {
    this.structuredListeners.add(listener);
    return () => this.structuredListeners.delete(listener);
  }

  emitStructured(event: StructuredActivityEvent): void {
    for (const listener of this.structuredListeners) {
      try { listener(event); } catch { /* Observers cannot interrupt operations. */ }
    }
  }

  emit(input: Omit<ActivityEvent, 'id' | 'createdAt'>): ActivityEvent {
    const event: ActivityEvent = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Activity observers must never interrupt the operation they observe.
      }
    }
    return event;
  }

  start(type: ActivityEvent['type'], message: string): ActivityEvent {
    return this.emit({ type, message, status: 'running' });
  }

  success(type: ActivityEvent['type'], message: string): ActivityEvent {
    return this.emit({ type, message, status: 'success' });
  }

  failure(type: ActivityEvent['type'], message: string): ActivityEvent {
    return this.emit({ type, message, status: 'failed' });
  }
}
