export type PluginActivityStatus = 'running' | 'waiting' | 'completed' | 'failed';

export type PluginActivitySnapshot = {
  pluginId: string;
  message: string;
  status: PluginActivityStatus;
  updatedAt: number;
};

export type PluginActivityListener = (activity: PluginActivitySnapshot) => void;

const MAX_MESSAGE_LENGTH = 512;

function normalizeMessage(message: string): string {
  const normalized = message.trim();
  if (!normalized || normalized.length > MAX_MESSAGE_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new Error('Mensagem de atividade do plugin inválida.');
  }
  return normalized;
}

export class PluginActivityRuntime {
  private readonly current = new Map<string, PluginActivitySnapshot>();
  private readonly listeners = new Set<PluginActivityListener>();

  publish(pluginId: string, message: string, status: PluginActivityStatus = 'running', now = Date.now()): PluginActivitySnapshot {
    const snapshot: PluginActivitySnapshot = {
      pluginId,
      message: normalizeMessage(message),
      status,
      updatedAt: now,
    };
    this.current.set(pluginId, snapshot);
    this.emit(snapshot);
    return { ...snapshot };
  }

  clear(pluginId: string): boolean {
    return this.current.delete(pluginId);
  }

  get(pluginId: string): PluginActivitySnapshot | undefined {
    const value = this.current.get(pluginId);
    return value ? { ...value } : undefined;
  }

  list(): PluginActivitySnapshot[] {
    return [...this.current.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({ ...item }));
  }

  subscribe(listener: PluginActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(snapshot: PluginActivitySnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...snapshot });
      } catch {
      }
    }
  }
}
