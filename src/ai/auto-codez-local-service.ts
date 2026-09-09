import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { AutoCodezLocalRuntimeAdapter } from './local-runtimes/auto-codez-local';

const START_TIMEOUT_MS = 90_000;
const HEALTH_RETRY_MS = 300;

type ActiveServer = {
  modelId: string;
  endpoint: string;
  process: ChildProcess;
};

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta local para a IA.'));
        else resolve(port);
      });
    });
  });
}

function abortError(): Error {
  const error = new Error('Inicialização da IA local cancelada.');
  error.name = 'AbortError';
  return error;
}

export class AutoCodezLocalService {
  readonly runtime: AutoCodezLocalRuntimeAdapter;
  private active?: ActiveServer;
  private startInFlight?: Promise<string>;

  constructor(readonly rootDir: string) {
    this.runtime = new AutoCodezLocalRuntimeAdapter(rootDir);
  }

  async listInstalled() {
    return this.runtime.listInstalled();
  }

  async ensureServer(modelId: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError();
    if (this.active?.modelId === modelId && !this.active.process.killed && this.active.process.exitCode === null) {
      return this.active.endpoint;
    }
    if (this.startInFlight) {
      const endpoint = await this.startInFlight;
      if (this.active?.modelId === modelId) return endpoint;
    }
    this.startInFlight = this.startServer(modelId, signal).finally(() => {
      this.startInFlight = undefined;
    });
    return this.startInFlight;
  }

  private async startServer(modelId: string, signal?: AbortSignal): Promise<string> {
    await this.stop();
    const modelPath = await this.runtime.modelPath(modelId);
    if (!modelPath) throw new Error('O modelo selecionado não está instalado no Auto CodeZ Local.');
    const executable = await this.runtime.engine.ensureInstalled(signal);
    const port = await reservePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const child = spawn(executable, [
      '--model', modelPath,
      '--alias', modelId,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--jinja',
      '--ctx-size', '32768',
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const active: ActiveServer = { modelId, endpoint, process: child };
    this.active = active;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_384);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError();
        if (child.exitCode !== null) throw new Error(`O mecanismo local encerrou durante a inicialização.${stderr ? ` ${stderr.trim()}` : ''}`);
        try {
          const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) return endpoint;
        } catch {
          // The server is still loading the model.
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
      }
      throw new Error('O modelo local demorou demais para ficar pronto.');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (!active || active.process.exitCode !== null || active.process.killed) return;
    active.process.kill();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (active.process.exitCode === null && !active.process.killed) active.process.kill('SIGKILL');
        resolve();
      }, 2_000);
      active.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

let configuredService: AutoCodezLocalService | undefined;

export function configureAutoCodezLocalService(rootDir: string): AutoCodezLocalService {
  configuredService = new AutoCodezLocalService(rootDir);
  return configuredService;
}

export function getAutoCodezLocalService(): AutoCodezLocalService | undefined {
  return configuredService;
}
