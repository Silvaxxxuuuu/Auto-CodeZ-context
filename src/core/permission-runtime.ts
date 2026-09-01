import type { PermissionLevel } from '../ai/types';

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export class PermissionRuntime {
  decide(level: PermissionLevel, operation: 'read' | 'write' | 'create' | 'delete' | 'rename' | 'execute', insideWorkspace: boolean): PermissionDecision {
    if (!insideWorkspace && level !== 'unrestricted') {
      return { allowed: false, requiresApproval: false, reason: 'Operação fora do workspace.' };
    }
    if (level === 'read-only' && operation !== 'read') {
      return { allowed: false, requiresApproval: false, reason: 'O projeto está em modo somente leitura.' };
    }
    if (level === 'safe' && ['delete', 'execute'].includes(operation)) {
      return { allowed: false, requiresApproval: true, reason: 'Operação sensível exige aprovação.' };
    }
    if (level === 'ask') {
      return { allowed: true, requiresApproval: operation !== 'read', reason: 'A operação será apresentada ao usuário.' };
    }
    return { allowed: true, requiresApproval: false, reason: 'Operação permitida pela política atual.' };
  }
}
