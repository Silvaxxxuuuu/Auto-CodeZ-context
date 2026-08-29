import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { LocalStorage } from './storage';

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
    const normalizedRoot = path.resolve(rootPath.trim());
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

  async scan(rootPath: string): Promise<Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>> {
    const normalizedRoot = path.resolve(rootPath);
    const known = this.projects.some((project) => path.resolve(project.rootPath) === normalizedRoot);
    if (!known) throw new Error('Workspace não registrado.');
    const result: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }> = [];
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);

    const visit = async (current: string): Promise<void> => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        const relativePath = path.relative(normalizedRoot, full);
        result.push({ path: full, relativePath, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entry.isDirectory()) await visit(full);
      }
    };

    await visit(normalizedRoot);
    return result;
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(this.resolveInsideWorkspace(filePath), 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const safePath = this.resolveInsideWorkspace(filePath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, 'utf8');
  }
}
