import path from 'node:path';
import type { FileDiff } from '../ai/types';
import { DiffRuntime } from './diff-runtime';

export interface ShadowWorkspaceBase {
  exists(projectId: string, requestedPath: string): Promise<boolean>;
  readFile(projectId: string, requestedPath: string): Promise<string>;
  writeFile(projectId: string, requestedPath: string, content: string): Promise<void>;
  createFile(projectId: string, requestedPath: string, content: string): Promise<void>;
  deleteFile(projectId: string, requestedPath: string): Promise<void>;
  renameFile(projectId: string, from: string, to: string): Promise<void>;
  searchFiles(projectId: string, query: string): Promise<string[]>;
}

export type ShadowWorkspaceStatus = 'active' | 'committed' | 'discarded';

export type ShadowWorkspaceSnapshot = {
  chatId: string;
  runId: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  status: ShadowWorkspaceStatus;
  changes: FileDiff[];
};

type BaselineState = {
  path: string;
  exists: boolean;
  content?: string;
};

type OverlayState = {
  path: string;
  exists: boolean;
  content?: string;
};

type RestoredState = {
  createdAt: number;
  updatedAt: number;
  changes: FileDiff[];
  baselines: Map<string, BaselineState>;
  overlay: Map<string, OverlayState>;
};

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} inválido.`);
  return value.trim();
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error('Caminho inválido para Shadow Workspace.');
  }
  return normalized;
}

function pathKey(value: string): string {
  return normalizePath(value).toLowerCase();
}

function cloneChanges(changes: FileDiff[]): FileDiff[] {
  return changes.map((change) => ({ ...change }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} inválido para Shadow Workspace.`);
  return value;
}

function validatedDiff(change: FileDiff, diffs: DiffRuntime): FileDiff {
  if (!change || typeof change !== 'object') throw new Error('Alteração inválida no Shadow Workspace.');
  if (!['created', 'modified', 'deleted', 'renamed'].includes(change.type)) throw new Error('Tipo de alteração inválido no Shadow Workspace.');
  const normalizedPath = normalizePath(change.path);
  if (typeof change.before !== 'string' || typeof change.after !== 'string') throw new Error('Conteúdo inválido no Shadow Workspace.');
  const renamedFrom = change.type === 'renamed' ? normalizePath(change.renamedFrom as string) : undefined;
  if (change.type === 'renamed' && (!change.renamedFrom || pathKey(renamedFrom as string) === pathKey(normalizedPath))) throw new Error('Renomeação inválida no Shadow Workspace.');
  if (change.type !== 'renamed' && change.renamedFrom !== undefined) throw new Error('Somente renomeações podem informar origem no Shadow Workspace.');
  const rebuilt = diffs.create(normalizedPath, change.type, change.before, change.after, renamedFrom);
  if (rebuilt.addedLines !== change.addedLines || rebuilt.removedLines !== change.removedLines) throw new Error('Contagem de linhas inválida no Shadow Workspace.');
  return rebuilt;
}

function restoreState(snapshot: ShadowWorkspaceSnapshot, diffs: DiffRuntime): RestoredState {
  const createdAt = assertTimestamp(snapshot.createdAt, 'Data de criação');
  const updatedAt = assertTimestamp(snapshot.updatedAt, 'Data de atualização');
  if (updatedAt < createdAt) throw new Error('Data de atualização anterior à criação do Shadow Workspace.');
  if (snapshot.status !== 'active') throw new Error('Somente Shadow Workspaces ativos podem ser restaurados.');
  if (!Array.isArray(snapshot.changes)) throw new Error('Lista de alterações inválida no Shadow Workspace.');

  const baselines = new Map<string, BaselineState>();
  const overlay = new Map<string, OverlayState>();
  const changes: FileDiff[] = [];

  const seed = (requestedPath: string, exists: boolean, content?: string): OverlayState => {
    const normalized = normalizePath(requestedPath);
    const key = pathKey(normalized);
    const current = overlay.get(key);
    if (current) {
      if (current.exists !== exists || (exists && current.content !== content)) throw new Error(`Sequência inconsistente no Shadow Workspace para '${normalized}'.`);
      return current;
    }
    const baseline: BaselineState = exists ? { path: normalized, exists: true, content } : { path: normalized, exists: false };
    const state: OverlayState = exists ? { path: normalized, exists: true, content } : { path: normalized, exists: false };
    baselines.set(key, baseline);
    overlay.set(key, state);
    return state;
  };

  for (const rawChange of snapshot.changes) {
    const change = validatedDiff(rawChange, diffs);
    if (change.type === 'created') {
      seed(change.path, false);
      overlay.set(pathKey(change.path), { path: change.path, exists: true, content: change.after });
    } else if (change.type === 'modified') {
      seed(change.path, true, change.before);
      overlay.set(pathKey(change.path), { path: change.path, exists: true, content: change.after });
    } else if (change.type === 'deleted') {
      seed(change.path, true, change.before);
      overlay.set(pathKey(change.path), { path: change.path, exists: false });
    } else {
      const source = change.renamedFrom as string;
      seed(source, true, change.before);
      seed(change.path, false);
      overlay.set(pathKey(source), { path: source, exists: false });
      overlay.set(pathKey(change.path), { path: change.path, exists: true, content: change.after });
    }
    changes.push(change);
  }

  return { createdAt, updatedAt, changes, baselines, overlay };
}

export class ShadowWorkspaceTransaction implements ShadowWorkspaceBase {
  private readonly baselines = new Map<string, BaselineState>();
  private readonly overlay = new Map<string, OverlayState>();
  private readonly changes: FileDiff[] = [];
  private status: ShadowWorkspaceStatus = 'active';
  private updatedAt: number;

  readonly chatId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly createdAt: number;

  constructor(
    private readonly base: ShadowWorkspaceBase,
    input: { chatId: string; runId: string; projectId: string },
    private readonly diffs = new DiffRuntime(),
    private readonly now: () => number = () => Date.now(),
    restored?: RestoredState,
  ) {
    this.chatId = requireId(input.chatId, 'Chat');
    this.runId = requireId(input.runId, 'Execução');
    this.projectId = requireId(input.projectId, 'Projeto');
    if (restored) {
      this.createdAt = restored.createdAt;
      this.updatedAt = restored.updatedAt;
      for (const [key, value] of restored.baselines) this.baselines.set(key, { ...value });
      for (const [key, value] of restored.overlay) this.overlay.set(key, { ...value });
      this.changes.push(...cloneChanges(restored.changes));
      return;
    }
    this.createdAt = assertTimestamp(this.now(), 'Relógio');
    this.updatedAt = this.createdAt;
  }

  static restore(
    base: ShadowWorkspaceBase,
    snapshot: ShadowWorkspaceSnapshot,
    diffs = new DiffRuntime(),
    now: () => number = () => Date.now(),
  ): ShadowWorkspaceTransaction {
    const identity = {
      chatId: requireId(snapshot.chatId, 'Chat'),
      runId: requireId(snapshot.runId, 'Execução'),
      projectId: requireId(snapshot.projectId, 'Projeto'),
    };
    const restored = restoreState(snapshot, diffs);
    const current = assertTimestamp(now(), 'Relógio');
    if (current < restored.updatedAt) throw new Error('Relógio anterior ao snapshot do Shadow Workspace.');
    return new ShadowWorkspaceTransaction(base, identity, diffs, now, restored);
  }

  snapshot(): ShadowWorkspaceSnapshot {
    return {
      chatId: this.chatId,
      runId: this.runId,
      projectId: this.projectId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      status: this.status,
      changes: cloneChanges(this.changes),
    };
  }

  listChanges(): FileDiff[] {
    return cloneChanges(this.changes);
  }

  async exists(projectId: string, requestedPath: string): Promise<boolean> {
    this.assertProject(projectId);
    const normalized = normalizePath(requestedPath);
    const current = this.overlay.get(pathKey(normalized));
    if (current) return current.exists;
    return this.base.exists(this.projectId, normalized);
  }

  async readFile(projectId: string, requestedPath: string): Promise<string> {
    this.assertProject(projectId);
    const normalized = normalizePath(requestedPath);
    const current = this.overlay.get(pathKey(normalized));
    if (current) {
      if (!current.exists || current.content === undefined) throw new Error('O arquivo não existe no Shadow Workspace.');
      return current.content;
    }
    return this.base.readFile(this.projectId, normalized);
  }

  async writeFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    this.assertActive();
    this.assertProject(projectId);
    const normalized = normalizePath(requestedPath);
    if (!(await this.exists(this.projectId, normalized))) throw new Error('O arquivo não existe. Use createFile para criar um arquivo novo.');
    const before = await this.readFile(this.projectId, normalized);
    await this.captureBaseline(normalized);
    this.overlay.set(pathKey(normalized), { path: normalized, exists: true, content });
    this.changes.push(this.diffs.create(normalized, 'modified', before, content));
    this.touch();
  }

  async createFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    this.assertActive();
    this.assertProject(projectId);
    const normalized = normalizePath(requestedPath);
    if (await this.exists(this.projectId, normalized)) throw new Error('O arquivo já existe no Shadow Workspace.');
    await this.captureBaseline(normalized);
    this.overlay.set(pathKey(normalized), { path: normalized, exists: true, content });
    this.changes.push(this.diffs.create(normalized, 'created', '', content));
    this.touch();
  }

  async deleteFile(projectId: string, requestedPath: string): Promise<void> {
    this.assertActive();
    this.assertProject(projectId);
    const normalized = normalizePath(requestedPath);
    if (!(await this.exists(this.projectId, normalized))) throw new Error('O arquivo não existe no Shadow Workspace.');
    const before = await this.readFile(this.projectId, normalized);
    await this.captureBaseline(normalized);
    this.overlay.set(pathKey(normalized), { path: normalized, exists: false });
    this.changes.push(this.diffs.create(normalized, 'deleted', before, ''));
    this.touch();
  }

  async renameFile(projectId: string, from: string, to: string): Promise<void> {
    this.assertActive();
    this.assertProject(projectId);
    const source = normalizePath(from);
    const destination = normalizePath(to);
    if (pathKey(source) === pathKey(destination)) throw new Error('Origem e destino da renomeação são iguais.');
    if (!(await this.exists(this.projectId, source))) throw new Error('O arquivo de origem não existe no Shadow Workspace.');
    if (await this.exists(this.projectId, destination)) throw new Error('O destino já existe no Shadow Workspace.');
    const content = await this.readFile(this.projectId, source);
    await this.captureBaseline(source);
    await this.captureBaseline(destination);
    this.overlay.set(pathKey(source), { path: source, exists: false });
    this.overlay.set(pathKey(destination), { path: destination, exists: true, content });
    this.changes.push(this.diffs.create(destination, 'renamed', content, content, source));
    this.touch();
  }

  async searchFiles(projectId: string, query: string): Promise<string[]> {
    this.assertProject(projectId);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) throw new Error('A busca precisa conter um texto.');
    const result = new Map<string, string>();
    for (const item of await this.base.searchFiles(this.projectId, query)) result.set(pathKey(item), item);
    for (const state of this.overlay.values()) {
      const key = pathKey(state.path);
      if (!state.exists) {
        result.delete(key);
        continue;
      }
      if (path.basename(state.path).toLowerCase().includes(normalizedQuery)) result.set(key, state.path);
      else result.delete(key);
    }
    return [...result.values()].sort((left, right) => left.localeCompare(right));
  }

  async commit(): Promise<ShadowWorkspaceSnapshot> {
    this.assertActive();
    await this.assertBaseUnchanged();
    const applied: FileDiff[] = [];
    try {
      for (const change of this.changes) {
        await this.applyChange(change);
        applied.push(change);
      }
    } catch (error) {
      const compensationErrors: string[] = [];
      for (const change of [...applied].reverse()) {
        try {
          await this.undoChange(change);
        } catch (compensationError) {
          compensationErrors.push(`${change.path}: ${errorMessage(compensationError)}`);
        }
      }
      if (compensationErrors.length) {
        throw new Error(`Falha ao publicar Shadow Workspace (${errorMessage(error)}) e a compensação também falhou: ${compensationErrors.join('; ')}`);
      }
      throw new Error(`Falha ao publicar Shadow Workspace (${errorMessage(error)}). O workspace real foi recomposto.`);
    }
    this.status = 'committed';
    this.touch();
    return this.snapshot();
  }

  discard(): ShadowWorkspaceSnapshot {
    this.assertActive();
    this.status = 'discarded';
    this.touch();
    return this.snapshot();
  }

  private assertProject(projectId: string): void {
    if (requireId(projectId, 'Projeto') !== this.projectId) throw new Error('Shadow Workspace pertence a outro projeto.');
  }

  private assertActive(): void {
    if (this.status !== 'active') throw new Error('Shadow Workspace não está mais ativo.');
  }

  private touch(): void {
    const value = assertTimestamp(this.now(), 'Relógio');
    if (value < this.updatedAt) throw new Error('Relógio inválido para Shadow Workspace.');
    this.updatedAt = value;
  }

  private async captureBaseline(requestedPath: string): Promise<void> {
    const normalized = normalizePath(requestedPath);
    const key = pathKey(normalized);
    if (this.baselines.has(key)) return;
    const exists = await this.base.exists(this.projectId, normalized);
    this.baselines.set(key, exists
      ? { path: normalized, exists: true, content: await this.base.readFile(this.projectId, normalized) }
      : { path: normalized, exists: false });
  }

  private async assertBaseUnchanged(): Promise<void> {
    for (const baseline of this.baselines.values()) {
      const exists = await this.base.exists(this.projectId, baseline.path);
      if (exists !== baseline.exists) throw new Error(`Publicação bloqueada: '${baseline.path}' mudou fora do Shadow Workspace.`);
      if (exists && (await this.base.readFile(this.projectId, baseline.path)) !== baseline.content) {
        throw new Error(`Publicação bloqueada: '${baseline.path}' mudou fora do Shadow Workspace.`);
      }
    }
  }

  private async applyChange(change: FileDiff): Promise<void> {
    if (change.type === 'created') {
      await this.base.createFile(this.projectId, change.path, change.after);
      return;
    }
    if (change.type === 'modified') {
      await this.base.writeFile(this.projectId, change.path, change.after);
      return;
    }
    if (change.type === 'deleted') {
      await this.base.deleteFile(this.projectId, change.path);
      return;
    }
    await this.base.renameFile(this.projectId, change.renamedFrom as string, change.path);
    if (change.before !== change.after) await this.base.writeFile(this.projectId, change.path, change.after);
  }

  private async undoChange(change: FileDiff): Promise<void> {
    if (change.type === 'created') {
      await this.base.deleteFile(this.projectId, change.path);
      return;
    }
    if (change.type === 'modified') {
      await this.base.writeFile(this.projectId, change.path, change.before);
      return;
    }
    if (change.type === 'deleted') {
      await this.base.createFile(this.projectId, change.path, change.before);
      return;
    }
    await this.base.renameFile(this.projectId, change.path, change.renamedFrom as string);
    if (change.before !== change.after) await this.base.writeFile(this.projectId, change.renamedFrom as string, change.before);
  }
}
