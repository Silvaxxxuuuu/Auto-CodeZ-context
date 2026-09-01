import crypto from 'node:crypto';
import type { ActivityEvent } from '../ai/types';

export class ActivityRuntime {
  private events: ActivityEvent[] = [];

  push(type: ActivityEvent['type'], message: string, status: ActivityEvent['status'] = 'running'): ActivityEvent {
    const event: ActivityEvent = { id: crypto.randomUUID(), type, message, status, createdAt: Date.now() };
    this.events.push(event);
    return event;
  }

  complete(id: string, status: 'success' | 'failed', message?: string): void {
    const event = this.events.find((item) => item.id === id);
    if (!event) return;
    event.status = status;
    if (message) event.message = message;
  }

  list(): ActivityEvent[] {
    return [...this.events];
  }
}
