import type { OperationJournalRecord } from './contracts';
import type { DurableOperationJournal } from './operation-journal-store';
import type { IncrementalWorkspaceMutationRuntime } from './incremental-workspace-runtime';

export type OperationRollbackResult = {
  operation: OperationJournalRecord;
  alreadyRolledBack: boolean;
};

export class OperationRollbackRuntime {
  constructor(
    private readonly journal: DurableOperationJournal,
    private readonly workspaceMutations: IncrementalWorkspaceMutationRuntime,
  ) {}

  get(operationId: string): OperationJournalRecord | undefined {
    return this.journal.get(operationId);
  }

  async rollback(operationId: string): Promise<OperationRollbackResult> {
    const id = operationId.trim();
    if (!id) throw new Error('Operation id inválido.');
    const record = this.journal.get(id);
    if (!record) throw new Error(`Operação não encontrada no Operation Journal: ${id}.`);
    if (record.status === 'rolled_back') return { operation: record, alreadyRolledBack: true };
    if (record.status === 'rollback_conflict') {
      throw new Error(`A operação ${id} possui conflito de rollback e exige revisão manual.`);
    }
    if (record.status !== 'verified') {
      throw new Error(`A operação ${id} não está pronta para rollback (status: ${record.status}).`);
    }

    switch (record.capabilityId) {
      case 'workspace.create_file':
        await this.workspaceMutations.rollbackCreatedFile(id);
        break;
      case 'workspace.create_folder':
        await this.workspaceMutations.rollbackCreatedFolder(id);
        break;
      case 'workspace.write_file':
        await this.workspaceMutations.restoreWrittenFile(id);
        break;
      case 'workspace.delete_file':
        await this.workspaceMutations.restoreDeletedFile(id);
        break;
      case 'workspace.rename_file':
        await this.workspaceMutations.restoreRenamedFile(id);
        break;
      default:
        throw new Error(`Rollback não suportado para a capability '${record.capabilityId}'.`);
    }

    const rolledBack = this.journal.get(id);
    if (!rolledBack || rolledBack.status !== 'rolled_back') {
      throw new Error(`A operação ${id} não confirmou status rolled_back após a restauração.`);
    }
    return { operation: rolledBack, alreadyRolledBack: false };
  }
}
