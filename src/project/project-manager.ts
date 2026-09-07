import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { WorkspacePathPolicy } from '../agent/workspace-path-policy';
import { WorkspaceIndexRuntime, type WorkspaceIndexFile, type WorkspaceIndexStatus } from './workspace-index';
import { WorkspaceLexicalIndexRuntime, type WorkspaceLexicalMatch } from './workspace-lexical-index';

const STATE_FILE = 'projects.json';
const MAX_CONTEXT_FILES = 24;
const MAX_CONTEXT_BYTES = 768 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const STRUCTURAL_CONTEXT_CANDIDATES = 48;
const LEXICAL_CONTEXT_CANDIDATES = 24;
const RANK_FUSION_OFFSET = 4;
const STRUCTURAL_RANK_WEIGHT = 2;
const LEXICAL_RANK_WEIGHT = 1.5;
const automaticContextPathPolicy = new WorkspacePathPolicy();

interface ProjectStorage { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; }
type ProjectContextPathFilter = (relativePath: string) => boolean | Promise<boolean>;
type ContextCandidate = { relativePath: string };
type FusedCandidate = ContextCandidate & { score: number; structuralRank: number; lexicalRank: number };

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

function contextCandidateKey(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function fuseContextCandidates(structural: WorkspaceIndexFile[], lexical: WorkspaceLexicalMatch[]): ContextCandidate[] {
  const candidates = new Map<string, FusedCandidate>();
  const ensure = (relativePath: string): FusedCandidate => {
    const key = contextCandidateKey(relativePath);
    const existing = candidates.get(key);
    if (existing) return existing;
    const candidate: FusedCandidate = {
      relativePath,
      score: 0,
      structuralRank: Number.POSITIVE_INFINITY,
      lexicalRank: Number.POSITIVE_INFINITY,
    };
    candidates.set(key, candidate);
    return candidate;
  };

  structural.forEach((file, index) => {
    const rank = index + 1;
    const candidate = ensure(file.relativePath);
    candidate.structuralRank = rank;
    candidate.score += STRUCTURAL_RANK_WEIGHT / (RANK_FUSION_OFFSET + rank);
  });
  lexical.forEach((match, index) => {
    const rank = index + 1;
    const candidate = ensure(match.relativePath);
    candidate.lexicalRank = rank;
    candidate.score += LEXICAL_RANK_WEIGHT / (RANK_FUSION_OFFSET + rank);
  });

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score
      || left.structuralRank - right.structuralRank
      || left.lexicalRank - right.lexicalRank
      || left.relativePath.localeCompare(right.relativePath))
    .slice(0, MAX_CONTEXT_FILES)
    .map(({ relativePath }) => ({ relativePath }));
}

export class ProjectManager {
  private projects: ProjectRecord[] = [];
  private readonly workspaceIndex: WorkspaceIndexRuntime;
  private readonly workspaceLexicalIndex: WorkspaceLexicalIndexRuntime;

  constructor(private readonly storage: ProjectStorage) {
    this.workspaceIndex = new WorkspaceIndexRuntime(storage);
    this.workspaceLexicalIndex = new WorkspaceLexicalIndexRuntime(storage);
  }

  async init(): Promise<void> {
    const [stored] = await Promise.all([
      this.storage.read<ProjectRecord[]>(STATE_FILE, []),
      this.workspaceIndex.init(),
      this.workspaceLexicalIndex.init(),
    ]);
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
    const existed = this.projects.some((project) => project.id === projectId);
    this.projects = this.projects.filter((project) => project.id !== projectId);
    await this.persist();
    if (existed) await Promise.all([
      this.workspaceIndex.removeProject(projectId),
      this.workspaceLexicalIndex.removeProject(projectId),
    ]);
    return this.list();
  }

  async buildContext(projectId: string, includePath?: ProjectContextPathFilter, taskQuery = ''): Promise<string> {
    const project = this.require(projectId);
    const canonicalRoot = await fs.realpath(project.rootPath);
    const files = await this.scan(canonicalRoot);
    const [indexStatus, lexicalStatus] = await Promise.all([
      this.workspaceIndex.refresh(project, files),
      this.workspaceLexicalIndex.refresh(project, files, includePath),
    ]);
    const [structural, lexical] = await Promise.all([
      this.workspaceIndex.rank(projectId, taskQuery, includePath, STRUCTURAL_CONTEXT_CANDIDATES),
      this.workspaceLexicalIndex.rank(projectId, taskQuery, includePath, LEXICAL_CONTEXT_CANDIDATES),
    ]);
    const selected = fuseContextCandidates(structural, lexical);
    const chunks: string[] = [
      `Workspace: ${project.name}\nRoot: ${project.rootPath}`,
      `Local index: ${indexStatus.indexedFiles} files, ${indexStatus.symbolCount} TypeScript/JavaScript symbols, ${indexStatus.importCount} imports, ${lexicalStatus.signatureFiles} lexical signatures. Context is ranked for the current task.`,
    ];
    let contextBytes = Buffer.byteLength(chunks.join('\n'), 'utf8');

    for (const indexedFile of selected) {
      const relative = indexedFile.relativePath;
      if (automaticContextPathPolicy.evaluate('read_file', [relative]).decision !== 'allow') continue;
      if (includePath && !(await includePath(relative))) continue;
      const filePath = path.join(canonicalRoot, relative);
      try {
        const realFilePath = await fs.realpath(filePath);
        if (!isPathInside(canonicalRoot, realFilePath)) continue;
        const stat = await fs.stat(realFilePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const header = `\n--- ${relative} ---\n`;
        const headerBytes = Buffer.byteLength(header, 'utf8');
        const remaining = MAX_CONTEXT_BYTES - contextBytes - headerBytes;
        if (remaining <= 0) break;
        const buffer = await fs.readFile(realFilePath);
        if (buffer.includes(0)) continue;
        const contentBuffer = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
        let content = contentBuffer.toString('utf8');
        if (buffer.length > contentBuffer.length) content = content.replace(/\uFFFD+$/, '');
        chunks.push(`${header}${content}`);
        contextBytes += headerBytes + Buffer.byteLength(content, 'utf8');
        if (contextBytes >= MAX_CONTEXT_BYTES) break;
      } catch {
        // File changed or became unavailable while building context.
      }
    }
    return chunks.join('\n');
  }

  getWorkspaceIndexStatus(projectId: string): WorkspaceIndexStatus | undefined {
    this.require(projectId);
    return this.workspaceIndex.getStatus(projectId);
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
