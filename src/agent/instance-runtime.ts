import crypto from 'node:crypto';
import type { InstanceHandle, InstanceKind } from '../agent-core/contracts';

export type InstanceCapabilities = {
  focus: boolean;
  close: boolean;
};

export type ManagedInstanceSnapshot = InstanceHandle & {
  projectId: string;
  updatedAt: number;
  capabilities: InstanceCapabilities;
  error?: string;
};

export type InstanceOpenRequest = {
  projectId: string;
  kind: InstanceKind;
  target: string;
};

export type InstancePlatformOpenRequest = InstanceOpenRequest & {
  instanceId: string;
};

export type InstancePlatformHandle = {
  canFocus: boolean;
  canClose: boolean;
  focus?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
  isOpen?: () => boolean;
  onClosed?: (listener: () => void) => (() => void) | void;
};

export type InstancePlatformAdapter = {
  open(input: InstancePlatformOpenRequest): Promise<InstancePlatformHandle>;
};

type ManagedInstanceRecord = {
  snapshot: ManagedInstanceSnapshot;
  handle?: InstancePlatformHandle;
  detachClosed?: () => void;
};

const INSTANCE_KINDS = new Set<InstanceKind>(['application', 'url', 'file', 'folder', 'preview']);

function cloneSnapshot(snapshot: ManagedInstanceSnapshot): ManagedInstanceSnapshot {
  return {
    ...snapshot,
    capabilities: { ...snapshot.capabilities },
  };
}

function normalizeKind(kind: InstanceKind): InstanceKind {
  if (!INSTANCE_KINDS.has(kind)) throw new Error(`Tipo de instância inválido: ${String(kind)}.`);
  return kind;
}

function normalizeTarget(kind: InstanceKind, target: string): string {
  const value = typeof target === 'string' ? target.trim() : '';
  if (!value) throw new Error('O target da instância não pode estar vazio.');

  if (kind === 'url' || kind === 'preview') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('URL da instância inválida.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Instâncias URL/preview aceitam apenas http:// ou https://.');
    }
    return parsed.toString();
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InstanceRuntime {
  private readonly instances = new Map<string, ManagedInstanceRecord>();

  constructor(
    private readonly platform: InstancePlatformAdapter,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async open(input: InstanceOpenRequest): Promise<ManagedInstanceSnapshot> {
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    if (!projectId) throw new Error('projectId da instância é obrigatório.');

    const kind = normalizeKind(input.kind);
    const target = normalizeTarget(kind, input.target);
    const instanceId = this.createId();
    if (!instanceId || this.instances.has(instanceId)) throw new Error('Identificador de instância inválido ou duplicado.');

    const openedAt = this.now();
    const record: ManagedInstanceRecord = {
      snapshot: {
        instanceId,
        projectId,
        kind,
        target,
        status: 'opening',
        openedAt,
        updatedAt: openedAt,
        capabilities: { focus: false, close: false },
      },
    };
    this.instances.set(instanceId, record);

    try {
      const handle = await this.platform.open({ instanceId, projectId, kind, target });
      record.handle = handle;
      record.snapshot.status = 'open';
      record.snapshot.updatedAt = this.now();
      record.snapshot.capabilities = {
        focus: Boolean(handle.canFocus && handle.focus),
        close: Boolean(handle.canClose && handle.close),
      };

      const detach = handle.onClosed?.(() => this.markClosed(instanceId));
      if (typeof detach === 'function') record.detachClosed = detach;
      this.refresh(record);
      return cloneSnapshot(record.snapshot);
    } catch (error) {
      record.snapshot.status = 'failed';
      record.snapshot.error = errorMessage(error);
      record.snapshot.updatedAt = this.now();
      throw error;
    }
  }

  get(instanceId: string): ManagedInstanceSnapshot {
    const record = this.record(instanceId);
    this.refresh(record);
    return cloneSnapshot(record.snapshot);
  }

  list(projectId?: string): ManagedInstanceSnapshot[] {
    const snapshots: ManagedInstanceSnapshot[] = [];
    for (const record of this.instances.values()) {
      this.refresh(record);
      if (!projectId || record.snapshot.projectId === projectId) snapshots.push(cloneSnapshot(record.snapshot));
    }
    return snapshots.sort((left, right) => left.openedAt - right.openedAt || left.instanceId.localeCompare(right.instanceId));
  }

  async focus(instanceId: string): Promise<ManagedInstanceSnapshot> {
    const record = this.record(instanceId);
    this.refresh(record);
    if (record.snapshot.status !== 'open') throw new Error(`A instância ${instanceId} não está aberta.`);
    if (!record.snapshot.capabilities.focus || !record.handle?.focus) {
      throw new Error(`A instância ${instanceId} não oferece controle de foco.`);
    }

    try {
      await record.handle.focus();
      record.snapshot.updatedAt = this.now();
      this.refresh(record);
      return cloneSnapshot(record.snapshot);
    } catch (error) {
      record.snapshot.error = errorMessage(error);
      record.snapshot.updatedAt = this.now();
      throw error;
    }
  }

  async close(instanceId: string): Promise<ManagedInstanceSnapshot> {
    const record = this.record(instanceId);
    this.refresh(record);
    if (record.snapshot.status === 'closed') return cloneSnapshot(record.snapshot);
    if (record.snapshot.status !== 'open') throw new Error(`A instância ${instanceId} não está aberta.`);
    if (!record.snapshot.capabilities.close || !record.handle?.close) {
      throw new Error(`A instância ${instanceId} não oferece controle de fechamento.`);
    }

    try {
      await record.handle.close();
      this.markClosed(instanceId);
      return cloneSnapshot(record.snapshot);
    } catch (error) {
      record.snapshot.error = errorMessage(error);
      record.snapshot.updatedAt = this.now();
      throw error;
    }
  }

  async closeAll(projectId?: string): Promise<ManagedInstanceSnapshot[]> {
    const controllable = this.list(projectId).filter((snapshot) => snapshot.status === 'open' && snapshot.capabilities.close);
    return Promise.all(controllable.map((snapshot) => this.close(snapshot.instanceId)));
  }

  remove(instanceId: string): boolean {
    const record = this.record(instanceId);
    this.refresh(record);
    if (record.snapshot.status === 'opening' || record.snapshot.status === 'open') {
      throw new Error('Não é possível remover uma instância ainda ativa.');
    }
    record.detachClosed?.();
    return this.instances.delete(instanceId);
  }

  private record(instanceId: string): ManagedInstanceRecord {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error(`Instância não encontrada: ${instanceId}.`);
    return record;
  }

  private refresh(record: ManagedInstanceRecord): void {
    if (record.snapshot.status !== 'open' || !record.handle?.isOpen) return;
    try {
      if (!record.handle.isOpen()) this.markClosed(record.snapshot.instanceId);
    } catch (error) {
      record.snapshot.error = errorMessage(error);
      record.snapshot.updatedAt = this.now();
    }
  }

  private markClosed(instanceId: string): void {
    const record = this.instances.get(instanceId);
    if (!record || record.snapshot.status === 'closed') return;
    const closedAt = this.now();
    record.snapshot.status = 'closed';
    record.snapshot.closedAt = closedAt;
    record.snapshot.updatedAt = closedAt;
    record.detachClosed?.();
    record.detachClosed = undefined;
  }
}
