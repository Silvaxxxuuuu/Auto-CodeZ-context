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
    const project: ProjectRecord = { id: crypto.randomUUID(), name: name.trim() || path.basename(rootPath), rootPath, createdAt: Date.now(), updatedAt: Date.now() };
    this.projects.push(project);
    await this.storage.write('projects.json', this.projects);
    return project;
  }

  async scan(rootPath: string): Promise<Array<{ path: string; relativePath: string; type: 'file' | 'directory' }>> {
    const result: Array<{ path: string; relativePath: string; type: 'file' | 'directory' }> = [];
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);

    const visit = async (current: string): Promise<void> => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        const relativePath = path.relative(rootPath, full);
        result.push({ path: full, relativePath, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entry.isDirectory()) await visit(full);
      }
    };

    await visit(rootPath);
    return result;
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}
