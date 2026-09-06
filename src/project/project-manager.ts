import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { WorkspacePathPolicy } from '../agent/workspace-path-policy';

const STATE_FILE = 'projects.json';
const MAX_CONTEXT_FILES = 80;
const MAX_FILE_BYTES = 256 * 1024;
const automaticContextPathPolicy = new WorkspacePathPolicy();

interface ProjectStorage { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; }
type ProjectContextPathFilter = (relativePath: string) => boolean | Promise<boolean>;

export class ProjectManager {
  private projects: ProjectRecord[] = [];

  constructor(private readonly storage: ProjectStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ProjectRecord[]>(STATE_FILE, []);
    this.projects = Array.isArray(stored) ? stored : [];
  }

  async list(): Promise<ProjectRecord[]> { return this.projects.map((project) => ({ ...project })); }

  async create(name: string, rootPath: string): Promise<ProjectRecord> {
    const root = await fs.realpath(path.resolve(rootPath));
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('A pasta selecionada não é um diretório.');
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Nome do projeto é obrigatório.');
    const existing = this.projects.find((project) => path.resolve(project.rootPath).toLowerCase() === root.toLowerCase());
    if (existing) return { ...existing };
    const now = Date.now();
    const project: ProjectRecord = { id: crypto.randomUUID(), name: normalizedName.slice(0, 120), rootPath: root, createdAt: now, updatedAt: now };
    this.projects.unshift(project);
    await this.persist();
    return { ...project };
  }

  async remove(projectId: string): Promise<ProjectRecord[]> {
    this.projects = this.projects.filter((project) => project.id !== projectId);
    await this.persist();
    return this.list();
  }

  async buildContext(projectId: string, includePath?: ProjectContextPathFilter): Promise<string> {
    const project = this.require(projectId);
    const files = await this.scan(project.rootPath);
    const selected: string[] = [];
    for (const relative of files) {
      if (selected.length >= MAX_CONTEXT_FILES) break;
      if (automaticContextPathPolicy.evaluate('read_file', [relative]).decision !== 'allow') continue;
      if (includePath && !(await includePath(relative))) continue;
      selected.push(relative);
    }
    const chunks: string[] = [`Workspace: ${project.name}\nRoot: ${project.rootPath}`];
    for (const relative of selected) {
      const filePath = path.join(project.rootPath, relative);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(filePath, 'utf8');
        if (/\u0000/.test(content)) continue;
        chunks.push(`\n--- ${relative} ---\n${content.slice(0, MAX_FILE_BYTES)}`);
      } catch { /* File changed or became unavailable while building context. */ }
    }
    return chunks.join('\n');
  }

  async scan(rootPath: string): Promise<string[]> { return this.scanDirectory(await fs.realpath(path.resolve(rootPath))); }

  async readFile(filePath: string): Promise<string> {
    const project = this.findProjectForPath(filePath);
    const safe = this.assertInside(project.rootPath, filePath);
    return fs.readFile(safe, 'utf8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const project = this.findProjectForPath(filePath);
    const safe = this.assertInside(project.rootPath, filePath);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, content, 'utf8');
  }

  private async scanDirectory(root: string): Promise<string[]> {
    const ignored = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);
    const result: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) result.push(path.relative(root, full));
        if (result.length >= 2000) return;
      }
    };
    await visit(root);
    return result.sort();
  }

  private findProjectForPath(filePath: string): ProjectRecord {
    const absolute = path.resolve(filePath);
    const project = [...this.projects].sort((a, b) => b.rootPath.length - a.rootPath.length).find((item) => {
      const relative = path.relative(path.resolve(item.rootPath), absolute);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!project) throw new Error('O arquivo não pertence a um projeto aberto.');
    return project;
  }

  private assertInside(root: string, filePath: string): string {
    const absolute = path.resolve(filePath);
    const relative = path.relative(path.resolve(root), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operação bloqueada: arquivo fora do projeto.');
    return absolute;
  }

  private require(projectId: string): ProjectRecord {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  private async persist(): Promise<void> { await this.storage.write(STATE_FILE, this.projects); }
}
