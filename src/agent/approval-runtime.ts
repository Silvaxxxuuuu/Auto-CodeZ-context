import crypto from 'node:crypto';
import type { ApprovalRequest } from '../ai/types';

type ApprovalFilters = { chatId?: string; runId?: string };

export class ApprovalRuntime {
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly inFlight = new Set<string>();

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest {
    const approval: ApprovalRequest = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    this.pending.set(approval.id, approval);
    return approval;
  }

  list(filters?: ApprovalFilters): ApprovalRequest[] {
    return [...this.pending.values()]
      .filter((approval) => filters?.chatId === undefined || approval.chatId === filters.chatId)
      .filter((approval) => filters?.runId === undefined || approval.runId === filters.runId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ApprovalRequest | undefined {
    const approval = this.pending.get(id);
    return approval ? { ...approval, toolCall: { ...approval.toolCall, input: { ...approval.toolCall.input } } } : undefined;
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  setChatId(id: string, chatId: string): ApprovalRequest {
    const approval = this.pending.get(id);
    if (!approval) throw new Error('Aprovação não encontrada.');
    const updated = { ...approval, chatId };
    this.pending.set(id, updated);
    return updated;
  }

  setRunId(id: string, runId: string): ApprovalRequest {
    const approval = this.pending.get(id);
    if (!approval) throw new Error('Aprovação não encontrada.');
    const updated = { ...approval, runId };
    this.pending.set(id, updated);
    return updated;
  }

  claim(id: string): ApprovalRequest {
    const approval = this.pending.get(id);
    if (!approval) throw new Error('Aprovação não encontrada ou já processada.');
    if (this.inFlight.has(id)) throw new Error('Esta aprovação já está sendo processada.');
    this.inFlight.add(id);
    return approval;
  }

  release(id: string): void {
    this.inFlight.delete(id);
  }

  resolve(id: string): ApprovalRequest {
    const approval = this.pending.get(id);
    if (!approval) throw new Error('Aprovação não encontrada ou já processada.');
    this.pending.delete(id);
    this.inFlight.delete(id);
    return approval;
  }

  remove(filters: ApprovalFilters): ApprovalRequest[] {
    const removed: ApprovalRequest[] = [];
    for (const [id, approval] of this.pending) {
      if (filters.chatId !== undefined && approval.chatId !== filters.chatId) continue;
      if (filters.runId !== undefined && approval.runId !== filters.runId) continue;
      this.pending.delete(id);
      this.inFlight.delete(id);
      removed.push(approval);
    }
    return removed;
  }

  restore(approvals: ApprovalRequest[]): void {
    this.pending.clear();
    this.inFlight.clear();
    for (const approval of approvals) {
      if (!approval.id || !approval.projectId || !approval.chatId || !approval.runId || !approval.toolCall?.id || !approval.toolCall?.name || !approval.createdAt) continue;
      this.pending.set(approval.id, approval);
    }
  }

  clear(): void {
    this.pending.clear();
    this.inFlight.clear();
  }
}
