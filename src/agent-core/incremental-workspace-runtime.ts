import crypto from 'node:crypto';
import path from 'node:path';
import type { OperationAfterSnapshot, PrepareOperationInput } from './operation-journal';
import type { OperationJournalRecord, OperationSnapshot } from './contracts';
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

export type IncrementalDeleteFileResult = {
  operationId: string;
  path: string;
  before: string;
  beforeHash: string;
  rollbackRef: string;
};

export type IncrementalRenameFileInspection = {
  from: IncrementalWriteFileInspection;
  to: string;
};

export type IncrementalRenameFileResult = {
  operationId: string;
  from: string;
  to: string;
  content: string;
  hash: string;
  rollbackRef: string;
  createdDirectories: string[];
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

  async inspectRenameFile(projectId: string, requestedFrom: string, requestedTo: string): Promise<IncrementalRenameFileInspection> {
    const from = await this.inspectWriteFile(projectId, requestedFrom);
    const to = await this.workspace.canonicalRelativePath(projectId, requestedTo);
    if (from.path.toLowerCase() === to.toLowerCase()) throw new Error('A origem e o destino da renomeação são equivalentes.');
    const destination = await this.workspace.statPath(projectId, to);
    if (destination.exists) throw new Error('O destino da renomeação já existe.');
    return { from, to };
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

  async rollbackCreatedFile(operationId: string): Promise<void> {
    await this.removeCreatedResources(operationId, 'workspace.create_file');
  }

  async rollbackCreatedFolder(operationId: string): Promise<void> {
    await this.removeCreatedResources(operationId, 'workspace.create_folder');
  }

  async restoreWrittenFile(operationId: string): Promise<void> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para restauração.');
    const record = this.requireVerifiedOperation(operationId, 'workspace.write_file');
    const resource = record.resources.find((item) => item.target.toLowerCase() === record.target.toLowerCase());
    if (!resource?.rollbackRef || !resource.before.hash || resource.before.kind !== 'file' || resource.before.exists !== true || !resource.after?.hash) {
      throw new Error('Metadados de rollback do write_file estão incompletos.');
    }

    const current = await this.snapshot(record.projectId, record.target);
    if (!current.exists || current.kind !== 'file' || current.hash !== resource.after.hash) {
      await this.recordRollbackConflict(record, 'O arquivo foi alterado externamente após write_file.');
      throw new Error(`O arquivo '${record.target}' mudou após write_file; rollback bloqueado.`);
    }

    const backup = await this.rollbackBlobs.getText(resource.rollbackRef);
    const backupHash = crypto.createHash('sha256').update(backup, 'utf8').digest('hex');
    if (backupHash !== resource.before.hash) {
      await this.recordRollbackConflict(record, 'O snapshot criptografado do write_file não corresponde ao hash anterior.');
      throw new Error('O snapshot de rollback do write_file falhou na verificação; rollback bloqueado.');
    }

    try {
      await this.workspace.writeFile(record.projectId, record.target, backup);
      const restored = await this.snapshot(record.projectId, record.target);
      if (!restored.exists || restored.kind !== 'file' || restored.hash !== resource.before.hash) {
        throw new Error('O rollback de write_file não restaurou o conteúdo anterior.');
      }
      await this.journal.markRolledBack(operationId, [{ target: record.target, after: restored }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordRollbackConflict(record, message);
      throw error;
    }
  }

  async deleteFile(
    context: IncrementalMutationContext,
    requestedPath: string,
    expectedBefore?: string,
  ): Promise<IncrementalDeleteFileResult> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para delete_file incremental.');
    const inspected = await this.inspectWriteFile(context.projectId, requestedPath);
    if (expectedBefore !== undefined && inspected.content !== expectedBefore) {
      throw new Error(`O arquivo '${inspected.path}' mudou antes da exclusão incremental.`);
    }

    const rollbackRef = await this.rollbackBlobs.putText(inspected.content);
    const beforeSnapshot: OperationSnapshot = {
      ...inspected.snapshot,
      contentRef: rollbackRef,
    };
    const prepared = await this.journal.prepare({
      ...context,
      capabilityId: 'workspace.delete_file',
      target: inspected.path,
      resources: [{
        target: inspected.path,
        before: beforeSnapshot,
        rollbackRef,
      }],
    });
    await this.journal.start(prepared.operationId);

    try {
      await this.workspace.deleteFile(context.projectId, inspected.path);
      const after = await this.afterSnapshots(context.projectId, [inspected.path]);
      if (after[0]?.after.exists !== false) throw new Error('A verificação pós-exclusão encontrou o arquivo ainda presente.');
      const verified = await this.journal.verify(prepared.operationId, after);
      return {
        operationId: verified.operationId,
        path: inspected.path,
        before: inspected.content,
        beforeHash: inspected.snapshot.hash ?? '',
        rollbackRef,
      };
    } catch (error) {
      await this.recordFailure(prepared.operationId, context.projectId, [inspected.path], error);
      throw error;
    }
  }

  async restoreDeletedFile(operationId: string): Promise<void> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para restauração.');
    const record = this.journal.get(operationId);
    if (!record) throw new Error(`Operação de exclusão não encontrada: ${operationId}.`);
    if (record.capabilityId !== 'workspace.delete_file') throw new Error('A operação não representa delete_file.');
    if (record.status !== 'verified') throw new Error(`A operação ${operationId} não está pronta para rollback.`);

    const resource = record.resources.find((item) => item.target.toLowerCase() === record.target.toLowerCase());
    if (!resource?.rollbackRef || resource.before.kind !== 'file' || resource.before.exists !== true) {
      throw new Error('Metadados de rollback do arquivo excluído estão incompletos.');
    }

    const current = await this.workspace.statPath(record.projectId, record.target);
    if (current.exists) {
      await this.journal.markRollbackConflict(operationId, 'O caminho foi recriado externamente após a exclusão.', [{
        target: record.target,
        after: await this.snapshot(record.projectId, record.target),
      }]);
      throw new Error(`O arquivo '${record.target}' foi recriado após a exclusão; rollback bloqueado.`);
    }

    const parent = normalizedRelativePath(path.dirname(record.target));
    if (parent !== '.') {
      const parentState = await this.workspace.statPath(record.projectId, parent);
      if (!parentState.exists || parentState.kind !== 'directory') {
        await this.journal.markRollbackConflict(operationId, 'O diretório pai não existe mais para restauração segura.');
        throw new Error(`O diretório pai de '${record.target}' não existe mais; rollback bloqueado.`);
      }
    }

    const content = await this.rollbackBlobs.getText(resource.rollbackRef);
    try {
      await this.workspace.createFile(record.projectId, record.target, content);
      const restored = await this.snapshot(record.projectId, record.target);
      if (!restored.exists || restored.kind !== 'file' || restored.hash !== resource.before.hash) {
        throw new Error('O arquivo restaurado não corresponde ao snapshot anterior.');
      }
      await this.journal.markRolledBack(operationId, [{ target: record.target, after: restored }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = await this.afterSnapshots(record.projectId, [record.target]).catch((): OperationAfterSnapshot[] => []);
      await this.journal.markRollbackConflict(operationId, message, state).catch((): undefined => undefined);
      throw error;
    }
  }

  async renameFile(
    context: IncrementalMutationContext,
    requestedFrom: string,
    requestedTo: string,
    expectedBefore?: string,
  ): Promise<IncrementalRenameFileResult> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para rename_file incremental.');
    const inspected = await this.inspectRenameFile(context.projectId, requestedFrom, requestedTo);
    if (expectedBefore !== undefined && inspected.from.content !== expectedBefore) {
      throw new Error(`O arquivo '${inspected.from.path}' mudou antes da renomeação incremental.`);
    }

    const rollbackRef = await this.rollbackBlobs.putText(inspected.from.content);
    const destinationParent = normalizedRelativePath(path.dirname(inspected.to));
    const directoryResources = destinationParent === '.'
      ? []
      : await this.missingDirectoryResources(context.projectId, destinationParent);
    const resources: PrepareOperationInput['resources'] = [
      ...directoryResources,
      {
        target: inspected.from.path,
        before: { ...inspected.from.snapshot, contentRef: rollbackRef },
        rollbackRef: `restore-renamed-source:${inspected.from.path}`,
      },
      {
        target: inspected.to,
        before: { exists: false, kind: 'file' },
        rollbackRef: `remove-renamed-destination:${inspected.to}`,
      },
    ];

    const prepared = await this.journal.prepare({
      ...context,
      capabilityId: 'workspace.rename_file',
      target: inspected.to,
      resources,
    });
    await this.journal.start(prepared.operationId);

    try {
      await this.workspace.renameFile(context.projectId, inspected.from.path, inspected.to);
      const after = await this.afterSnapshots(context.projectId, resources.map((resource) => resource.target));
      const sourceAfter = after.find((item) => item.target.toLowerCase() === inspected.from.path.toLowerCase())?.after;
      const destinationAfter = after.find((item) => item.target.toLowerCase() === inspected.to.toLowerCase())?.after;
      if (sourceAfter?.exists !== false) throw new Error('A origem ainda existe após a renomeação.');
      if (!destinationAfter?.exists || destinationAfter.kind !== 'file' || destinationAfter.hash !== inspected.from.snapshot.hash) {
        throw new Error('O destino da renomeação não corresponde ao arquivo de origem.');
      }
      const verified = await this.journal.verify(prepared.operationId, after);
      return {
        operationId: verified.operationId,
        from: inspected.from.path,
        to: inspected.to,
        content: inspected.from.content,
        hash: inspected.from.snapshot.hash ?? '',
        rollbackRef,
        createdDirectories: directoryResources.map((resource) => resource.target),
      };
    } catch (error) {
      await this.recordFailure(prepared.operationId, context.projectId, resources.map((resource) => resource.target), error);
      throw error;
    }
  }

  async restoreRenamedFile(operationId: string): Promise<void> {
    if (!this.rollbackBlobs) throw new Error('RollbackBlobStore não foi configurado para restauração.');
    const record = this.journal.get(operationId);
    if (!record) throw new Error(`Operação de renomeação não encontrada: ${operationId}.`);
    if (record.capabilityId !== 'workspace.rename_file') throw new Error('A operação não representa rename_file.');
    if (record.status !== 'verified') throw new Error(`A operação ${operationId} não está pronta para rollback.`);

    const destination = record.resources.find((resource) => resource.target.toLowerCase() === record.target.toLowerCase());
    const source = record.resources.find((resource) => (
      resource.before.exists === true
      && resource.before.kind === 'file'
      && resource.target.toLowerCase() !== record.target.toLowerCase()
    ));
    const createdDirectories = record.resources.filter((resource) => resource.before.exists === false && resource.before.kind === 'directory');
    if (!source?.rollbackRef || !source.before.hash || !source.before.contentRef || !destination || destination.before.exists !== false) {
      throw new Error('Metadados de rollback da renomeação estão incompletos.');
    }

    const sourceNow = await this.workspace.statPath(record.projectId, source.target);
    if (sourceNow.exists) {
      await this.journal.markRollbackConflict(operationId, 'A origem foi recriada externamente após a renomeação.', await this.afterSnapshots(record.projectId, record.resources.map((item) => item.target)));
      throw new Error(`A origem '${source.target}' foi recriada; rollback bloqueado.`);
    }

    const destinationNow = await this.snapshot(record.projectId, destination.target);
    if (!destinationNow.exists || destinationNow.kind !== 'file' || destinationNow.hash !== source.before.hash) {
      await this.journal.markRollbackConflict(operationId, 'O destino foi alterado ou removido após a renomeação.', await this.afterSnapshots(record.projectId, record.resources.map((item) => item.target)));
      throw new Error(`O destino '${destination.target}' mudou; rollback bloqueado.`);
    }

    const backup = await this.rollbackBlobs.getText(source.before.contentRef);
    const backupHash = crypto.createHash('sha256').update(backup, 'utf8').digest('hex');
    if (backupHash !== source.before.hash) {
      await this.journal.markRollbackConflict(operationId, 'O snapshot criptografado da origem não corresponde ao hash anterior.');
      throw new Error('O snapshot criptografado da renomeação falhou na verificação; rollback bloqueado.');
    }

    for (const directory of createdDirectories) {
      const names = await this.workspace.listDirectoryNames(record.projectId, directory.target);
      const prefix = `${directory.target.replace(/\/$/, '')}/`;
      const expectedNames = new Set<string>();
      for (const resource of record.resources) {
        if (!resource.target.startsWith(prefix)) continue;
        const remainder = resource.target.slice(prefix.length);
        const first = remainder.split('/')[0];
        if (first) expectedNames.add(first);
      }
      if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name))) {
        await this.journal.markRollbackConflict(operationId, `A pasta '${directory.target}' recebeu conteúdo externo após a renomeação.`, await this.afterSnapshots(record.projectId, record.resources.map((item) => item.target)));
        throw new Error(`A pasta '${directory.target}' mudou; rollback bloqueado.`);
      }
    }

    try {
      await this.workspace.renameFile(record.projectId, destination.target, source.target);
      for (const directory of [...createdDirectories].sort((left, right) => right.target.length - left.target.length)) {
        await this.workspace.removeEmptyFolder(record.projectId, directory.target);
      }
      const after = await this.afterSnapshots(record.projectId, record.resources.map((item) => item.target));
      const restoredSource = after.find((item) => item.target.toLowerCase() === source.target.toLowerCase())?.after;
      const removedDestination = after.find((item) => item.target.toLowerCase() === destination.target.toLowerCase())?.after;
      if (!restoredSource?.exists || restoredSource.kind !== 'file' || restoredSource.hash !== source.before.hash || removedDestination?.exists !== false) {
        throw new Error('O rollback da renomeação não restaurou o estado anterior.');
      }
      await this.journal.markRolledBack(operationId, after);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = await this.afterSnapshots(record.projectId, record.resources.map((item) => item.target)).catch((): OperationAfterSnapshot[] => []);
      await this.journal.markRollbackConflict(operationId, message, state).catch((): undefined => undefined);
      throw error;
    }
  }

  private requireVerifiedOperation(operationId: string, capabilityId: string): OperationJournalRecord {
    const record = this.journal.get(operationId);
    if (!record) throw new Error(`Operação não encontrada para rollback: ${operationId}.`);
    if (record.capabilityId !== capabilityId) throw new Error(`A operação não representa ${capabilityId}.`);
    if (record.status !== 'verified') throw new Error(`A operação ${operationId} não está pronta para rollback.`);
    return record;
  }

  private async removeCreatedResources(operationId: string, capabilityId: 'workspace.create_file' | 'workspace.create_folder'): Promise<void> {
    const record = this.requireVerifiedOperation(operationId, capabilityId);
    if (!record.resources.length || record.resources.some((resource) => resource.before.exists !== false || !resource.rollbackRef)) {
      throw new Error('Metadados de rollback da criação estão incompletos.');
    }

    const files = record.resources.filter((resource) => resource.before.kind === 'file');
    const directories = record.resources.filter((resource) => resource.before.kind === 'directory');
    if (capabilityId === 'workspace.create_file' && files.length !== 1) throw new Error('create_file precisa registrar exatamente um arquivo criado.');
    if (capabilityId === 'workspace.create_folder' && files.length !== 0) throw new Error('create_folder não pode registrar arquivo criado.');

    for (const resource of record.resources) {
      const current = await this.snapshot(record.projectId, resource.target);
      if (resource.before.kind === 'file') {
        if (!current.exists || current.kind !== 'file' || !resource.after?.hash || current.hash !== resource.after.hash) {
          await this.recordRollbackConflict(record, `O arquivo criado '${resource.target}' foi alterado ou removido externamente.`);
          throw new Error(`O arquivo criado '${resource.target}' mudou; rollback bloqueado.`);
        }
      } else if (resource.before.kind === 'directory') {
        if (!current.exists || current.kind !== 'directory') {
          await this.recordRollbackConflict(record, `A pasta criada '${resource.target}' foi alterada ou removida externamente.`);
          throw new Error(`A pasta criada '${resource.target}' mudou; rollback bloqueado.`);
        }
      } else {
        throw new Error(`Tipo de recurso criado desconhecido para '${resource.target}'.`);
      }
    }

    for (const directory of directories) {
      const names = await this.workspace.listDirectoryNames(record.projectId, directory.target);
      const expectedNames = new Set<string>();
      const prefix = `${directory.target.replace(/\/$/, '')}/`;
      for (const resource of record.resources) {
        if (!resource.target.startsWith(prefix)) continue;
        const remainder = resource.target.slice(prefix.length);
        const first = remainder.split('/')[0];
        if (first) expectedNames.add(first);
      }
      if (names.length !== expectedNames.size || names.some((name) => !expectedNames.has(name))) {
        await this.recordRollbackConflict(record, `A pasta criada '${directory.target}' recebeu conteúdo externo.`);
        throw new Error(`A pasta criada '${directory.target}' recebeu conteúdo externo; rollback bloqueado.`);
      }
    }

    try {
      for (const file of files) await this.workspace.deleteFile(record.projectId, file.target);
      for (const directory of [...directories].sort((left, right) => right.target.length - left.target.length)) {
        await this.workspace.removeEmptyFolder(record.projectId, directory.target);
      }
      const after = await this.afterSnapshots(record.projectId, record.resources.map((resource) => resource.target));
      if (after.some((item) => item.after.exists)) throw new Error('O rollback da criação deixou recursos materializados.');
      await this.journal.markRolledBack(operationId, after);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordRollbackConflict(record, message);
      throw error;
    }
  }

  private async recordRollbackConflict(record: OperationJournalRecord, message: string): Promise<void> {
    const state = await this.afterSnapshots(record.projectId, record.resources.map((resource) => resource.target)).catch((): OperationAfterSnapshot[] => []);
    await this.journal.markRollbackConflict(record.operationId, message, state).catch((): undefined => undefined);
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
