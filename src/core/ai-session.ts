import {
  type AiProviderId,
  type AiResponse,
} from '../ai/aiConnector';

export type {
  AiProviderId,
} from '../ai/aiConnector';

export type AiSessionFile = {
  path: string;
  relativePath: string;
  name: string;
  content: string;
};

export type AiSessionActiveFile =
  AiSessionFile;

export type AiSessionRequest = {
  provider: AiProviderId;
  request: string;
  projectRoot: string;
  activeFile: AiSessionActiveFile;
  files: AiSessionFile[];
};

export type AiSessionState =
  | 'idle'
  | 'preparing'
  | 'sending'
  | 'waiting'
  | 'receiving'
  | 'analyzing'
  | 'proposing'
  | 'awaitingApproval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AiSessionResult = {
  sessionId: string;
  provider: AiProviderId;
  response: AiResponse;
};

export type AiSessionEvent = {
  sessionId: string;
  state: AiSessionState;
  timestamp: number;
};

const MAX_PROMPT_FILES = 60;
const MAX_PROMPT_FILE_SIZE = 120000;
const MAX_PROMPT_CONTEXT_CHARS = 500000;

const ignoredDirectoryNames = new Set([
  '.git',
  '.gradle',
  '.idea',
  '.kotlin',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  '__pycache__',
  '.pytest_cache',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'bin',
  'obj',
  'Pods',
  'DerivedData',
]);

const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.kts',
  '.py',
  '.go',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hh',
  '.hpp',
  '.cs',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.properties',
  '.gradle',
  '.sql',
  '.sh',
  '.ps1',
]);

const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svgz',
  '.pdf',
  '.zip',
  '.7z',
  '.rar',
  '.jar',
  '.class',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.db',
  '.sqlite',
  '.sqlite3',
]);

export class AiSession {
  readonly id: string;
  readonly provider: AiProviderId;
  readonly request: string;
  readonly projectRoot: string;
  readonly activeFile: AiSessionActiveFile;
  readonly files: AiSessionFile[];
  readonly prompt: string;
  readonly createdAt: number;

  private stateValue: AiSessionState =
    'idle';

  private errorValue:
    | string
    | null = null;

  private responseValue:
    | AiResponse
    | null = null;

  private updatedAtValue: number;

  constructor(
    request: AiSessionRequest,
  ) {
    this.id =
      crypto.randomUUID();

    this.provider =
      request.provider;

    this.request =
      request.request;

    this.projectRoot =
      request.projectRoot;

    this.activeFile =
      request.activeFile;

    this.files =
      [...request.files];

    this.prompt =
      buildSessionPrompt(
        request,
      );

    this.createdAt =
      Date.now();

    this.updatedAtValue =
      this.createdAt;
  }

  get state(): AiSessionState {
    return this.stateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get response(): AiResponse | null {
    return this.responseValue;
  }

  get updatedAt(): number {
    return this.updatedAtValue;
  }

  setState(
    state: AiSessionState,
  ): void {
    this.stateValue =
      state;

    this.updatedAtValue =
      Date.now();

    if (
      state !== 'failed'
    ) {
      this.errorValue =
        null;
    }
  }

  setResponse(
    response: AiResponse,
  ): void {
    this.responseValue =
      response;

    this.errorValue =
      null;

    this.stateValue =
      'receiving';

    this.updatedAtValue =
      Date.now();
  }

  fail(
    error: string,
  ): void {
    this.errorValue =
      error;

    this.stateValue =
      'failed';

    this.updatedAtValue =
      Date.now();
  }

  cancel(): void {
    this.stateValue =
      'cancelled';

    this.updatedAtValue =
      Date.now();
  }

  isFinished(): boolean {
    return (
      this.stateValue ===
        'completed' ||
      this.stateValue ===
        'failed' ||
      this.stateValue ===
        'cancelled'
    );
  }

  isActive(): boolean {
    return !this.isFinished();
  }

  toEvent(): AiSessionEvent {
    return {
      sessionId:
        this.id,
      state:
        this.stateValue,
      timestamp:
        this.updatedAtValue,
    };
  }

  toResult(): AiSessionResult {
    if (!this.responseValue) {
      throw new Error(
        'A sessão ainda não possui uma resposta.',
      );
    }

    return {
      sessionId:
        this.id,
      provider:
        this.provider,
      response:
        this.responseValue,
    };
  }
}

export function createAiSession(
  request: AiSessionRequest,
): AiSession {
  return new AiSession(
    request,
  );
}

function buildSessionPrompt(
  request: AiSessionRequest,
): string {
  const sections: string[] =
    [];

  sections.push(
    'Você está trabalhando com o Auto CodeZ.',
  );

  sections.push(
    '',
    'O Auto CodeZ é um ambiente de desenvolvimento que permite trabalhar com projetos locais usando IAs externas.',
  );

  sections.push(
    '',
    'Sua tarefa é analisar o pedido do usuário considerando o contexto fornecido do projeto.',
  );

  sections.push(
    '',
    'REGRAS:',
    '1. Preserve o comportamento existente sempre que possível.',
    '2. Altere somente o que for necessário para atender ao pedido.',
    '3. Não remova funcionalidades existentes sem uma solicitação explícita.',
    '4. Considere dependências entre arquivos antes de propor alterações.',
    '5. Mantenha o padrão de código já utilizado pelo projeto.',
    '6. Não invente arquivos, APIs ou bibliotecas sem necessidade.',
    '7. Quando uma alteração exigir múltiplos arquivos, identifique todos os arquivos afetados.',
    '8. A resposta será processada pelo Auto CodeZ posteriormente.',
  );

  sections.push(
    '',
    'FORMATO DA RESPOSTA:',
    'Explique brevemente o que será alterado.',
    'Depois, apresente as alterações de código necessárias.',
    'Identifique claramente o caminho de cada arquivo afetado.',
    'Não omita arquivos necessários para que a alteração funcione.',
  );

  sections.push(
    '',
    `PROJETO: ${request.projectRoot}`,
  );

  sections.push(
    '',
    `ARQUIVO ATIVO: ${request.activeFile.relativePath}`,
  );

  sections.push(
    '',
    'PEDIDO DO USUÁRIO:',
    request.request,
  );

  sections.push(
    '',
    'ARQUIVOS DO PROJETO:',
  );

  const files = selectPromptFiles(request.files, request.activeFile);

  for (const file of files) {
    sections.push(
      '',
      `===== ${file.relativePath} =====`,
      file.content,
    );
  }

  sections.push(
    '',
    'ANALISE O PEDIDO E O CONTEXTO DO PROJETO.',
  );

  return sections.join(
    '\n',
  );
}

function selectPromptFiles(
  files: AiSessionFile[],
  activeFile: AiSessionActiveFile,
): AiSessionFile[] {
  const normalizedActive = normalizePath(activeFile.relativePath);

  const candidates = files
    .filter((file) => file.content.length <= MAX_PROMPT_FILE_SIZE)
    .filter((file) => !isIgnoredPath(file.relativePath))
    .filter((file) => !isBinaryPath(file.relativePath))
    .map((file) => ({
      file,
      score: scoreContextFile(file, normalizedActive),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }

      return normalizePath(a.file.relativePath).localeCompare(
        normalizePath(b.file.relativePath),
      );
    });

  const selected: AiSessionFile[] = [];
  let totalChars = 0;

  for (const candidate of candidates) {
    if (selected.length >= MAX_PROMPT_FILES) {
      break;
    }

    const contentLength = candidate.file.content.length;

    if (
      selected.length > 0 &&
      totalChars + contentLength > MAX_PROMPT_CONTEXT_CHARS
    ) {
      continue;
    }

    selected.push(candidate.file);
    totalChars += contentLength;
  }

  if (
    !selected.some(
      (file) =>
        normalizePath(file.relativePath) === normalizedActive,
    )
  ) {
    const active = files.find(
      (file) =>
        normalizePath(file.relativePath) === normalizedActive,
    );

    if (
      active &&
      active.content.length <= MAX_PROMPT_FILE_SIZE &&
      !isIgnoredPath(active.relativePath) &&
      !isBinaryPath(active.relativePath)
    ) {
      selected.unshift(active);
    }
  }

  return selected.slice(0, MAX_PROMPT_FILES);
}

function scoreContextFile(
  file: AiSessionFile,
  normalizedActive: string,
): number {
  const path = normalizePath(file.relativePath);
  const lower = path.toLowerCase();
  const extension = getExtension(lower);
  let score = 0;

  if (path === normalizedActive) {
    score += 10000;
  }

  if (sourceExtensions.has(extension)) {
    score += 500;
  }

  if (
    lower === 'package.json' ||
    lower === 'tsconfig.json' ||
    lower.endsWith('.gradle.kts') ||
    lower.endsWith('gradle.properties') ||
    lower === 'settings.gradle' ||
    lower === 'settings.gradle.kts' ||
    lower === 'vite.config.ts' ||
    lower === 'vite.config.js'
  ) {
    score += 250;
  }

  if (
    lower.endsWith('readme.md') ||
    lower.endsWith('.md')
  ) {
    score += 100;
  }

  if (
    lower.endsWith('.lock') ||
    lower.endsWith('.sum')
  ) {
    score -= 100;
  }

  return score;
}

function isIgnoredPath(value: string): boolean {
  const normalized = normalizePath(value);
  const segments = normalized.split('/');

  return segments.some((segment) =>
    ignoredDirectoryNames.has(segment.toLowerCase()),
  );
}

function isBinaryPath(value: string): boolean {
  return binaryExtensions.has(
    getExtension(normalizePath(value).toLowerCase()),
  );
}

function getExtension(value: string): string {
  const basename = value.split('/').pop() || value;
  const index = basename.lastIndexOf('.');

  return index >= 0
    ? basename.slice(index)
    : '';
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}
