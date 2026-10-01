import type { CapabilityContract } from './contracts';

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} não pode estar vazio.`);
}

export function assertCapabilityContract(contract: CapabilityContract): void {
  requireText(contract.id, 'Capability id');
  requireText(contract.name, 'Capability name');
  requireText(contract.title, 'Capability title');
  requireText(contract.description, 'Capability description');
  if (!Number.isInteger(contract.version) || contract.version < 1) throw new Error('Capability version deve ser inteiro >= 1.');
  if (!contract.whenToUse.length) throw new Error(`Capability ${contract.id} precisa declarar whenToUse.`);
  if (!contract.whenNotToUse.length) throw new Error(`Capability ${contract.id} precisa declarar whenNotToUse.`);
  if (!contract.examples.length) throw new Error(`Capability ${contract.id} precisa declarar exemplos.`);
  if (!contract.failureModes.length) throw new Error(`Capability ${contract.id} precisa declarar failureModes.`);
  requireText(contract.activity.running, 'Activity running');
  requireText(contract.activity.completed, 'Activity completed');
  requireText(contract.activity.failed, 'Activity failed');

  if (contract.annotations.readOnly && contract.annotations.destructive) {
    throw new Error(`Capability ${contract.id} não pode ser readOnly e destructive ao mesmo tempo.`);
  }
  if (contract.annotations.readOnly && contract.sideEffects.length) {
    throw new Error(`Capability ${contract.id} readOnly não pode declarar side effects persistentes.`);
  }
  if (contract.supportsRollback && contract.annotations.readOnly) {
    throw new Error(`Capability ${contract.id} readOnly não precisa declarar rollback.`);
  }
  if (contract.permissionClass === 'read' && !contract.annotations.readOnly) {
    throw new Error(`Capability ${contract.id} com permissionClass=read deve ser readOnly.`);
  }
  if (contract.permissionClass === 'write' && contract.annotations.readOnly) {
    throw new Error(`Capability ${contract.id} com permissionClass=write não pode ser readOnly.`);
  }
}
