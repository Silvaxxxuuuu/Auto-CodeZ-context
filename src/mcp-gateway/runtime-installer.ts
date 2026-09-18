import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSupportedTunnelClientVersion } from './tunnel-runtime';

const TUNNEL_VERSION = '0.0.14';
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;

export type McpRuntimeStatus = {
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  ready: boolean;
  version: string;
  executable?: string;
  managed: boolean;
  error?: string;
};

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    windowsHide: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
    shell: false;
  },
) => ChildProcessWithoutNullStreams;

function platformAsset(platform: NodeJS.Platform, arch: string): { archive: string; executable: string } | undefined {
  const normalizedArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
  if (!normalizedArch) return undefined;
  if (platform === 'win32') return { archive: `tunnel-client-v${TUNNEL_VERSION}-windows-${normalizedArch}.zip`, executable: 'tunnel-client.exe' };
  if (platform === 'darwin') return { archive: `tunnel-client-v${TUNNEL_VERSION}-darwin-${normalizedArch}.zip`, executable: 'tunnel-client' };
  if (platform === 'linux') return { archive: `tunnel-client-v${TUNNEL_VERSION}-linux-${normalizedArch}.zip`, executable: 'tunnel-client' };
  return undefined;
}

function collect(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      reject(new Error('Tempo limite ao validar o runtime MCP.'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(root: string, name: string, depth = 0): Promise<string | undefined> {
  if (depth > 3) return undefined;
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findExecutable(path.join(root, entry.name), name, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export class McpRuntimeInstaller {
  private lastError = '';

  constructor(
    private readonly userDataRoot: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly spawnProcess: SpawnLike = spawn as SpawnLike,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch,
  ) {}

  status(): McpRuntimeStatus {
    const asset = platformAsset(this.platform, this.arch);
    return {
      platform: this.platform,
      arch: this.arch,
      supported: Boolean(asset),
      ready: false,
      version: TUNNEL_VERSION,
      managed: false,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async inspect(): Promise<McpRuntimeStatus> {
    const asset = platformAsset(this.platform, this.arch);
    if (!asset) return { ...this.status(), supported: false, error: 'Sistema ou arquitetura ainda não suportados pelo runtime MCP.' };

    const managed = this.managedExecutable(asset.executable);
    if (await exists(managed)) {
      const version = await this.validateExecutable(managed).catch(() => '');
      if (version) return { platform: this.platform, arch: this.arch, supported: true, ready: true, version, executable: managed, managed: true };
    }

    const pathVersion = await this.validateExecutable('tunnel-client').catch(() => '');
    if (pathVersion) return { platform: this.platform, arch: this.arch, supported: true, ready: true, version: pathVersion, executable: 'tunnel-client', managed: false };

    return this.status();
  }

  async prepare(): Promise<McpRuntimeStatus> {
    const current = await this.inspect();
    if (current.ready) return current;

    const asset = platformAsset(this.platform, this.arch);
    if (!asset) throw new Error('Seu sistema ou arquitetura ainda não possui um tunnel-client compatível.');

    const runtimeRoot = this.runtimeRoot();
    const finalExecutable = this.managedExecutable(asset.executable);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-mcp-runtime-'));
    const archivePath = path.join(tempRoot, asset.archive);
    const extractRoot = path.join(tempRoot, 'extract');

    try {
      await fs.mkdir(extractRoot, { recursive: true });
      const checksumUrl = `${RELEASE_BASE}/SHA256SUMS.txt`;
      const checksumResponse = await this.fetchImpl(checksumUrl, { redirect: 'follow' });
      if (!checksumResponse.ok) throw new Error(`Manifesto oficial de checksums indisponível (HTTP ${checksumResponse.status}).`);
      const checksumFinalUrl = new URL(checksumResponse.url || checksumUrl);
      if (checksumFinalUrl.protocol !== 'https:' || !['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(checksumFinalUrl.hostname)) {
        throw new Error('Origem inesperada ao baixar checksums do tunnel-client.');
      }
      const checksumText = await checksumResponse.text();
      const checksumLine = checksumText.split(/\r?\n/).find((line) => line.trim().endsWith(asset.archive));
      const checksumMatch = checksumLine?.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
      if (!checksumMatch || checksumMatch[2].trim() !== asset.archive) throw new Error('Checksum oficial do pacote tunnel-client não foi encontrado.');

      const url = `${RELEASE_BASE}/${asset.archive}`;
      const response = await this.fetchImpl(url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Download oficial do tunnel-client falhou (HTTP ${response.status}).`);
      const finalUrl = new URL(response.url || url);
      if (finalUrl.protocol !== 'https:' || !['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(finalUrl.hostname)) {
        throw new Error('Origem inesperada ao baixar o tunnel-client.');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 100_000 || bytes.byteLength > 200_000_000) throw new Error('Pacote do tunnel-client possui tamanho inesperado.');
      const actualChecksum = createHash('sha256').update(bytes).digest('hex');
      if (actualChecksum !== checksumMatch[1].toLowerCase()) throw new Error('Falha de integridade no pacote tunnel-client baixado.');
      await fs.writeFile(archivePath, bytes);
      await this.extractArchive(archivePath, extractRoot);
      const extracted = await findExecutable(extractRoot, asset.executable);
      if (!extracted) throw new Error('O pacote oficial não contém o executável tunnel-client esperado.');
      const version = await this.validateExecutable(extracted);
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.copyFile(extracted, finalExecutable);
      if (this.platform !== 'win32') await fs.chmod(finalExecutable, 0o755);
      const installedVersion = await this.validateExecutable(finalExecutable);
      this.lastError = '';
      return { platform: this.platform, arch: this.arch, supported: true, ready: true, version: installedVersion || version, executable: finalExecutable, managed: true };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch((): undefined => undefined);
    }
  }

  private runtimeRoot(): string {
    return path.join(this.userDataRoot(), 'runtime', 'mcp', 'tunnel-client', TUNNEL_VERSION);
  }

  private managedExecutable(name: string): string {
    return path.join(this.runtimeRoot(), name);
  }

  private async validateExecutable(executable: string): Promise<string> {
    const child = this.spawnProcess(executable, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const result = await collect(child);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0 || !isSupportedTunnelClientVersion(output)) throw new Error('tunnel-client incompatível.');
    const match = output.match(/(?:^|\s|v)(\d+\.\d+\.\d+)(?:\b|[-+])/);
    if (!match) throw new Error('Versão do tunnel-client não identificada.');
    return match[1];
  }

  private async extractArchive(archive: string, destination: string): Promise<void> {
    const command = this.platform === 'win32' ? 'tar.exe' : 'unzip';
    const args = this.platform === 'win32'
      ? ['-xf', archive, '-C', destination]
      : ['-q', '-o', archive, '-d', destination];
    const child = this.spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const result = await collect(child, 20_000);
    if (result.code !== 0) throw new Error('Não foi possível extrair o runtime MCP baixado.');
  }
}
