import crypto from 'node:crypto';
import type { ApprovalRequest } from '../ai/types';
export class ApprovalRuntime {
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly inFlight = new Set<string>();
  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest { const approval: ApprovalRequest = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }; this.pending.set(approval.id, approval); return approval; }
  list(): ApprovalRequest[] { return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string): ApprovalRequest | undefined { return this.pending.get(id); }
  claim(id: string): ApprovalRequest { const approval = this.pending.get(id); if (!approval || this.inFlight.has(id)) throw new Error('Aprovação não encontrada ou já processada.'); this.inFlight.add(id); return approval; }
  release(id: string): void { this.inFlight.delete(id); }
  resolve(id: string): ApprovalRequest { const approval = this.pending.get(id); if (!approval) throw new Error('Aprovação não encontrada.'); this.pending.delete(id); this.inFlight.delete(id); return approval; }
  restore(approvals: ApprovalRequest[]): void { this.pending.clear(); this.inFlight.clear(); for (const approval of approvals) { if (!approval.id || !approval.projectId || !approval.toolCall?.id || !approval.toolCall?.name || !approval.createdAt) continue; this.pending.set(approval.id, approval); } }
  clear(): void { this.pending.clear(); this.inFlight.clear(); }
}
