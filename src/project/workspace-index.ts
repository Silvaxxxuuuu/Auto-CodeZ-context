import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ProjectRecord } from '../ai/types';
import { WorkspacePathPolicy } from '../agent/workspace-path-policy';

const INDEX_FILE = 'workspace-index-v1.json';
const INDEX_VERSION = 1;
const MAX_SYMBOL_SOURCE_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 160;
const automaticContextPathPolicy = new WorkspacePathPolicy();

const TYPE_SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const CONTEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.md', '.mdx', '.txt', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.kts', '.cs', '.cpp', '.c', '.h', '.hpp', '.php', '.sh', '.bash',
  '.zsh', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.sql', '.graphql', '.gql',
  '.xml', '.properties', '.gradle', '.lock',
]);
const SPECIAL_CONTEXT_FILES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'cmakelists.txt',
  '.gitignore', '.gitattributes', '.editorconfig',
]);
const STOP_WORDS = new Set([
  'a', 'as', 'o', 'os', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'no', 'na',
  'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'para', 'por', 'com', 'sem', 'que',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'without',
  'this', 'that', 'these', 'those', 'fix', 'add', 'create', 'update', 'change',
  'corrigir', 'adicionar', 'criar', 'atualizar', 'alterar', 'implementar',
]);

export type WorkspaceIndexSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable';

export type WorkspaceIndexSymbol = {
  name: string;
  kind: WorkspaceIndexSymbolKind;
  line: number;
};

export type WorkspaceIndexFile = {
  relativePath: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
  symbols: WorkspaceIndexSymbol[];
};

export type WorkspaceIndexStatus = {
  projectId: string;
  indexedFiles: number;
  symbolCount: number;
  lastIndexedAt: number;
  updatedFiles: number;
  reusedFiles: number;
  removedFiles: number;
};

type IndexedProject = {
  projectId: string;
  rootPath: string;
  lastIndexedAt: number;
  files: WorkspaceIndexFile[];
};

type StoredWorkspaceIndex = {
  version: 1;
  projects: IndexedProject[];
};

interface WorkspaceIndexStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

type ProjectContextPathFilter = (relativePath: string) => boolean | Promise<boolean>;
type RankedFile = WorkspaceIndexFile & { score: number; priority: number };

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

function isContextCandidate(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  if (basename.endsWith('.env.example')) return true;
  if (SPECIAL_CONTEXT_FILES.has(basename)) return true;
  return CONTEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
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

function scriptKind(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function symbolLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1;
}

function propertyName(value: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  return value && ts.isIdentifier(value) ? value.text : undefined;
}

function pushSymbol(symbols: WorkspaceIndexSymbol[], sourceFile: ts.SourceFile, node: ts.Node, name: string | undefined, kind: WorkspaceIndexSymbolKind): void {
  if (!name || symbols.length >= MAX_SYMBOLS_PER_FILE) return;
  symbols.push({ name, kind, line: symbolLine(sourceFile, node) });
}

function extractTypeScriptSymbols(filePath: string, content: string): WorkspaceIndexSymbol[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const symbols: WorkspaceIndexSymbol[] = [];

  const visit = (node: ts.Node): void => {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    if (ts.isFunctionDeclaration(node)) pushSymbol(symbols, sourceFile, node, node.name?.text, 'function');
    else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) pushSymbol(symbols, sourceFile, node, propertyName(node.name), 'method');
    else if (ts.isClassDeclaration(node)) pushSymbol(symbols, sourceFile, node, node.name?.text, 'class');
    else if (ts.isInterfaceDeclaration(node)) pushSymbol(symbols, sourceFile, node, node.name.text, 'interface');
    else if (ts.isTypeAliasDeclaration(node)) pushSymbol(symbols, sourceFile, node, node.name.text, 'type');
    else if (ts.isEnumDeclaration(node)) pushSymbol(symbols, sourceFile, node, node.name.text, 'enum');
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) pushSymbol(symbols, sourceFile, node, node.name.text, 'variable');
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return symbols;
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
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part)))];
}

function defaultPriority(relativePath: string): number {
  const normalized = toPosixPath(relativePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  let score = 0;
  if (!normalized.includes('/')) score += 4;
  if (normalized.startsWith('src/')) score += 3;
  if (normalized.startsWith('tests/') || normalized.startsWith('test/')) score += 1;
  if (basename === 'package.json' || basename === 'pyproject.toml' || basename === 'cargo.toml' || basename === 'go.mod') score += 8;
  if (basename.startsWith('readme')) score += 6;
  if (basename.startsWith('tsconfig') || basename.startsWith('vite.') || basename.startsWith('webpack.')) score += 5;
  return score;
}

function scoreFile(file: WorkspaceIndexFile, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  const normalizedPath = normalizeSearchText(toPosixPath(file.relativePath));
  const pathTokens = new Set(searchTokens(file.relativePath));
  const basename = normalizeSearchText(path.posix.basename(toPosixPath(file.relativePath), path.posix.extname(toPosixPath(file.relativePath))));
  const symbols = file.symbols.map((symbol) => ({ normalized: normalizeSearchText(symbol.name), tokens: new Set(searchTokens(symbol.name)) }));
  let score = 0;

  for (const token of queryTokens) {
    if (basename === token) score += 42;
    if (pathTokens.has(token)) score += 14;
    else if (normalizedPath.includes(token)) score += 5;
    for (const symbol of symbols) {
      if (symbol.normalized === token) score += 38;
      else if (symbol.tokens.has(token)) score += 20;
      else if (symbol.normalized.includes(token)) score += 8;
    }
  }

  if ((queryTokens.includes('test') || queryTokens.includes('tests') || queryTokens.includes('teste') || queryTokens.includes('testes'))
    && /(^|\/)tests?\//i.test(toPosixPath(file.relativePath))) score += 12;
  return score;
}

function cloneFile(file: WorkspaceIndexFile): WorkspaceIndexFile {
  return { ...file, symbols: file.symbols.map((symbol) => ({ ...symbol })) };
}

function validStoredFile(value: unknown): WorkspaceIndexFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const file = value as Partial<WorkspaceIndexFile>;
  if (typeof file.relativePath !== 'string' || !file.relativePath.trim()) return undefined;
  if (!isContextCandidate(file.relativePath)) return undefined;
  if (automaticContextPathPolicy.evaluate('read_file', [file.relativePath]).decision !== 'allow') return undefined;
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) return undefined;
  if (typeof file.mtimeMs !== 'number' || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) return undefined;
  if (typeof file.fingerprint !== 'string' || !file.fingerprint) return undefined;
  const symbols = Array.isArray(file.symbols)
    ? file.symbols.filter((symbol): symbol is WorkspaceIndexSymbol => Boolean(
      symbol
      && typeof symbol === 'object'
      && typeof (symbol as WorkspaceIndexSymbol).name === 'string'
      && typeof (symbol as WorkspaceIndexSymbol).kind === 'string'
      && typeof (symbol as WorkspaceIndexSymbol).line === 'number',
    )).slice(0, MAX_SYMBOLS_PER_FILE).map((symbol) => ({ ...symbol }))
    : [];
  return { relativePath: file.relativePath, size: file.size, mtimeMs: file.mtimeMs, fingerprint: file.fingerprint, symbols };
}

export class WorkspaceIndexRuntime {
  private readonly projects = new Map<string, IndexedProject>();
  private readonly refreshStatus = new Map<string, WorkspaceIndexStatus>();

  constructor(private readonly storage: WorkspaceIndexStorage, private readonly now: () => number = () => Date.now()) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<unknown>(INDEX_FILE, { version: INDEX_VERSION, projects: [] });
    if (!stored || typeof stored !== 'object') return;
    const state = stored as Partial<StoredWorkspaceIndex>;
    if (state.version !== INDEX_VERSION || !Array.isArray(state.projects)) return;

    this.projects.clear();
    for (const rawProject of state.projects) {
      if (!rawProject || typeof rawProject !== 'object') continue;
      const project = rawProject as Partial<IndexedProject>;
      if (typeof project.projectId !== 'string' || !project.projectId.trim()) continue;
      if (typeof project.rootPath !== 'string' || !project.rootPath.trim()) continue;
      const files = Array.isArray(project.files) ? project.files.map(validStoredFile).filter((file): file is WorkspaceIndexFile => Boolean(file)) : [];
      this.projects.set(project.projectId, {
        projectId: project.projectId,
        rootPath: project.rootPath,
        lastIndexedAt: typeof project.lastIndexedAt === 'number' && Number.isFinite(project.lastIndexedAt) ? project.lastIndexedAt : 0,
        files,
      });
    }
  }

  async refresh(project: ProjectRecord, relativePaths: string[]): Promise<WorkspaceIndexStatus> {
    const canonicalRoot = await fs.realpath(project.rootPath);
    const existing = this.projects.get(project.id);
    const rootChanged = existing ? normalizePathForComparison(existing.rootPath) !== normalizePathForComparison(canonicalRoot) : false;
    const previousFiles = new Map<string, WorkspaceIndexFile>();
    if (existing && !rootChanged) for (const file of existing.files) previousFiles.set(keyOf(file.relativePath), file);

    const nextFiles: WorkspaceIndexFile[] = [];
    let updatedFiles = 0;
    let reusedFiles = 0;

    for (const relativePath of relativePaths) {
      if (!isContextCandidate(relativePath)) continue;
      if (automaticContextPathPolicy.evaluate('read_file', [relativePath]).decision !== 'allow') continue;
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

      let symbols: WorkspaceIndexSymbol[] = [];
      if (TYPE_SCRIPT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) && stat.size <= MAX_SYMBOL_SOURCE_BYTES) {
        try {
          const content = await fs.readFile(realPath, 'utf8');
          if (!content.includes('\u0000')) symbols = extractTypeScriptSymbols(realPath, content);
        } catch {
          symbols = [];
        }
      }

      nextFiles.push({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs, fingerprint, symbols });
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

    const status = this.statusFor(indexedProject, { updatedFiles, reusedFiles, removedFiles });
    this.refreshStatus.set(project.id, status);
    return { ...status };
  }

  async rank(projectId: string, query: string, includePath?: ProjectContextPathFilter, limit = 24): Promise<WorkspaceIndexFile[]> {
    const project = this.projects.get(projectId);
    if (!project || limit <= 0) return [];
    const queryTokens = searchTokens(query);
    const ranked: RankedFile[] = project.files.map((file) => ({ ...cloneFile(file), score: scoreFile(file, queryTokens), priority: defaultPriority(file.relativePath) }));
    ranked.sort((left, right) => right.score - left.score
      || right.priority - left.priority
      || toPosixPath(left.relativePath).localeCompare(toPosixPath(right.relativePath)));

    const selected: WorkspaceIndexFile[] = [];
    for (const file of ranked) {
      if (selected.length >= limit) break;
      if (includePath && !(await includePath(file.relativePath))) continue;
      selected.push(cloneFile(file));
    }
    return selected;
  }

  getStatus(projectId: string): WorkspaceIndexStatus | undefined {
    const refreshed = this.refreshStatus.get(projectId);
    if (refreshed) return { ...refreshed };
    const project = this.projects.get(projectId);
    return project ? this.statusFor(project, { updatedFiles: 0, reusedFiles: 0, removedFiles: 0 }) : undefined;
  }

  async removeProject(projectId: string): Promise<void> {
    const removed = this.projects.delete(projectId);
    this.refreshStatus.delete(projectId);
    if (removed) await this.persist();
  }

  private statusFor(project: IndexedProject, refresh: Pick<WorkspaceIndexStatus, 'updatedFiles' | 'reusedFiles' | 'removedFiles'>): WorkspaceIndexStatus {
    return {
      projectId: project.projectId,
      indexedFiles: project.files.length,
      symbolCount: project.files.reduce((count, file) => count + file.symbols.length, 0),
      lastIndexedAt: project.lastIndexedAt,
      ...refresh,
    };
  }

  private async persist(): Promise<void> {
    const projects = [...this.projects.values()]
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
      .map((project) => ({ ...project, files: project.files.map(cloneFile) }));
    await this.storage.write<StoredWorkspaceIndex>(INDEX_FILE, { version: INDEX_VERSION, projects });
  }
}
