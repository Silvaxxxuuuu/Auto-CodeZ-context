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

  private assertInside(root: string, candidate: string): void {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operação bloqueada: caminho fora do workspace.');
  }

  private async nearestExisting(pathname: string): Promise<string> {
    let current = pathname;
    while (true) {
      try {
        return await fs.realpath(current);
      } catch {
        const parent = path.dirname(current);
        if (parent === current) throw new Error('Não foi possível validar o caminho do workspace.');
        current = parent;
      }
    }
  }

  async resolve(projectId: string, requestedPath: string): Promise<string> {
    const project = await this.getProject(projectId);
    const root = await fs.realpath(path.resolve(project.rootPath));
    const candidate = path.resolve(root, requestedPath);
    this.assertInside(root, candidate);

    const existingCandidate = await this.nearestExisting(candidate);
    this.assertInside(root, existingCandidate);
    return candidate;
  }

  async exists(projectId: string, requestedPath: string): Promise<boolean> {
    try {
      const filePath = await this.resolve(projectId, requestedPath);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
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
    const root = await fs.realpath(path.resolve(project.rootPath));
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);
    const results: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      const safeDirectory = await fs.realpath(directory);
      this.assertInside(root, safeDirectory);
      for (const entry of await fs.readdir(safeDirectory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(safeDirectory, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (entry.name.toLowerCase().includes(query.toLowerCase())) results.push(path.relative(root, full));
      }
    };

    await visit(root);
    return results;
  }
}
