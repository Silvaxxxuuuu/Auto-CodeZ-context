import type { PermissionLevel, ProviderId } from './ai/types';

export type ExecutionTaskCapsule = {
  id: string;
  chatId: string;
  runId: string;
  objective: string;
  projectId?: string;
  providerId: ProviderId;
  model: string;
  permissionLevel: PermissionLevel;
  createdAt: number;
};

function keyOf(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'read-only' || value === 'safe' || value === 'ask' || value === 'unrestricted';
}

function cloneCapsule(capsule: ExecutionTaskCapsule): ExecutionTaskCapsule {
  return { ...capsule };
}

function sameCapsule(left: ExecutionTaskCapsule, right: Omit<ExecutionTaskCapsule, 'id' | 'createdAt'>): boolean {
  return left.chatId === right.chatId
    && left.runId === right.runId
    && left.objective === right.objective
    && left.projectId === right.projectId
    && left.providerId === right.providerId
    && left.model === right.model
    && left.permissionLevel === right.permissionLevel;
}

export class ExecutionTaskCapsuleRuntime {
  private readonly capsules = new Map<string, ExecutionTaskCapsule>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => `capsule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {}

  create(input: Omit<ExecutionTaskCapsule, 'id' | 'createdAt'>): ExecutionTaskCapsule {
    const normalized: Omit<ExecutionTaskCapsule, 'id' | 'createdAt'> = {
      chatId: requireText(input.chatId, 'Chat'),
      runId: requireText(input.runId, 'Execução'),
      objective: requireText(input.objective, 'Objetivo'),
      projectId: input.projectId === undefined ? undefined : requireText(input.projectId, 'Projeto'),
      providerId: requireText(input.providerId, 'Provider'),
      model: requireText(input.model, 'Modelo'),
      permissionLevel: input.permissionLevel,
    };
    if (!isPermissionLevel(normalized.permissionLevel)) throw new Error('Nível de permissão inválido.');

    const key = keyOf(normalized.chatId, normalized.runId);
    const existing = this.capsules.get(key);
    if (existing) {
      if (sameCapsule(existing, normalized)) return cloneCapsule(existing);
      throw new Error(`A Task Capsule da execução ${normalized.runId} é imutável.`);
    }

    const capsule: ExecutionTaskCapsule = {
      id: this.createId(),
      ...normalized,
      createdAt: this.now(),
    };
    this.capsules.set(key, capsule);
    return cloneCapsule(capsule);
  }

  restore(capsules: ExecutionTaskCapsule[]): void {
    if (!Array.isArray(capsules)) throw new Error('Task Capsules persistidas inválidas.');
    this.capsules.clear();
    for (const capsule of capsules) {
      if (!capsule || typeof capsule !== 'object') continue;
      try {
        const chatId = requireText(capsule.chatId, 'Chat');
        const runId = requireText(capsule.runId, 'Execução');
        const objective = requireText(capsule.objective, 'Objetivo');
        const providerId = requireText(capsule.providerId, 'Provider');
        const model = requireText(capsule.model, 'Modelo');
        const projectId = capsule.projectId === undefined ? undefined : requireText(capsule.projectId, 'Projeto');
        if (!isPermissionLevel(capsule.permissionLevel)) continue;
        if (typeof capsule.id !== 'string' || !capsule.id.trim()) continue;
        if (typeof capsule.createdAt !== 'number' || !Number.isFinite(capsule.createdAt) || capsule.createdAt < 0) continue;
        this.capsules.set(keyOf(chatId, runId), {
          id: capsule.id.trim(),
          chatId,
          runId,
          objective,
          projectId,
          providerId,
          model,
          permissionLevel: capsule.permissionLevel,
          createdAt: capsule.createdAt,
        });
      } catch {
        // Invalid persisted capsules are ignored without blocking startup.
      }
    }
  }

  get(chatId: string, runId: string): ExecutionTaskCapsule | undefined {
    const capsule = this.capsules.get(keyOf(chatId, runId));
    return capsule ? cloneCapsule(capsule) : undefined;
  }

  list(chatId?: string): ExecutionTaskCapsule[] {
    return [...this.capsules.values()]
      .filter((capsule) => chatId === undefined || capsule.chatId === chatId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cloneCapsule);
  }

  removeChat(chatId: string): number {
    let removed = 0;
    for (const [key, capsule] of this.capsules) {
      if (capsule.chatId !== chatId) continue;
      this.capsules.delete(key);
      removed += 1;
    }
    return removed;
  }
}
