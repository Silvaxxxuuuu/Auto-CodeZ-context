import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { ProjectManager } from '../core/project-manager';

const MAX_ENTRIES = 300;
const MAX_CANDIDATE_FILES = 80;
const MAX_FILES_WITH_CONTENT = 16;
const MAX_FILE_BYTES = 12000;
const MAX_CONTEXT_BYTES = 48000;
const MAX_CONTENT_SCORE_BYTES = 24000;
const IGNORED_NAMES = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);
const SENSITIVE_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.pypirc']);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.keystore']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.html', '.yml', '.yaml', '.xml', '.toml', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts']);

function isIgnored(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => IGNORED_NAMES.has(part.toLowerCase()));
}

function isSensitive(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  const extension = path.extname(basename);
  return SENSITIVE_NAMES.has(basename) || SENSITIVE_EXTENSIONS.has(extension) || basename.includes('.secret.') || basename.includes('.credential.');
}

function isTextFile(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 2))];
}

function scoreFile(relativePath: string): number {
  const normalized = relativePath.toLowerCase();
  let score = 0;
  if (/(^|[\\/])(readme|package\.json|tsconfig|vite|electron|forge\.config)/i.test(relativePath)) score += 100;
  if (/(^|[\\/])src([\\/]|$)/i.test(relativePath)) score += 60;
  if (/\.(ts|tsx|js|jsx)$/.test(normalized)) score += 30;
  if (/test|spec/.test(normalized)) score += 10;
  score -= relativePath.split(/[\\/]/).length;
  return score;
}

function taskScore(relativePath: string, query: string): number {
  const terms = tokens(query);
  if (terms.length === 0) return 0;
  const normalized = relativePath.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized === term) score += 80;
    else if (path.basename(normalized).includes(term)) score += 45;
    else if (normalized.includes(term)) score += 20;
  }
  return score;
}

function entryScore(relativePath: string, type: string, query: string): number {
  return (type === 'directory' ? 0 : scoreFile(relativePath)) + taskScore(relativePath, query);
}

function contentScore(content: string, query: string): number {
  const terms = tokens(query);
  if (terms.length === 0) return 0;
  const normalized = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let position = normalized.indexOf(term);
    let occurrences = 0;
    while (position >= 0 && occurrences < 8) {
      occurrences += 1;
      position = normalized.indexOf(term, position + term.length);
    }
    score += occurrences * 8;
  }
  return score;
}

interface RankedFile {
  entry: { path: string; relativePath: string; type: 'file' | 'directory' };
  score: number;
  content?: string;
}

export class ProjectContextRuntime {
  constructor(private readonly projects: ProjectManager) {}

  async build(projectId: string, query = ''): Promise<string> {
    const project = await this.getProject(projectId);
    const entries = (await this.projects.scan(project.rootPath)).filter((entry) => !isIgnored(entry.relativePath));
    const boundedEntries = [...entries]
      .sort((a, b) => {
        const scoreDifference = entryScore(b.relativePath, b.type, query) - entryScore(a.relativePath, a.type, query);
        return scoreDifference || a.relativePath.localeCompare(b.relativePath);
      })
      .slice(0, MAX_ENTRIES);
    const files = boundedEntries.filter((entry) => entry.type === 'file' && !isSensitive(entry.relativePath));
    const directories = boundedEntries.filter((entry) => entry.type === 'directory');
    const candidates = files
      .filter((entry) => isTextFile(entry.relativePath))
      .slice(0, MAX_CANDIDATE_FILES);

    const ranked: RankedFile[] = [];
    for (const entry of candidates) {
      try {
        const stat = await fs.stat(entry.path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
          ranked.push({ entry, score: entryScore(entry.relativePath, entry.type, query) });
          continue;
        }
        const content = await fs.readFile(entry.path, 'utf8');
        ranked.push({ entry, score: entryScore(entry.relativePath, entry.type, query) + contentScore(content.slice(0, MAX_CONTENT_SCORE_BYTES), query), content });
      } catch {
        ranked.push({ entry, score: entryScore(entry.relativePath, entry.type, query) });
      }
    }

    ranked.sort((a, b) => b.score - a.score || a.entry.relativePath.localeCompare(b.entry.relativePath));
    const selected = ranked.slice(0, MAX_FILES_WITH_CONTENT);

    let contextSize = 0;
    const fileContents: string[] = [];
    for (const candidate of selected) {
      if (candidate.content === undefined) continue;
      const remaining = MAX_CONTEXT_BYTES - contextSize;
      if (remaining <= 0) break;
      const clipped = candidate.content.slice(0, remaining);
      contextSize += Buffer.byteLength(clipped, 'utf8');
      fileContents.push(`\nFile: ${candidate.entry.relativePath}\n\`\`\`\n${clipped}\n\`\`\``);
    }

    const lines = [
      `Workspace: ${project.name}`,
      'Root: .',
      query.trim() ? `Task focus: ${query.trim().slice(0, 500)}` : '',
      `Directories: ${directories.length}`,
      `Files: ${files.length}`,
      '',
      'Workspace tree:',
      ...boundedEntries.map((entry) => `${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.relativePath}`),
      ...(entries.length > MAX_ENTRIES ? [`... ${entries.length - MAX_ENTRIES} entries omitted.`] : []),
      '',
      'Selected text files:',
      ...fileContents,
    ];
    return lines.filter((line, index) => line !== '' || index === 0 || lines[index - 1] !== '').join('\n');
  }

  private async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects.list()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }
}
