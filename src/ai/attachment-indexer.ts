import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { AutoCodezLocalEngineManager } from './auto-codez-local-engine';
import { downloadVerifiedFile } from './verified-download';
import type { AIAttachment, AIAttachmentContext } from './types';
import { AttachmentStore } from './attachment-store';
import { imageDataUrl } from './provider-attachments';
import { recognizeImageTextWindows } from './windows-ocr';

const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 90_000;
const HEALTH_RETRY_MS = 300;

export const AUTO_CODEZ_VISION_MODEL = {
  id: 'smolvlm-256m-instruct-q8',
  model: {
    fileName: 'SmolVLM-256M-Instruct-Q8_0.gguf',
    url: 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/SmolVLM-256M-Instruct-Q8_0.gguf?download=true',
    sha256: '2a31195d3769c0b0fd0a4906201666108834848db768af11de1d2cef7cd35e65',
    bytes: 175_054_528,
  },
  projector: {
    fileName: 'mmproj-SmolVLM-256M-Instruct-Q8_0.gguf',
    url: 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-256M-Instruct-Q8_0.gguf?download=true',
    sha256: '7e943f7c53f0382a6fc41b6ee0c2def63ba4fded9ab8ed039cc9e2ab905e0edd',
    bytes: 103_769_856,
  },
} as const;

export type AttachmentIndexProgress = {
  message: string;
  percent?: number;
};

export interface AttachmentIndexer {
  index(
    attachment: AIAttachment,
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<AIAttachment>;
  stop(): Promise<void>;
}

type ActiveServer = {
  endpoint: string;
  process: ChildProcess;
};

function abortError(): Error {
  const error = new Error('Indexação visual cancelada.');
  error.name = 'AbortError';
  return error;
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta para o indexador visual.'));
        else resolve(port);
      });
    });
  });
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function fileMatches(filePath: string, sha256: string, bytes: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size !== bytes) return false;
    return await hashFile(filePath) === sha256;
  } catch {
    return false;
  }
}

function responseText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '';
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content.trim() : '';
}

export class ManagedVisionAttachmentIndexer implements AttachmentIndexer {
  private engine?: AutoCodezLocalEngineManager;
  private active?: ActiveServer;
  private startInFlight?: Promise<string>;
  private readonly indexInFlight = new Map<string, Promise<AIAttachment>>();

  constructor(
    private readonly root: () => string,
    private readonly store: AttachmentStore,
    engine?: AutoCodezLocalEngineManager,
  ) {
    this.engine = engine;
  }

  private engineManager(): AutoCodezLocalEngineManager {
    this.engine ??= new AutoCodezLocalEngineManager(path.join(this.root(), 'runtime'));
    return this.engine;
  }

  async index(
    attachment: AIAttachment,
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<AIAttachment> {
    if (attachment.kind !== 'image') return attachment;
    const hydrated = await this.store.hydrate(attachment);
    const hasCaption = hydrated.contexts?.some((context) => context.kind === 'caption' && context.text.trim());
    const hasOcr = hydrated.contexts?.some((context) => context.kind === 'ocr' && context.text.trim());
    if (hasCaption && (process.platform !== 'win32' || hasOcr)) return hydrated;

    const running = this.indexInFlight.get(hydrated.sha256);
    if (running) return await running;
    const operation = this.indexOnce(hydrated, signal, onProgress).finally(() => {
      if (this.indexInFlight.get(hydrated.sha256) === operation) this.indexInFlight.delete(hydrated.sha256);
    });
    this.indexInFlight.set(hydrated.sha256, operation);
    return await operation;
  }

  private assetsDir(): string {
    return path.join(this.root(), 'vision');
  }

  private async ensureAsset(
    descriptor: typeof AUTO_CODEZ_VISION_MODEL.model | typeof AUTO_CODEZ_VISION_MODEL.projector,
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<string> {
    const destination = path.join(this.assetsDir(), descriptor.fileName);
    if (await fileMatches(destination, descriptor.sha256, descriptor.bytes)) return destination;
    await fs.mkdir(this.assetsDir(), { recursive: true });
    await downloadVerifiedFile({
      url: descriptor.url,
      destination,
      sha256: descriptor.sha256,
      expectedBytes: descriptor.bytes,
      maximumBytes: Math.ceil(descriptor.bytes * 1.01),
    }, {
      signal,
      onProgress: (progress) => onProgress?.({
        message: `Baixando visão local · ${descriptor.fileName}`,
        ...(progress.percent !== undefined ? { percent: progress.percent } : {}),
      }),
    });
    return destination;
  }

  private async ensureServer(
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<string> {
    if (signal?.aborted) throw abortError();
    if (this.active && this.active.process.exitCode === null && !this.active.process.killed) return this.active.endpoint;
    if (this.startInFlight) return await this.startInFlight;
    this.startInFlight = this.startServer(signal, onProgress).finally(() => {
      this.startInFlight = undefined;
    });
    return await this.startInFlight;
  }

  private async startServer(
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<string> {
    await this.stop();
    onProgress?.({ message: 'Preparando mecanismo visual local.' });
    const executable = await this.engineManager().ensureInstalled(signal, (progress) => {
      onProgress?.({
        message: 'Preparando llama.cpp para visão local.',
        ...(progress.percent !== undefined ? { percent: progress.percent } : {}),
      });
    });
    const [modelPath, projectorPath] = await Promise.all([
      this.ensureAsset(AUTO_CODEZ_VISION_MODEL.model, signal, onProgress),
      this.ensureAsset(AUTO_CODEZ_VISION_MODEL.projector, signal, onProgress),
    ]);
    const port = await reservePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const child = spawn(executable, [
      '--model', modelPath,
      '--mmproj', projectorPath,
      '--alias', AUTO_CODEZ_VISION_MODEL.id,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', '4096',
      '--jinja',
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.active = { endpoint, process: child };
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_384);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError();
        if (child.exitCode !== null) throw new Error(`O indexador visual local encerrou durante a inicialização.${stderr ? ` ${stderr.trim()}` : ''}`);
        try {
          const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) {
            onProgress?.({ message: 'Visão local pronta.', percent: 100 });
            return endpoint;
          }
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
      }
      throw new Error('O indexador visual local não ficou pronto a tempo.');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async indexOnce(
    attachment: AIAttachment,
    signal?: AbortSignal,
    onProgress?: (progress: AttachmentIndexProgress) => void,
  ): Promise<AIAttachment> {
    if (!attachment.dataBase64) {
      attachment = await this.store.hydrate(attachment);
    }

    let indexed = attachment;
    let ocrAvailable = Boolean(indexed.contexts?.some((context) => context.kind === 'ocr' && context.text.trim()));
    if (process.platform === 'win32' && !ocrAvailable) {
      onProgress?.({ message: `Lendo texto de ${attachment.name} com OCR do Windows.` });
      try {
        const imagePath = await this.store.verifiedFilePath(attachment);
        const text = await recognizeImageTextWindows(imagePath, signal);
        if (text) {
          indexed = await this.store.saveContext(indexed, {
            kind: 'ocr',
            text,
            model: 'windows-media-ocr',
            createdAt: Date.now(),
          });
          ocrAvailable = true;
          onProgress?.({ message: `Texto de ${attachment.name} reconhecido localmente.`, percent: 100 });
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
    }

    const captionAvailable = Boolean(indexed.contexts?.some((context) => context.kind === 'caption' && context.text.trim()));
    if (captionAvailable) return indexed;

    let endpoint: string;
    try {
      endpoint = await this.ensureServer(signal, onProgress);
    } catch (error) {
      if (ocrAvailable) return indexed;
      throw error;
    }
    onProgress?.({ message: `Indexando ${attachment.name} com visão local.` });
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AUTO_CODEZ_VISION_MODEL.id,
        temperature: 0,
        max_tokens: 1400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Create a dense factual representation of this image for another AI. Include every legible text verbatim, UI controls, code, errors, numbers, status indicators, visible objects, layout and spatial relationships. Do not guess hidden information. Plain text only.',
            },
            { type: 'image_url', image_url: { url: imageDataUrl(indexed) } },
          ],
        }],
      }),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Indexador visual respondeu HTTP ${response.status}.`);
    const text = responseText(data);
    if (!text) throw new Error('O indexador visual não retornou uma descrição utilizável.');
    const context: AIAttachmentContext = {
      kind: 'caption',
      text,
      model: AUTO_CODEZ_VISION_MODEL.id,
      createdAt: Date.now(),
    };
    onProgress?.({ message: `${attachment.name} indexado localmente.`, percent: 100 });
    return await this.store.saveContext(indexed, context);
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (!active || active.process.exitCode !== null || active.process.killed) return;
    active.process.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (active.process.exitCode === null && !active.process.killed) active.process.kill('SIGKILL');
        resolve();
      }, 2_000);
      active.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
