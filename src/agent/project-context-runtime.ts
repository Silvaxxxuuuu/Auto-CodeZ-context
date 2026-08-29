import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../ai/types';
import { ProjectManager } from '../core/project-manager';

const MAX_ENTRIES = 300;
const MAX_FILES_WITH_CONTENT = 16;
const MAX_FILE_BYTES = 12000;
const MAX_CONTEXT_BYTES = 48000;
const IGNORED_NAMES = new Set(['node_modules', '.git', '.vite', 'dist', 'build', 'out', 'coverage']);
const SENSITIVE_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.pypirc']);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.keystore']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.html', '.yml', '.yaml', '.xml', '.toml', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts']);

function isSensitive(relativePath: string): boolean {
  const basename = path.basename(relativePath).toLowerCase();
  const extension = path.extname(basename);
  return SENSITIVE_NAMES.has(basename) || SENSITIVE_EXTENSIONS.has(extension) || basename.includes('.secret.') || basename.includes('.credential.');
}

function isTextFile(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
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

export class ProjectContextRuntime {
  constructor(private readonly projects: ProjectManager) {}

  async build(projectId: string): Promise<string> {
    const project = await this.getProject(projectId);
    const entries = await this.projects.scan(project.rootPath);
    const boundedEntries = entries.slice(0, MAX_ENTRIES);
    const files = boundedEntries.filter((entry) => entry.type === 'file' && !isSensitive(entry.relativePath));
    const directories = boundedEntries.filter((entry) => entry.type === 'directory');
    const candidates = files
      .filter((entry) => isTextFile(entry.relativePath))
      .sort((a, b) => scoreFile(b.relativePath) - scoreFile(a.relativePath))
      .slice(0, MAX_FILES_WITH_CONTENT);

    let contextSize = 0;
    const fileContents: string[] = [];
    for (const entry of candidates) {
      try {
        const stat = await fs.stat(entry.path);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(entry.path, 'utf8');
        const remaining = MAX_CONTEXT_BYTES - contextSize;
        if (remaining <= 0) break;
        const clipped = content.slice(0, remaining);
        contextSize += clipped.length;
        fileContents.push(`\nFile: ${entry.relativePath}\n\`\`\`\n${clipped}\n\`\`\``);
      } catch {
        continue;
      }
    }

    const lines = [
      `Workspace: ${project.name}`,
      `Root: ${project.rootPath}`,
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
    return lines.join('\n');
  }

  private async getProject(projectId: string): Promise<ProjectRecord> {
    const project = (await this.projects.list()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    return project;
  }
}