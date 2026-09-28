import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { SYSTEM_WORKSPACE_ID, getSystemWorkspaceRoot } from './system-workspace';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export type WorkspacePathStat =
  | { exists: false }
  | { exists: true; kind: 'file' | 'directory'; size: number; modifiedAt: number };

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

export class WorkspaceRuntime {
  constructor(private readonly projects: () => Promise<ProjectRecord[]>) {}

  async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }

  private async root(projectId: string): Promise<string> {
    if (projectId === SYSTEM_WORKSPACE_ID) return fs.realpath(getSystemWorkspaceRoot());
    const project = await this.getProject(projectId);
    return fs.realpath(path.resolve(project.rootPath));
  }

  private assertInside(root: string, candidate: string): void {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Operação bloqueada: caminho fora do workspace.');
  }

  private async nearestExisting(pathname: string): Promise<string> {
    let current = pathname;
    while (current !== path.dirname(current)) {
      try {
        return await fs.realpath(current);
      } catch {
        current = path.dirname(current);
      }
    }
    try {
      return await fs.realpath(current);
    } catch {
      throw new Error('Não foi possível validar o caminho do workspace.');
    }
  }

  async resolve(projectId: string, requestedPath: string): Promise<string> {
    const root = await this.root(projectId);
    const candidate = path.resolve(root, requestedPath);
    this.assertInside(root, candidate);
    const existingCandidate = await this.nearestExisting(candidate);
    this.assertInside(root, existingCandidate);
    return candidate;
  }

  async canonicalRelativePath(projectId: string, requestedPath: string): Promise<string> {
    const root = await this.root(projectId);
    const candidate = path.resolve(root, requestedPath);
    this.assertInside(root, candidate);

    let current = candidate;
    const unresolved: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(current);
        const canonical = path.resolve(real, ...unresolved);
        this.assertInside(root, canonical);
        const relative = path.relative(root, canonical);
        return relative ? relative.split(path.sep).join('/') : '.';
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        const parent = path.dirname(current);
        if (parent === current) throw new Error('Não foi possível validar o caminho do workspace.');
        unresolved.unshift(path.basename(current));
        current = parent;
      }
    }
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

  async statPath(projectId: string, requestedPath: string): Promise<WorkspacePathStat> {
    const filePath = await this.resolve(projectId, requestedPath);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return { exists: true, kind: 'file', size: stat.size, modifiedAt: stat.mtimeMs };
      if (stat.isDirectory()) return { exists: true, kind: 'directory', size: stat.size, modifiedAt: stat.mtimeMs };
      throw new Error('A operação exige um arquivo ou diretório regular.');
    } catch (error) {
      if (isMissingPath(error)) return { exists: false };
      throw error;
    }
  }

  async createFolder(projectId: string, requestedPath: string): Promise<boolean> {
    const filePath = await this.resolve(projectId, requestedPath);
    const current = await this.statPath(projectId, requestedPath);
    if (current.exists) {
      if (current.kind !== 'directory') throw new Error('Já existe um arquivo no caminho da pasta.');
      return false;
    }
    await fs.mkdir(filePath, { recursive: true });
    const real = await fs.realpath(filePath);
    const root = await this.root(projectId);
    this.assertInside(root, real);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error('A pasta não foi materializada corretamente.');
    return true;
  }

  private async assertRegularFile(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('A operação exige um arquivo regular.');
  }

  private async assertTextFileSize(filePath: string, allowMissing = false): Promise<void> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(`Arquivo excede o limite de ${MAX_TEXT_FILE_BYTES} bytes para operações do agente.`);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  async readFile(projectId: string, requestedPath: string): Promise<string> {
    const filePath = await this.resolve(projectId, requestedPath);
    await this.assertRegularFile(filePath);
    await this.assertTextFileSize(filePath);
    return fs.readFile(filePath, 'utf8');
  }

  async writeFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) throw new Error(`Conteúdo excede o limite de ${MAX_TEXT_FILE_BYTES} bytes.`);
    const filePath = await this.resolve(projectId, requestedPath);
    if (await this.exists(projectId, requestedPath)) {
      await this.assertRegularFile(filePath);
      await this.assertTextFileSize(filePath);
    }
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.autocodez-tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filePath);
    } finally {
      if (handle) await handle.close().catch((): undefined => undefined);
      await fs.rm(temporary, { force: true }).catch((): undefined => undefined);
    }
    await this.assertRegularFile(filePath);
    const persisted = await fs.readFile(filePath, 'utf8');
    if (persisted !== content) throw new Error('A verificação pós-escrita do arquivo falhou.');
  }

  async createFile(projectId: string, requestedPath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) throw new Error(`Conteúdo excede o limite de ${MAX_TEXT_FILE_BYTES} bytes.`);
    const filePath = await this.resolve(projectId, requestedPath);
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });

    const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.autocodez-tmp`);
    let materialized = false;
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.link(temporary, filePath);
      materialized = true;
    } finally {
      await fs.rm(temporary, { force: true }).catch((): undefined => undefined);
    }

    if (!materialized) throw new Error('O arquivo não pôde ser materializado atomicamente.');
    await this.assertRegularFile(filePath);
    const persisted = await fs.readFile(filePath, 'utf8');
    if (persisted !== content) throw new Error('A verificação pós-criação do arquivo falhou.');
  }

  async deleteFile(projectId: string, requestedPath: string): Promise<void> {
    const filePath = await this.resolve(projectId, requestedPath);
    await this.assertRegularFile(filePath);
    await this.assertTextFileSize(filePath);
    await fs.rm(filePath, { force: false });
  }

  async renameFile(projectId: string, from: string, to: string): Promise<void> {
    const source = await this.resolve(projectId, from);
    await this.assertRegularFile(source);
    await this.assertTextFileSize(source);
    const destination = await this.resolve(projectId, to);
    if (await this.exists(projectId, to)) throw new Error('O destino já existe.');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  async searchFiles(projectId: string, query: string): Promise<string[]> {
    const root = await this.root(projectId);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) throw new Error('A busca precisa conter um texto.');
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
        if (entry.name.toLowerCase().includes(normalizedQuery)) results.push(path.relative(root, full));
      }
    };
    await visit(root);
    return results;
  }
}
