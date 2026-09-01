import crypto from 'node:crypto';
import type { DiffPlan, DiffSummary, FileDiff } from '../ai/types';

const MAX_EXACT_COMPARISON_CELLS = 4_000_000;
const MAX_PLAN_FILES = 20_000;

function lineCounts(before: string, after: string): { addedLines: number; removedLines: number } {
  const oldLines = before ? before.split(/\r?\n/) : [];
  const newLines = after ? after.split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldLength = oldEnd - prefix;
  const newLength = newEnd - prefix;
  if (oldLength === 0) return { addedLines: newLength, removedLines: 0 };
  if (newLength === 0) return { addedLines: 0, removedLines: oldLength };
  if (oldLength * newLength > MAX_EXACT_COMPARISON_CELLS) return { addedLines: newLength, removedLines: oldLength };

  const oldSlice = oldLines.slice(prefix, oldEnd);
  const newSlice = newLines.slice(prefix, newEnd);
  const cols = oldSlice.length + 1;
  let previous = new Uint32Array(cols);
  for (let row = 1; row <= newSlice.length; row += 1) {
    const current = new Uint32Array(cols);
    for (let col = 1; col < cols; col += 1) {
      current[col] = newSlice[row - 1] === oldSlice[col - 1]
        ? previous[col - 1] + 1
        : Math.max(previous[col], current[col - 1]);
    }
    previous = current;
  }
  const common = previous[cols - 1];
  return { addedLines: newLength - common, removedLines: oldLength - common };
}

function validateChange(change: FileDiff): void {
  if (!change.path.trim()) throw new Error('Uma alteração precisa de um caminho válido.');
  if (change.type === 'renamed' && !change.renamedFrom?.trim()) throw new Error('Uma alteração renomeada precisa informar o caminho original.');
  if (change.type !== 'renamed' && change.renamedFrom) throw new Error('Somente alterações renomeadas podem informar renamedFrom.');
  if (!Number.isInteger(change.addedLines) || change.addedLines < 0 || !Number.isInteger(change.removedLines) || change.removedLines < 0) {
    throw new Error('Contagem de linhas inválida no diff.');
  }
}

function summarize(changes: FileDiff[]): DiffSummary {
  return {
    files: changes.length,
    created: changes.filter((change) => change.type === 'created').length,
    modified: changes.filter((change) => change.type === 'modified').length,
    deleted: changes.filter((change) => change.type === 'deleted').length,
    renamed: changes.filter((change) => change.type === 'renamed').length,
    addedLines: changes.reduce((total, change) => total + change.addedLines, 0),
    removedLines: changes.reduce((total, change) => total + change.removedLines, 0),
  };
}

export class DiffRuntime {
  create(path: string, type: FileDiff['type'], before: string, after: string, renamedFrom?: string): FileDiff {
    const change: FileDiff = { path, type, before, after, ...lineCounts(before, after), ...(renamedFrom ? { renamedFrom } : {}) };
    validateChange(change);
    return change;
  }

  createPlan(changes: FileDiff[], id = crypto.randomUUID()): DiffPlan {
    if (changes.length > MAX_PLAN_FILES) throw new Error(`O plano de diff excede o limite de ${MAX_PLAN_FILES} arquivos.`);
    const uniquePaths = new Set<string>();
    for (const change of changes) {
      validateChange(change);
      const key = change.path.replaceAll('\\', '/').toLowerCase();
      if (uniquePaths.has(key)) throw new Error(`O plano contém alterações duplicadas para: ${change.path}`);
      uniquePaths.add(key);
    }
    return { id, createdAt: Date.now(), changes: changes.map((change) => ({ ...change })), summary: summarize(changes) };
  }

  summarize(changes: FileDiff[]): DiffSummary {
    for (const change of changes) validateChange(change);
    return summarize(changes);
  }
}
