import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { WorkspacePathPolicy } from '../agent/workspace-path-policy';

const INDEX_FILE = 'workspace-lexical-index-v1.json';
const INDEX_VERSION = 1;
const MAX_LEXICAL_SOURCE_BYTES = 64 * 1024;
const SIGNATURE_BITS = 16_384;
const SIGNATURE_BYTES = SIGNATURE_BITS / 8;
const SIGNATURE_HASHES = 5;
const RANK_SCOPE_CONCURRENCY = 16;
const automaticContextPathPolicy = new WorkspacePathPolicy();

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.md', '.mdx', '.txt', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.kts', '.cs', '.cpp', '.c', '.h', '.hpp', '.php', '.sh', '.bash',
  '.zsh', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.sql', '.graphql', '.gql',
  '.xml', '.properties', '.gradle', '.lock',
]);
const SPECIAL_TEXT_FILES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'cmakelists.txt',
  '.gitignore', '.gitattributes', '.editorconfig',
]);
const STOP_WORDS = new Set([
  'a', 'as', 'o', 'os', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'no', 'na',
  'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'para', 'por', 'com', 'sem', 'que',
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without',
  'this', 'that', 'these', 'those', 'fix', 'add', 'create', 'update', 'change',
  'corrigir', 'adicionar', 'criar', 'atualizar', 'alterar', 'implementar',
  'function', 'const', 'let', 'var', 'class', 'interface', 'type', 'return',
  'export', 'import', 'from', 'async', 'await', 'true', 'false', 'null', 'undefined',
]);

export type WorkspaceLexicalMatch = {
  relativePath: string;
  matchedTokens: number;
  queryTokens: number;
};

export type WorkspaceLexicalIndexStatus = {
  projectId: string;
  indexedFiles: number;
  signatureFiles: number;
  lastIndexedAt: number;
  updatedFiles: number;
  reusedFiles: number;
  removedFiles: number;
};

type WorkspaceLexicalFile = {
  relativePath: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
  signature: string | null;
};

type IndexedProject = {
  projectId: string;
  rootPath: string;
  lastIndexedAt: number;
  files: WorkspaceLexicalFile[];
};

type StoredWorkspaceLexicalIndex = {
  version: 1;
  projects: IndexedProject[];
};

interface WorkspaceLexicalStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

type ProjectContextPathFilter = (relativePath: string) => boolean | Promise<boolean>;

type RankedLexicalFile = WorkspaceLexicalFile & {
  matchedTokens: number;
  score: number;
};

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

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

function keyOf(relativePath: string): string {
  const normalized = toPosixPath(relativePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isLexicalCandidate(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  if (basename.endsWith('.env.example')) return true;
  if (SPECIAL_TEXT_FILES.has(basename)) return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function metadataFingerprint(relativePath: string, size: number, mtimeMs: number): string {
  return crypto.createHash('sha256')
    .update(toPosixPath(relativePath))
    .update('\u0000')
    .update(String(size))
    .update('\u0000')
    .update(String(Math.trunc(mtimeMs * 1000)))
    .digest('hex');
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u)
    .flatMap((part) => part.split(/[_-]+/))
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !STOP_WORDS.has(part)))];
}

function signaturePositions(token: string): number[] {
  const digest = crypto.createHash('sha256').update(token).digest();
  const positions: number[] = [];
  for (let index = 0; index < SIGNATURE_HASHES; index += 1) {
    positions.push(digest.readUInt32BE(index * 4) % SIGNATURE_BITS);
  }
  return positions;
}

function buildSignature(content: string): string {
  const signature = Buffer.alloc(SIGNATURE_BYTES);
  for (const token of searchTokens(content)) {
    for (const position of signaturePositions(token)) {
      signature[position >> 3] |= 1 << (position & 7);
    }
  }
  return signature.toString('base64');
}

function validSignature(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) return null;
  try {
    return Buffer.from(value, 'base64').length === SIGNATURE_BYTES ? value : null;
  } catch {
    return null;
  }
}

function signatureContains(buffer: Buffer, token: string): boolean {
  for (const position of signaturePositions(token)) {
    if ((buffer[position >> 3] & (1 << (position & 7))) === 0) return false;
  }
  return true;
}

function cloneFile(file: WorkspaceLexicalFile): WorkspaceLexicalFile {
  return { ...file };
}

function validStoredFile(value: unknown): WorkspaceLexicalFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const file = value as Partial<WorkspaceLexicalFile>;
  if (typeof file.relativePath !== 'string' || !file.relativePath.trim()) return undefined;
  if (!isLexicalCandidate(file.relativePath)) return undefined;
  if (automaticContextPathPolicy.evaluate('read_file', [file.relativePath]).decision !== 'allow') return undefined;
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) return undefined;
  if (typeof file.mtimeMs !== 'number' || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) return undefined;
  if (typeof file.fingerprint !== 'string' || !file.fingerprint) return undefined;
  return {
    relativePath: file.relativePath,
    size: file.size,
    mtimeMs: file.mtimeMs,
    fingerprint: file.fingerprint,
    signature: validSignature(file.signature),
  };
}

async function filterRankableFiles(files: WorkspaceLexicalFile[], includePath?: ProjectContextPathFilter): Promise<WorkspaceLexicalFile[]> {
  if (!includePath) return files.map(cloneFile);
  if (!files.length) return [];

  const allowed = new Array<boolean>(files.length).fill(false);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    let index = cursor;
    cursor += 1;
    while (index < files.length) {
      try {
        allowed[index] = Boolean(await includePath(files[index].relativePath));
      } catch {
        allowed[index] = false;
      }
      index = cursor;
      cursor += 1;
    }
  };

  const workerCount = Math.min(RANK_SCOPE_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return files.filter((_file, index) => allowed[index]).map(cloneFile);
}

async function pathIsIncluded(relativePath: string, includePath?: ProjectContextPathFilter): Promise<boolean> {
  if (!includePath) return true;
  try {
    return Boolean(await includePath(relativePath));
  } catch {
    return false;
  }
}

export class WorkspaceLexicalIndexRuntime {
  private readonly projects = new Map<string, IndexedProject>();

  constructor(private readonly storage: WorkspaceLexicalStorage, private readonly now: () => number = () => Date.now()) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<unknown>(INDEX_FILE, { version: INDEX_VERSION, projects: [] });
    if (!stored || typeof stored !== 'object') return;
    const state = stored as Partial<StoredWorkspaceLexicalIndex>;
    if (state.version !== INDEX_VERSION || !Array.isArray(state.projects)) return;

    this.projects.clear();
    for (const rawProject of state.projects) {
      if (!rawProject || typeof rawProject !== 'object') continue;
      const project = rawProject as Partial<IndexedProject>;
      if (typeof project.projectId !== 'string' || !project.projectId.trim()) continue;
      if (typeof project.rootPath !== 'string' || !project.rootPath.trim()) continue;
      const files = Array.isArray(project.files)
        ? project.files.map(validStoredFile).filter((file): file is WorkspaceLexicalFile => Boolean(file))
        : [];
      this.projects.set(project.projectId, {
        projectId: project.projectId,
        rootPath: project.rootPath,
        lastIndexedAt: typeof project.lastIndexedAt === 'number' && Number.isFinite(project.lastIndexedAt) ? project.lastIndexedAt : 0,
        files,
      });
    }
  }

  async refresh(project: ProjectRecord, relativePaths: string[], includePath?: ProjectContextPathFilter): Promise<WorkspaceLexicalIndexStatus> {
    const canonicalRoot = await fs.realpath(project.rootPath);
    const existing = this.projects.get(project.id);
    const rootChanged = existing ? normalizePathForComparison(existing.rootPath) !== normalizePathForComparison(canonicalRoot) : false;
    const previousFiles = new Map<string, WorkspaceLexicalFile>();
    if (existing && !rootChanged) for (const file of existing.files) previousFiles.set(keyOf(file.relativePath), file);

    const nextFiles: WorkspaceLexicalFile[] = [];
    let updatedFiles = 0;
    let reusedFiles = 0;

    for (const relativePath of relativePaths) {
      if (!isLexicalCandidate(relativePath)) continue;
      if (automaticContextPathPolicy.evaluate('read_file', [relativePath]).decision !== 'allow') continue;
      if (!(await pathIsIncluded(relativePath, includePath))) continue;
      const fullPath = path.join(canonicalRoot, relativePath);
      let realPath: string;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        realPath = await fs.realpath(fullPath);
        if (!isPathInside(canonicalRoot, realPath)) continue;
        stat = await fs.stat(realPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const fingerprint = metadataFingerprint(relativePath, stat.size, stat.mtimeMs);
      const previous = previousFiles.get(keyOf(relativePath));
      if (previous?.fingerprint === fingerprint) {
        nextFiles.push(cloneFile(previous));
        reusedFiles += 1;
        continue;
      }

      let signature: string | null = null;
      if (stat.size <= MAX_LEXICAL_SOURCE_BYTES) {
        try {
          const buffer = await fs.readFile(realPath);
          if (!buffer.includes(0)) signature = buildSignature(buffer.toString('utf8'));
        } catch {
          signature = null;
        }
      }

      nextFiles.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs, fingerprint, signature });
      updatedFiles += 1;
    }

    nextFiles.sort((left, right) => toPosixPath(left.relativePath).localeCompare(toPosixPath(right.relativePath)));
    const nextKeys = new Set(nextFiles.map((file) => keyOf(file.relativePath)));
    const removedFiles = [...previousFiles.keys()].filter((key) => !nextKeys.has(key)).length;
    const changed = !existing || rootChanged || updatedFiles > 0 || removedFiles > 0 || existing.files.length !== nextFiles.length;
    const lastIndexedAt = changed ? this.now() : existing?.lastIndexedAt ?? this.now();
    const indexedProject: IndexedProject = { projectId: project.id, rootPath: canonicalRoot, lastIndexedAt, files: nextFiles };
    this.projects.set(project.id, indexedProject);
    if (changed) await this.persist();

    return this.statusFor(indexedProject, { updatedFiles, reusedFiles, removedFiles });
  }

  async rank(projectId: string, query: string, includePath?: ProjectContextPathFilter, limit = 24): Promise<WorkspaceLexicalMatch[]> {
    const project = this.projects.get(projectId);
    if (!project || limit <= 0) return [];
    const queryTokens = searchTokens(query);
    if (!queryTokens.length) return [];
    const scopedFiles = await filterRankableFiles(project.files, includePath);
    const minimumMatches = queryTokens.length >= 3 ? 2 : 1;
    const ranked: RankedLexicalFile[] = [];

    for (const file of scopedFiles) {
      if (!file.signature) continue;
      const signature = Buffer.from(file.signature, 'base64');
      let matchedTokens = 0;
      for (const token of queryTokens) if (signatureContains(signature, token)) matchedTokens += 1;
      if (matchedTokens < minimumMatches) continue;
      const completeMatch = matchedTokens === queryTokens.length ? 8 : 0;
      ranked.push({ ...cloneFile(file), matchedTokens, score: matchedTokens * 12 + completeMatch });
    }

    ranked.sort((left, right) => right.score - left.score
      || right.matchedTokens - left.matchedTokens
      || toPosixPath(left.relativePath).localeCompare(toPosixPath(right.relativePath)));
    return ranked.slice(0, limit).map((file) => ({
      relativePath: file.relativePath,
      matchedTokens: file.matchedTokens,
      queryTokens: queryTokens.length,
    }));
  }

  async removeProject(projectId: string): Promise<void> {
    const removed = this.projects.delete(projectId);
    if (removed) await this.persist();
  }

  private statusFor(project: IndexedProject, refresh: Pick<WorkspaceLexicalIndexStatus, 'updatedFiles' | 'reusedFiles' | 'removedFiles'>): WorkspaceLexicalIndexStatus {
    return {
      projectId: project.projectId,
      indexedFiles: project.files.length,
      signatureFiles: project.files.filter((file) => Boolean(file.signature)).length,
      lastIndexedAt: project.lastIndexedAt,
      ...refresh,
    };
  }

  private async persist(): Promise<void> {
    const projects = [...this.projects.values()]
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
      .map((project) => ({ ...project, files: project.files.map(cloneFile) }));
    await this.storage.write<StoredWorkspaceLexicalIndex>(INDEX_FILE, { version: INDEX_VERSION, projects });
  }
}
