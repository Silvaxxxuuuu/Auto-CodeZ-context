import type { FileDiff } from './ai/types';
import { DiffRuntime } from './agent/diff-runtime';

type FileState = {
  path: string;
  exists: boolean;
  content?: string;
};

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function keyOf(value: string): string {
  return normalizePath(value).toLowerCase();
}

function requirePath(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized) throw new Error('Caminho inválido no diff do Shadow Workspace.');
  return normalized;
}

export function compactShadowWorkspaceChanges(changes: FileDiff[], diffs = new DiffRuntime()): FileDiff[] {
  if (!Array.isArray(changes)) throw new Error('Alterações do Shadow Workspace inválidas.');
  const initial = new Map<string, FileState>();
  const current = new Map<string, FileState>();

  const seed = (requestedPath: string, exists: boolean, content?: string): void => {
    const path = requirePath(requestedPath);
    const key = keyOf(path);
    const existing = current.get(key);
    if (existing) {
      if (existing.exists !== exists || (exists && existing.content !== content)) throw new Error(`Sequência inconsistente para '${path}'.`);
      return;
    }
    const state: FileState = exists ? { path, exists: true, content } : { path, exists: false };
    initial.set(key, { ...state });
    current.set(key, { ...state });
  };

  for (const change of changes) {
    if (!change || typeof change !== 'object') throw new Error('Alteração inválida no Shadow Workspace.');
    if (change.type === 'created') {
      seed(change.path, false);
      const path = requirePath(change.path);
      current.set(keyOf(path), { path, exists: true, content: change.after });
      continue;
    }
    if (change.type === 'modified') {
      seed(change.path, true, change.before);
      const path = requirePath(change.path);
      current.set(keyOf(path), { path, exists: true, content: change.after });
      continue;
    }
    if (change.type === 'deleted') {
      seed(change.path, true, change.before);
      const path = requirePath(change.path);
      current.set(keyOf(path), { path, exists: false });
      continue;
    }
    if (change.type === 'renamed') {
      const from = requirePath(change.renamedFrom ?? '');
      const to = requirePath(change.path);
      seed(from, true, change.before);
      seed(to, false);
      current.set(keyOf(from), { path: from, exists: false });
      current.set(keyOf(to), { path: to, exists: true, content: change.after });
      continue;
    }
    throw new Error('Tipo de alteração inválido no Shadow Workspace.');
  }

  const result: FileDiff[] = [];
  const keys = new Set([...initial.keys(), ...current.keys()]);
  for (const key of [...keys].sort()) {
    const before = initial.get(key);
    const after = current.get(key);
    if (!before || !after) throw new Error('Estado incompleto no Shadow Workspace.');
    if (!before.exists && !after.exists) continue;
    if (!before.exists && after.exists) {
      result.push(diffs.create(after.path, 'created', '', after.content ?? ''));
      continue;
    }
    if (before.exists && !after.exists) {
      result.push(diffs.create(before.path, 'deleted', before.content ?? '', ''));
      continue;
    }
    if (before.content !== after.content) {
      result.push(diffs.create(after.path, 'modified', before.content ?? '', after.content ?? ''));
    }
  }
  return result;
}
