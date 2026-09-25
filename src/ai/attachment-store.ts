import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AIAttachment, AIAttachmentContext, AIAttachmentKind } from './types';
import { extractOfficeText } from './archive-text-extractor';

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;
const TEXT_EXTENSIONS = new Set([
  '.txt','.md','.mdx','.json','.jsonc','.js','.jsx','.ts','.tsx','.mjs','.cjs',
  '.css','.scss','.sass','.less','.html','.htm','.xml','.svg','.yaml','.yml',
  '.toml','.ini','.cfg','.conf','.env','.csv','.tsv','.log','.sql','.sh','.bash',
  '.zsh','.ps1','.bat','.cmd','.py','.rb','.php','.java','.kt','.kts','.c','.h',
  '.cpp','.cc','.cxx','.hpp','.cs','.go','.rs','.swift','.lua','.r','.dart',
  '.vue','.svelte','.astro','.graphql','.gql','.proto','.gradle','.properties',
  '.gitignore','.gitattributes','.editorconfig',
]);
const IMAGE_EXTENSIONS = new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.avif']);
const OFFICE_EXTENSIONS = new Set(['.docx','.pptx','.xlsx','.odt','.ods','.odp']);
const AUDIO_EXTENSIONS = new Set(['.mp3','.wav','.ogg','.m4a','.aac','.flac','.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4','.webm','.mov','.mkv','.avi','.m4v']);

function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
    '.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif',
    '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.odt':'application/vnd.oasis.opendocument.text','.ods':'application/vnd.oasis.opendocument.spreadsheet','.odp':'application/vnd.oasis.opendocument.presentation','.json':'application/json','.csv':'text/csv',
    '.html':'text/html','.htm':'text/html','.xml':'application/xml','.svg':'image/svg+xml',
    '.md':'text/markdown','.txt':'text/plain','.yaml':'application/yaml','.yml':'application/yaml',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4',
    '.aac':'audio/aac','.flac':'audio/flac','.opus':'audio/opus',
    '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska',
  };
  return map[ext] || (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

function kindFrom(filePath: string, mediaType: string): AIAttachmentKind {
  const ext = path.extname(filePath).toLowerCase();
  if (mediaType.startsWith('image/') && ext !== '.svg') return 'image';
  if (mediaType.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (mediaType.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (mediaType.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || ext === '.svg') return 'text';
  if (ext === '.pdf' || OFFICE_EXTENSIONS.has(ext) || /(?:json|xml|yaml)/i.test(mediaType)) return 'document';
  return 'binary';
}

function safeText(value: string): string {
  const normalized = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  if (normalized.length <= MAX_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_TEXT_CHARS)}\n\n[... ${normalized.length - MAX_TEXT_CHARS} caracteres omitidos pelo Auto CodeZ ...]`;
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    if (char === 'b') return '\b';
    if (char === 'f') return '\f';
    return char;
  }).replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function textFromPdfContent(content: string): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    const literal = match[0].replace(/\)\s*Tj$/, '').slice(1);
    values.push(decodePdfLiteral(literal));
  }
  for (const match of content.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    const array = match[1];
    for (const literal of array.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      values.push(decodePdfLiteral(literal[0].slice(1, -1)));
    }
  }
  return values;
}

function extractPdfText(bytes: Buffer): string {
  const latin = bytes.toString('latin1');
  const chunks: string[] = [];
  chunks.push(...textFromPdfContent(latin));
  for (const match of latin.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const raw = Buffer.from(match[1], 'latin1');
    const prefix = latin.slice(Math.max(0, (match.index ?? 0) - 600), match.index ?? 0);
    try {
      const decoded = /\/FlateDecode/.test(prefix) ? zlib.inflateSync(raw) : raw;
      chunks.push(...textFromPdfContent(decoded.toString('latin1')));
    } catch {
      // Unsupported/compressed stream; other streams may still contain extractable text.
    }
  }
  return safeText(chunks.join(' ').replace(/\s+/g, ' ').trim());
}

function textContext(text: string, kind: AIAttachmentContext['kind'] = 'text'): AIAttachmentContext[] {
  const value = text.trim();
  return value ? [{ kind, text: value, createdAt: Date.now() }] : [];
}


function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} inválido.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} inválido.`);
  return normalized;
}

function requireFiniteNumber(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`${label} inválido.`);
  return value;
}

export function normalizeAttachmentReference(value: unknown): AIAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Anexo inválido.');
  const source = value as Record<string, unknown>;
  const kind = requireString(source.kind, 'Tipo do anexo', 32);
  if (!['image','document','text','audio','video','binary'].includes(kind)) throw new Error('Tipo do anexo inválido.');
  const sha256 = requireString(source.sha256, 'Hash do anexo', 64).toLowerCase();
  const storageKey = requireString(source.storageKey, 'Chave do anexo', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256) || storageKey !== sha256) throw new Error('Referência do anexo inválida.');
  const contexts = Array.isArray(source.contexts)
    ? source.contexts.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Contexto do anexo inválido.');
        const context = item as Record<string, unknown>;
        const contextKind = requireString(context.kind, 'Tipo de contexto', 32);
        if (!['native','text','ocr','caption','transcript','metadata'].includes(contextKind)) throw new Error('Tipo de contexto inválido.');
        return {
          kind: contextKind as AIAttachmentContext['kind'],
          text: requireString(context.text, 'Conteúdo indexado', MAX_TEXT_CHARS),
          createdAt: requireFiniteNumber(context.createdAt, 'Data do contexto'),
          ...(typeof context.model === 'string' && context.model.trim()
            ? { model: context.model.trim().slice(0, 256) }
            : {}),
        };
      })
    : undefined;
  return {
    id: requireString(source.id, 'ID do anexo', 256),
    kind: kind as AIAttachmentKind,
    name: path.basename(requireString(source.name, 'Nome do anexo', 255)),
    mediaType: requireString(source.mediaType, 'MIME do anexo', 128),
    size: requireFiniteNumber(source.size, 'Tamanho do anexo', 1),
    storageKey,
    sha256,
    createdAt: requireFiniteNumber(source.createdAt, 'Data do anexo'),
    ...(typeof source.width === 'number' ? { width: requireFiniteNumber(source.width, 'Largura', 1) } : {}),
    ...(typeof source.height === 'number' ? { height: requireFiniteNumber(source.height, 'Altura', 1) } : {}),
    ...(typeof source.durationMs === 'number' ? { durationMs: requireFiniteNumber(source.durationMs, 'Duração', 0) } : {}),
    ...(contexts?.length ? { contexts } : {}),
  };
}

export class AttachmentStore {
  constructor(private readonly root: () => string) {}

  private directoryFor(hash: string): string {
    return path.join(this.root(), hash.slice(0, 2));
  }

  private fileFor(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Chave de anexo inválida.');
    return path.join(this.directoryFor(hash), hash);
  }

  private contextFileFor(hash: string): string {
    return `${this.fileFor(hash)}.contexts.json`;
  }

  private async cachedContexts(hash: string): Promise<AIAttachmentContext[]> {
    try {
      const raw = await fs.readFile(this.contextFileFor(hash), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        try {
          const normalized = normalizeAttachmentReference({
            id: 'cache',
            kind: 'text',
            name: 'cache.txt',
            mediaType: 'text/plain',
            size: 1,
            storageKey: hash,
            sha256: hash,
            createdAt: 1,
            contexts: [item],
          }).contexts;
          return normalized ?? [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  async importFile(filePath: string): Promise<AIAttachment> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('O anexo selecionado não é um arquivo.');
    if (stat.size <= 0) throw new Error('O anexo está vazio.');
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('O anexo excede o limite de 64 MB.');

    const bytes = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const directory = this.directoryFor(hash);
    await fs.mkdir(directory, { recursive: true });
    const destination = this.fileFor(hash);
    try {
      await fs.writeFile(destination, bytes, { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }

    const mediaType = mimeFromExtension(filePath);
    const kind = kindFrom(filePath, mediaType);
    const ext = path.extname(filePath).toLowerCase();
    let contexts: AIAttachmentContext[] = [];
    if (kind === 'text') contexts = textContext(safeText(bytes.toString('utf8')));
    else if (ext === '.pdf') contexts = textContext(extractPdfText(bytes));
    else if (OFFICE_EXTENSIONS.has(ext)) contexts = textContext(safeText(extractOfficeText(bytes, ext)));

    return {
      id: crypto.randomUUID(),
      kind,
      name: path.basename(filePath),
      mediaType,
      size: stat.size,
      storageKey: hash,
      sha256: hash,
      createdAt: Date.now(),
      ...(contexts.length ? { contexts } : {}),
    };
  }

  async importFiles(filePaths: readonly string[]): Promise<AIAttachment[]> {
    const attachments: AIAttachment[] = [];
    for (const filePath of filePaths) attachments.push(await this.importFile(filePath));
    return attachments;
  }

  async validateReference(value: unknown): Promise<AIAttachment> {
    const attachment = normalizeAttachmentReference(value);
    await this.readBytes(attachment);
    return attachment;
  }

  async readBytes(attachment: AIAttachment): Promise<Buffer> {
    if (attachment.storageKey !== attachment.sha256) throw new Error('Metadados do anexo inconsistentes.');
    const bytes = await fs.readFile(this.fileFor(attachment.storageKey));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== attachment.sha256) throw new Error(`Integridade do anexo ${attachment.name} inválida.`);
    if (bytes.byteLength !== attachment.size) throw new Error(`Tamanho do anexo ${attachment.name} inválido.`);
    return bytes;
  }

  async saveContext(attachment: AIAttachment, context: AIAttachmentContext): Promise<AIAttachment> {
    await this.readBytes(attachment);
    const cached = await this.cachedContexts(attachment.sha256);
    const key = `${context.kind}:${context.model ?? ''}`;
    const next = [
      ...cached.filter((item) => `${item.kind}:${item.model ?? ''}` !== key),
      { ...context },
    ];
    await fs.mkdir(this.directoryFor(attachment.sha256), { recursive: true });
    await fs.writeFile(this.contextFileFor(attachment.sha256), JSON.stringify(next), 'utf8');
    return { ...attachment, contexts: next.map((item) => ({ ...item })) };
  }

  async hydrate(attachment: AIAttachment): Promise<AIAttachment> {
    const [bytes, cached] = await Promise.all([
      this.readBytes(attachment),
      this.cachedContexts(attachment.sha256),
    ]);
    const merged = new Map<string, AIAttachmentContext>();
    for (const context of [...(attachment.contexts ?? []), ...cached]) {
      merged.set(`${context.kind}:${context.model ?? ''}`, { ...context });
    }
    return {
      ...attachment,
      ...(merged.size ? { contexts: [...merged.values()] } : {}),
      dataBase64: bytes.toString('base64'),
    };
  }

  async previewDataUrl(attachment: AIAttachment): Promise<string | undefined> {
    if (attachment.kind !== 'image') return undefined;
    const bytes = await this.readBytes(attachment);
    return `data:${attachment.mediaType};base64,${bytes.toString('base64')}`;
  }
}
