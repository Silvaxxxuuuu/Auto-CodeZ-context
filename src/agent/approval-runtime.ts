import crypto from 'node:crypto';
import type { ApprovalRequest } from '../ai/types';

export class ApprovalRuntime {
  private readonly pending = new Map<string, ApprovalRequest>();

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest {
    const approval: ApprovalRequest = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    this.pending.set(approval.id, approval);
    return approval;
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id);
  }

  resolve(id: string): ApprovalRequest {
    const approval = this.pending.get(id);
    if (!approval) throw new Error('Aprovação não encontrada.');
    this.pending.delete(id);
    return approval;
  }

  clear(): void {
    this.pending.clear();
  }
}
