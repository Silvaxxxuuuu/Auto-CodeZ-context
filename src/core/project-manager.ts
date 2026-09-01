import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { LocalStorage } from './storage';

const MAX_EDITOR_FILE_BYTES = 4 * 1024 * 1024;

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = normalizePathForComparison(rootPath);
  const candidate = normalizePathForComparison(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class ProjectManager {
  private projects: ProjectRecord[] = [];

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    this.projects = await this.storage.read<ProjectRecord[]>('projects.json', []);
  }

  async list(): Promise<ProjectRecord[]> {
    return [...this.projects];
  }

  async create(name: string, rootPath: string): Promise<ProjectRecord> {
    const selectedRoot = path.resolve(rootPath.trim());
    const normalizedRoot = await fs.realpath(selectedRoot);
    const stat = await fs.stat(normalizedRoot);
    if (!stat.isDirectory()) throw new Error('O workspace precisa apontar para uma pasta.');
    const duplicate = this.projects.find((project) => isPathInside(project.rootPath, selectedRoot) && isPathInside(selectedRoot, project.rootPath));
    if (duplicate) return duplicate;
    const now = Date.now();
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name: name.trim() || path.basename(normalizedRoot),
      rootPath: selectedRoot,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    await this.storage.write('projects.json', this.projects);
    return project;
  }

  resolveInsideWorkspace(filePath: string): string {
    const candidate = path.resolve(filePath);
    const project = this.projects.find((item) => isPathInside(item.rootPath, candidate));
    if (!project) throw new Error('Operação bloqueada: arquivo fora de um workspace conhecido.');
    return candidate;
  }

  private async resolveExistingInsideWorkspace(filePath: string): Promise<string> {
    const candidate = this.resolveInsideWorkspace(filePath);
    const project = this.projects.find((item) => isPathInside(item.rootPath, candidate));
    if (!project) throw new Error('Workspace não encontrado.');
    const root = await fs.realpath(project.rootPath);
    const realCandidate = await fs.realpath(candidate);
    if (!isPathInside(root, realCandidate)) throw new Error('Operação bloqueada: caminho simbólico fora do workspace.');
    return realCandidate;
  }

  private async resolveWritableInsideWorkspace(filePath: string): Promise<string> {
    const candidate = this.resolveInsideWorkspace(filePath);
    const project = this.projects.find((item) => isPathInside(item.rootPath, candidate));
    if (!project) throw new Error('Workspace não encontrado.');
    const root = await fs.realpath(project.rootPath);

    try {
      const existingTarget = await fs.realpath(candidate);
      if (!isPathInside(root, existingTarget)) throw new Error('Operação bloqueada: arquivo simbólico fora do workspace.');
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    let parent = path.dirname(candidate);
    while (parent !== path.dirname(parent)) {
      try {
        const realParent = await fs.realpath(parent);
        if (!isPathInside(root, realParent)) throw new Error('Operação bloqueada: diretório simbólico fora do workspace.');
        return candidate;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        parent = path.dirname(parent);
      }
    }

    const realParent = await fs.realpath(parent);
    if (!isPathInside(root, realParent)) throw new Error('Operação bloqueada: diretório simbólico fora do workspace.');
    return candidate;
  }

  async scan(rootPath: string): Promise<Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>> {
    const displayRoot = path.resolve(rootPath);
    const normalizedRoot = await fs.realpath(displayRoot);
    const known = this.projects.some((project) => isPathInside(project.rootPath, displayRoot) && isPathInside(displayRoot, project.rootPath));
    if (!known) throw new Error('Workspace não registrado.');
    const result: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }> = [];
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);

    const visit = async (current: string): Promise<void> => {
      const safeCurrent = await fs.realpath(current);
      if (!isPathInside(normalizedRoot, safeCurrent)) throw new Error('Operação bloqueada: diretório fora do workspace.');
      for (const entry of await fs.readdir(safeCurrent, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(safeCurrent, entry.name);
        const relativePath = path.relative(normalizedRoot, full);
        const displayPath = path.join(displayRoot, relativePath);
        const linkInfo = await fs.lstat(full);
        if (linkInfo.isSymbolicLink()) {
          let type: 'file' | 'directory' = 'file';
          try {
            type = (await fs.stat(full)).isDirectory() ? 'directory' : 'file';
          } catch {
            type = 'file';
          }
          result.push({ path: displayPath, relativePath, type });
          continue;
        }
        result.push({ path: displayPath, relativePath, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entry.isDirectory()) await visit(full);
      }
    };

    await visit(normalizedRoot);
    return result;
  }

  async readFile(filePath: string): Promise<string> {
    const safePath = await this.resolveExistingInsideWorkspace(filePath);
    const stat = await fs.stat(safePath);
    if (!stat.isFile()) throw new Error('O caminho selecionado não é um arquivo.');
    if (stat.size > MAX_EDITOR_FILE_BYTES) throw new Error(`Arquivo excede o limite de ${MAX_EDITOR_FILE_BYTES} bytes para o editor.`);
    return fs.readFile(safePath, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_EDITOR_FILE_BYTES) throw new Error(`Conteúdo excede o limite de ${MAX_EDITOR_FILE_BYTES} bytes para o editor.`);
    const safePath = await this.resolveWritableInsideWorkspace(filePath);
    const parent = path.dirname(safePath);
    await fs.mkdir(parent, { recursive: true });

    const temporaryPath = path.join(parent, `.auto-codez-${crypto.randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      let destinationInfo: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        destinationInfo = await fs.lstat(safePath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }

      if (destinationInfo?.isSymbolicLink()) {
        throw new Error('Operação bloqueada: arquivo simbólico fora do workspace.');
      }
      if (destinationInfo && !destinationInfo.isFile()) {
        throw new Error('O caminho selecionado não é um arquivo.');
      }

      await fs.rename(temporaryPath, safePath);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Cleanup is best-effort after a failed write.
        }
      }
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch {
        // Cleanup is best-effort after a failed write.
      }
    }
  }
}