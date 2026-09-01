import crypto from 'node:crypto';
import type { ActivityEvent } from '../ai/types';

export type ActivityListener = (event: ActivityEvent) => void;

export class ActivityRuntime {
  private readonly listeners = new Set<ActivityListener>();

  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
