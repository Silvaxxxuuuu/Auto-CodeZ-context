import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';

export class WorkspaceRuntime {
  constructor(private readonly projects: () => Promise<ProjectRecord[]>) {}

  async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  async resolve(projectId: string, requestedPath: string): Promise<string> {
    const project = await this.getProject(projectId);
    const root = path.resolve(project.rootPath);
    const candidate = path.resolve(root, requestedPath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Operação bloqueada: caminho fora do workspace.');
    }
    return candidate;
  }

  async readFile(projectId: string, requestedPath: string): Promise<string> {
    return fs.readFile(await this.resolve(projectId, requestedPath), 'utf8');
  }

  async writeFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    const filePath = await this.resolve(projectId, requestedPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  async createFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    const filePath = await this.resolve(projectId, requestedPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  }

  async deleteFile(projectId: string, requestedPath: string): Promise<void> {
    await fs.rm(await this.resolve(projectId, requestedPath), { force: false });
  }

  async renameFile(projectId: string, from: string, to: string): Promise<void> {
    const source = await this.resolve(projectId, from);
    const destination = await this.resolve(projectId, to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  async searchFiles(projectId: string, query: string): Promise<string[]> {
    const project = await this.getProject(projectId);
    const root = path.resolve(project.rootPath);
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);
    const results: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (entry.name.toLowerCase().includes(query.toLowerCase())) {
          results.push(path.relative(root, full));
        }
      }
    };

    await visit(root);
    return results;
  }
}
