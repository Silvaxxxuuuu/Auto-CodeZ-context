import crypto from 'node:crypto';
import path from 'node:path';
import type { OperationAfterSnapshot, PrepareOperationInput } from './operation-journal';
import type { OperationSnapshot } from './contracts';
import type { DurableOperationJournal } from './operation-journal-store';
import type { RollbackBlobStore } from './rollback-blob-store';
import type { WorkspacePathStat } from '../agent/workspace-runtime';
import { WorkspaceRuntime } from '../agent/workspace-runtime';

export type IncrementalMutationContext = {
  runId: string;
  toolCallId: string;
  projectId: string;
};

export type IncrementalCreateFileResult = {
  operationId: string;
  path: string;
  hash: string;
  bytes: number;
  createdDirectories: string[];
};

export type IncrementalCreateFolderResult = {
  operationId?: string;
  path: string;
  created: boolean;
  createdDirectories: string[];
};

export type IncrementalWriteFileInspection = {
  path: string;
  content: string;
  snapshot: OperationSnapshot;
};

export type IncrementalWriteFileResult = {
  operationId: string;
  path: string;
  before: string;
  after: string;
  beforeHash: string;
  afterHash: string;
  bytes: number;
  rollbackRef: string;
};

function normalizedRelativePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function rollbackRef(target: string, kind: 'file' | 'directory'): string {
  return kind === 'file'
    ? `delete-if-unchanged:${target}`
    : `remove-if-empty:${target}`;
}

export class IncrementalWorkspaceMutationRuntime {
  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly journal: DurableOperationJournal,
    private readonly rollbackBlobs?: Pick<RollbackBlobStore, 'putText' | 'getText'>,
  ) {}

  async inspectCreateFolder(projectId: string, requestedPath: string): Promise<{ path: string; exists: boolean }> {
    const target = await this.workspace.canonicalRelativePath(projectId, requestedPath);
    const existing = await this.workspace.statPath(projectId, target);
    if (existing.exists && existing.kind !== 'directory') throw new Error('Já existe um arquivo no caminho da pasta.');
    return { path: target, exists: existing.exists };
  }

  async inspectCreateFile(projectId: string, requestedPath: string): Promise<string> {
    const target = await this.workspace.canonicalRelativePath(projectId, requestedPath);
    const existing = await this.workspace.statPath(projectId, target);
    if (existing.exists) throw new Error('O arquivo já existe. Use write_file para substituí-lo.');
    return target;
  }

  async inspectWriteFile(projectId: string, requestedPath: string): Promise<IncrementalWriteFileInspection> {
    const target = await this.workspace.canonicalRelativePath(projectId, requestedPath);
    const stat = await this.workspace.statPath(projectId, target);
    if (!stat.exists) throw new Error('O arquivo não existe. Use create_file para criar um arquivo novo.');
    if (stat.kind !== 'file') throw new Error('write_file exige um arquivo regular.');
    const content = await this.workspace.readFile(projectId, target);
    return {
      path: target,
      content,
      snapshot: {
        exists: true,
        kind: 'file',
        hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
        size: Buffer.byteLength(content, 'utf8'),
        modifiedAt: stat.modifiedAt,
      },
    };
  }

  async createFolder(
    context: IncrementalMutationContext,
    requestedPath: string,
  ): Promise<IncrementalCreateFolderResult> {
    const inspected = await this.inspectCreateFolder(context.projectId, requestedPath);
    const target = inspected.path;
    if (inspected.exists) {
      return { path: target, created: false, createdDirectories: [] };
    }

    const directoryResources = await this.missingDirectoryResources(context.projectId, target);
    const prepared = await this.journal.prepare({
      ...context,
      capabilityId: 'workspace.create_folder',
      target,
      resources: directoryResources,
    });
    await this.journal.start(prepared.operationId);

    try {
      await this.workspace.createFolder(context.projectId, target);
      const after = await this.afterSnapshots(context.projectId, prepared.resources.map((resource) => resource.target));
      const verified = await this.journal.verify(prepared.operationId, after);
      return {
        operationId: verified.operationId,
        path: target,
        created: true,
        createdDirectories: prepared.resources.map((resource) => resource.target),
      };
    } catch (error) {
      await this.recordFailure(prepared.operationId, context.projectId, prepared.resources.map((resource) => resource.target), error);
      throw error;
    }
  }

  async createFile(
    context: IncrementalMutationContext,
    requestedPath: string,
    content: string,
  ): Promise<IncrementalCreateFileResult> {
    const target = await this.inspectCreateFile(context.projectId, requestedPath);

    const parent = normalizedRelativePath(path.dirname(target));
    const directoryResources = parent === '.'
      ? []
      : await this.missingDirectoryResources(context.projectId, parent);
    const resources: PrepareOperationInput['resources'] = [
      ...directoryResources,
      {
        target,
        before: { exists: false, kind: 'file' },
        rollbackRef: rollbackRef(target, 'file'),
      },
    ];

    const prepared = await this.journal.prepare({
      ...context,
      capabilityId: 'workspace.create_file',
      target,
      resources,
    });
    await this.journal.start(prepared.operationId);

    try {
      await this.workspace.createFile(context.projectId, target, content);
      const after = await this.afterSnapshots(context.projectId, resources.map((resource) => resource.target));
      const fileAfter = after.find((item) => item.target.toLowerCase() === target.toLowerCase())?.after;
      if (!fileAfter?.exists || fileAfter.kind !== 'file' || !fileAfter.hash) {
        throw new Error('A verificação do arquivo criado não produziu hash válido.');
      }
      const verified = await this.journal.verify(prepared.operationId, after);
      return {
        operationId: verified.operationId,
        path: target,
        hash: fileAfter.hash,
        bytes: fileAfter.size ?? Buffer.byteLength(content, 'utf8'),
        createdDirectories: directoryResources.map((resource) => resource.target),
      };
    } catch (error) {
      await this.recordFailure(prepared.operationId, context.projectId, resources.map((resource) => resource.target), error);
      throw error;
    }
  }

  async writeFile(
    context: IncrementalMutationContext,
    requestedPath: string,
    content: string,
    expectedBefore?: string,
  ): Promise<IncrementalWriteFileResult> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para write_file incremental.');
    const inspected = await this.inspectWriteFile(context.projectId, requestedPath);
    if (expectedBefore !== undefined && inspected.content !== expectedBefore) {
      throw new Error(`O arquivo '${inspected.path}' mudou antes da escrita incremental.`);
    }
    const rollbackRef = await this.rollbackBlobs.putText(inspected.content);
    const beforeSnapshot: OperationSnapshot = {
      ...inspected.snapshot,
      contentRef: rollbackRef,
    };

    const prepared = await this.journal.prepare({
      ...context,
      capabilityId: 'workspace.write_file',
      target: inspected.path,
      resources: [{
        target: inspected.path,
        before: beforeSnapshot,
        rollbackRef,
      }],
    });
    await this.journal.start(prepared.operationId);

    try {
      await this.workspace.writeFile(context.projectId, inspected.path, content);
      const after = await this.afterSnapshots(context.projectId, [inspected.path]);
      const fileAfter = after[0]?.after;
      if (!fileAfter?.exists || fileAfter.kind !== 'file' || !fileAfter.hash) {
        throw new Error('A verificação do arquivo atualizado não produziu hash válido.');
      }
      const verified = await this.journal.verify(prepared.operationId, after);
      return {
        operationId: verified.operationId,
        path: inspected.path,
        before: inspected.content,
        after: content,
        beforeHash: inspected.snapshot.hash ?? '',
        afterHash: fileAfter.hash,
        bytes: fileAfter.size ?? Buffer.byteLength(content, 'utf8'),
        rollbackRef,
      };
    } catch (error) {
      await this.recordFailure(prepared.operationId, context.projectId, [inspected.path], error);
      throw error;
    }
  }

  private async missingDirectoryResources(projectId: string, requestedDirectory: string): Promise<PrepareOperationInput['resources']> {
    const canonical = await this.workspace.canonicalRelativePath(projectId, requestedDirectory);
    if (canonical === '.') return [];
    const segments = canonical.split('/').filter(Boolean);
    const resources: PrepareOperationInput['resources'] = [];
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const stat = await this.workspace.statPath(projectId, current);
      if (stat.exists) {
        if (stat.kind !== 'directory') throw new Error(`O caminho '${current}' é um arquivo, não uma pasta.`);
        continue;
      }
      resources.push({
        target: current,
        before: { exists: false, kind: 'directory' },
        rollbackRef: rollbackRef(current, 'directory'),
      });
    }
    return resources;
  }

  private async snapshot(projectId: string, target: string): Promise<OperationSnapshot> {
    const stat = await this.workspace.statPath(projectId, target);
    if (!stat.exists) return { exists: false };
    if (stat.kind === 'directory') {
      return {
        exists: true,
        kind: 'directory',
        size: stat.size,
        modifiedAt: stat.modifiedAt,
      };
    }
    const content = await this.workspace.readFile(projectId, target);
    return {
      exists: true,
      kind: 'file',
      hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      size: Buffer.byteLength(content, 'utf8'),
      modifiedAt: stat.modifiedAt,
    };
  }

  private async afterSnapshots(projectId: string, targets: string[]): Promise<OperationAfterSnapshot[]> {
    const result: OperationAfterSnapshot[] = [];
    for (const target of targets) result.push({ target, after: await this.snapshot(projectId, target) });
    return result;
  }

  private async recordFailure(operationId: string, projectId: string, targets: string[], error: unknown): Promise<void> {
    let after: OperationAfterSnapshot[] = [];
    try {
      after = await this.afterSnapshots(projectId, targets);
    } catch {
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.journal.fail(operationId, message, after);
    } catch (journalError) {
      const detail = journalError instanceof Error ? journalError.message : String(journalError);
      throw new Error(`${message} O Operation Journal também não conseguiu registrar a falha: ${detail}`);
    }
  }
}
