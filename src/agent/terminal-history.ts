import crypto from 'node:crypto';
import type { LocalStorage } from '../core/storage';
import type { TerminalSession } from './terminal-runtime';

export interface TerminalHistoryRecord {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number;
  signal?: string;
  status: Exclude<TerminalSession['status'], 'running'>;
  output: string;
}

const STORAGE_KEY = 'terminal-history.json';
const MAX_RECORDS = 100;
const MAX_OUTPUT_CHARS = 2_000_000;

export class TerminalHistory {
  private records: TerminalHistoryRecord[] = [];

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<TerminalHistoryRecord[]>(STORAGE_KEY, []);
    this.records = stored
      .filter((record) => this.isValid(record))
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_RECORDS);
    if (stored.length !== this.records.length) await this.persist();
  }

  async add(input: Omit<TerminalHistoryRecord, 'id' | 'output'> & { output: string }): Promise<TerminalHistoryRecord> {
    if (!Number.isFinite(input.startedAt) || !Number.isFinite(input.finishedAt)) throw new Error('Horários da sessão inválidos.');
    if (input.finishedAt < input.startedAt) throw new Error('Término da sessão inválido.');
    if (!input.projectId.trim()) throw new Error('Projeto da sessão inválido.');
    if (!input.command.trim()) throw new Error('Comando da sessão inválido.');

    const record: TerminalHistoryRecord = {
      ...input,
      id: crypto.randomUUID(),
      output: input.output.slice(-MAX_OUTPUT_CHARS),
    };
    this.records.unshift(record);
    this.records = this.records.slice(0, MAX_RECORDS);
    await this.persist();
    return { ...record };
  }

  async list(projectId?: string): Promise<TerminalHistoryRecord[]> {
    return this.records
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => ({ ...record }))
      .sort((a, b) => b.finishedAt - a.finishedAt);
  }

  async clear(projectId?: string): Promise<void> {
    this.records = projectId ? this.records.filter((record) => record.projectId !== projectId) : [];
    await this.persist();
  }

  private isValid(value: TerminalHistoryRecord): boolean {
    return Boolean(
      value &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      typeof value.projectId === 'string' &&
      typeof value.command === 'string' &&
      typeof value.cwd === 'string' &&
      Number.isFinite(value.startedAt) &&
      Number.isFinite(value.finishedAt) &&
      Number.isInteger(value.exitCode) &&
      ['exited', 'failed', 'killed'].includes(value.status) &&
      typeof value.output === 'string',
    );
  }

  private async persist(): Promise<void> {
    await this.storage.write(STORAGE_KEY, this.records);
  }
}
