import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { LocalStorage } from './storage';

const MAX_EDITOR_FILE_BYTES = 4 * 1024 * 1024;

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
    const normalizedRoot = await fs.realpath(path.resolve(rootPath.trim()));
    const stat = await fs.stat(normalizedRoot);
    if (!stat.isDirectory()) throw new Error('O workspace precisa apontar para uma pasta.');
    const duplicate = this.projects.find((project) => path.resolve(project.rootPath) === normalizedRoot);
    if (duplicate) return duplicate;
    const now = Date.now();
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name: name.trim() || path.basename(normalizedRoot),
      rootPath: normalizedRoot,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    await this.storage.write('projects.json', this.projects);
    return project;
  }

  resolveInsideWorkspace(filePath: string): string {
    const candidate = path.resolve(filePath);
    const project = this.projects.find((item) => {
      const root = path.resolve(item.rootPath);
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!project) throw new Error('Operação bloqueada: arquivo fora de um workspace conhecido.');
    return candidate;
  }

  private async resolveExistingInsideWorkspace(filePath: string): Promise<string> {
    const candidate = this.resolveInsideWorkspace(filePath);
    const project = this.projects.find((item) => {
      const root = path.resolve(item.rootPath);
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!project) throw new Error('Workspace não encontrado.');
    const root = await fs.realpath(project.rootPath);
    const realCandidate = await fs.realpath(candidate);
    const relative = path.relative(root, realCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operação bloqueada: caminho simbólico fora do workspace.');
    return realCandidate;
  }

  private async resolveWritableInsideWorkspace(filePath: string): Promise<string> {
    const candidate = this.resolveInsideWorkspace(filePath);
    const project = this.projects.find((item) => {
      const root = path.resolve(item.rootPath);
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!project) throw new Error('Workspace não encontrado.');
    const root = await fs.realpath(project.rootPath);
    let parent = path.dirname(candidate);
    while (true) {
      try {
        const realParent = await fs.realpath(parent);
        const relative = path.relative(root, realParent);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operação bloqueada: diretório simbólico fora do workspace.');
        return candidate;
      } catch (error) {
        if (error instanceof Error && error.message.includes('Operação bloqueada')) throw error;
        const next = path.dirname(parent);
        if (next === parent) throw new Error('Não foi possível validar o caminho do workspace.');
        parent = next;
      }
    }
  }

  async scan(rootPath: string): Promise<Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>> {
    const normalizedRoot = await fs.realpath(path.resolve(rootPath));
    const known = this.projects.some((project) => path.resolve(project.rootPath) === normalizedRoot);
    if (!known) throw new Error('Workspace não registrado.');
    const result: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }> = [];
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);

    const visit = async (current: string): Promise<void> => {
      const safeCurrent = await fs.realpath(current);
      const relativeCurrent = path.relative(normalizedRoot, safeCurrent);
      if (relativeCurrent.startsWith('..') || path.isAbsolute(relativeCurrent)) throw new Error('Operação bloqueada: diretório fora do workspace.');
      for (const entry of await fs.readdir(safeCurrent, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(safeCurrent, entry.name);
        const relativePath = path.relative(normalizedRoot, full);
        result.push({ path: full, relativePath, type: entry.isDirectory() ? 'directory' : 'file' });
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
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, 'utf8');
  }
}
