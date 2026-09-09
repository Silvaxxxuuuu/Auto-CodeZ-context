import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadVerifiedFile, type VerifiedDownloadProgress } from './verified-download';

const execFileAsync = promisify(execFile);

export const AUTO_CODEZ_LOCAL_ENGINE_RELEASE = 'b10837';
export const AUTO_CODEZ_LOCAL_ENGINE_ASSET = {
  platform: 'win32',
  arch: 'x64',
  fileName: 'llama-b10837-bin-win-cpu-x64.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10837/llama-b10837-bin-win-cpu-x64.zip',
  sha256: 'b1b304054b13676d03876cce0e29d6c62b1de2a66456d1cd591afbdf15348088',
  bytes: 18_417_206,
} as const;

type EngineManifest = {
  release: string;
  asset: string;
  sha256: string;
};

export type AutoCodezLocalEngineOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  extractArchive?: (archivePath: string, destination: string) => Promise<void>;
};

async function defaultExtractArchive(archivePath: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', destination], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

export class AutoCodezLocalEngineManager {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher?: typeof fetch;
  private readonly extractArchive: (archivePath: string, destination: string) => Promise<void>;

  constructor(readonly rootDir: string, options: AutoCodezLocalEngineOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetcher = options.fetcher;
    this.extractArchive = options.extractArchive ?? defaultExtractArchive;
  }

  isSupported(): boolean {
    return this.platform === AUTO_CODEZ_LOCAL_ENGINE_ASSET.platform && this.arch === AUTO_CODEZ_LOCAL_ENGINE_ASSET.arch;
  }

  engineDir(): string {
    return path.join(this.rootDir, 'engine', AUTO_CODEZ_LOCAL_ENGINE_RELEASE);
  }

  executablePath(): string {
    return path.join(this.engineDir(), 'llama-server.exe');
  }

  private manifestPath(): string {
    return path.join(this.engineDir(), 'engine.json');
  }

  async isInstalled(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const [manifestRaw, executable] = await Promise.all([
        fs.readFile(this.manifestPath(), 'utf8'),
        fs.stat(this.executablePath()),
      ]);
      const manifest = JSON.parse(manifestRaw) as EngineManifest;
      return executable.isFile()
        && manifest.release === AUTO_CODEZ_LOCAL_ENGINE_RELEASE
        && manifest.asset === AUTO_CODEZ_LOCAL_ENGINE_ASSET.fileName
        && manifest.sha256 === AUTO_CODEZ_LOCAL_ENGINE_ASSET.sha256;
    } catch {
      return false;
    }
  }

  async ensureInstalled(
    signal?: AbortSignal,
    onProgress?: (progress: VerifiedDownloadProgress) => void,
  ): Promise<string> {
    if (!this.isSupported()) throw new Error('Auto CodeZ Local ainda suporta somente Windows x64 nesta versão.');
    if (await this.isInstalled()) return this.executablePath();

    const downloadsDir = path.join(this.rootDir, 'downloads');
    const archivePath = path.join(downloadsDir, AUTO_CODEZ_LOCAL_ENGINE_ASSET.fileName);
    const stagingDir = `${this.engineDir()}.staging`;
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.rm(stagingDir, { recursive: true, force: true });

    try {
      await downloadVerifiedFile({
        url: AUTO_CODEZ_LOCAL_ENGINE_ASSET.url,
        destination: archivePath,
        sha256: AUTO_CODEZ_LOCAL_ENGINE_ASSET.sha256,
        expectedBytes: AUTO_CODEZ_LOCAL_ENGINE_ASSET.bytes,
        maximumBytes: 32 * 1024 ** 2,
      }, { signal, fetcher: this.fetcher, onProgress });
      await this.extractArchive(archivePath, stagingDir);
      const executablePath = path.join(stagingDir, 'llama-server.exe');
      const executable = await fs.stat(executablePath).catch((): undefined => undefined);
      if (!executable?.isFile()) throw new Error('O pacote verificado do llama.cpp não contém llama-server.exe.');
      const manifest: EngineManifest = {
        release: AUTO_CODEZ_LOCAL_ENGINE_RELEASE,
        asset: AUTO_CODEZ_LOCAL_ENGINE_ASSET.fileName,
        sha256: AUTO_CODEZ_LOCAL_ENGINE_ASSET.sha256,
      };
      await fs.writeFile(path.join(stagingDir, 'engine.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await fs.rm(this.engineDir(), { recursive: true, force: true });
      await fs.mkdir(path.dirname(this.engineDir()), { recursive: true });
      await fs.rename(stagingDir, this.engineDir());
      return this.executablePath();
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch((): undefined => undefined);
      throw error;
    } finally {
      await fs.rm(archivePath, { force: true }).catch((): undefined => undefined);
    }
  }
}
