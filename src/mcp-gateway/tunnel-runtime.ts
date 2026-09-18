import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MINIMUM_TUNNEL_VERSION = [0, 0, 14] as const;
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOG_CHARS = 16_384;

export type McpTunnelStatus = {
  running: boolean;
  ready: boolean;
  version?: string;
  tunnelId?: string;
  localEndpoint?: string;
  healthUrl?: string;
  error?: string;
};

export type McpTunnelListener = (status: McpTunnelStatus) => void;

export type McpTunnelStartInput = {
  tunnelId: string;
  localEndpoint: string;
  localBearerToken: string;
  executable?: string;
  controlPlaneApiKey?: string;
};

type SpawnOptions = {
  windowsHide: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
};

export type McpTunnelSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

type ActiveTunnel = {
  child: ChildProcessWithoutNullStreams;
  status: McpTunnelStatus;
  healthFile: string;
  stdout: string;
  stderr: string;
};

function parseSemver(value: string): [number, number, number] | undefined {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedTunnelClientVersion(value: string): boolean {
  const parsed = parseSemver(value);
  if (!parsed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > MINIMUM_TUNNEL_VERSION[index]) return true;
    if (parsed[index] < MINIMUM_TUNNEL_VERSION[index]) return false;
  }
  return true;
}

function requireTunnelId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Tunnel ID inválido.');
  const normalized = value.trim();
  if (!TUNNEL_ID_PATTERN.test(normalized)) throw new Error('Tunnel ID inválido.');
  return normalized;
}

function requireExecutable(value: unknown): string {
  if (value === undefined) return 'tunnel-client';
  if (typeof value !== 'string') throw new Error('Executável tunnel-client inválido.');
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096 || /[\u0000\r\n]/.test(normalized)) throw new Error('Executável tunnel-client inválido.');
  return normalized;
}

function requireLocalEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Endpoint local do MCP Gateway inválido.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Endpoint local do MCP Gateway inválido.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
    throw new Error('O Secure MCP Tunnel só pode apontar para o endpoint localhost /mcp do Auto CodeZ.');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta do MCP Gateway inválida.');
  return url.toString();
}

function requireSecret(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} ausente.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 8192 || /[\u0000\r\n]/.test(normalized)) throw new Error(`${label} inválida.`);
  return normalized;
}

function sanitizedError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|sess|proj)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .slice(0, 2048);
}

function appendLog(current: string, chunk: Buffer | string, redactions: string[] = []): string {
  let value = current + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  for (const secret of redactions) {
    if (secret) value = value.split(secret).join('[REDACTED]');
  }
  return sanitizedError(value).slice(-MAX_LOG_CHARS);
}

function createChildEnvironment(
  parent: NodeJS.ProcessEnv,
  input: {
    tunnelId: string;
    endpoint: string;
    bearerToken: string;
    controlPlaneApiKey: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  env.CONTROL_PLANE_TUNNEL_ID = input.tunnelId;
  env.CONTROL_PLANE_API_KEY = input.controlPlaneApiKey;
  env.MCP_SERVER_URL = input.endpoint;
  env.AUTO_CODEZ_MCP_AUTHORIZATION = `Bearer ${input.bearerToken}`;
  env.MCP_EXTRA_HEADERS = 'Authorization: env:AUTO_CODEZ_MCP_AUTHORIZATION';
  env.MCP_DISCOVERY_EXTRA_HEADERS = 'Authorization: env:AUTO_CODEZ_MCP_AUTHORIZATION';
  env.MCP_STARTUP_WAIT_TIMEOUT = '15s';
  return env;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function processTreeKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = waitForChildExit(child, 3_000);
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      const timer = setTimeout(() => {
        if (!killer.killed) killer.kill();
        finish();
      }, 3_000);
      killer.once('error', finish);
      killer.once('exit', finish);
    });
  } else if (!child.killed) {
    child.kill('SIGTERM');
  }

  if (await exited) return;
  if (!child.killed) child.kill('SIGKILL');
  await waitForChildExit(child, 1_000);
}

async function readHealthUrl(file: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(file, 'utf8')).trim();
    const url = new URL(value);
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class McpTunnelRuntime {
  private active?: ActiveTunnel;
  private lastStatus: McpTunnelStatus = { running: false, ready: false };
  private readonly listeners = new Set<McpTunnelListener>();

  constructor(
    private readonly spawnProcess: McpTunnelSpawn = spawn as McpTunnelSpawn,
    private readonly parentEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly tempRoot = os.tmpdir(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  status(): McpTunnelStatus {
    return this.active ? { ...this.active.status } : { ...this.lastStatus };
  }

  subscribe(listener: McpTunnelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async doctor(executable?: string): Promise<{ executable: string; version: string; supported: true }> {
    const command = requireExecutable(executable);
    const result = await this.runVersion(command);
    if (!isSupportedTunnelClientVersion(result)) {
      throw new Error(`tunnel-client incompatível. Auto CodeZ requer v${MINIMUM_TUNNEL_VERSION.join('.')} ou posterior.`);
    }
    const version = parseSemver(result);
    if (!version) throw new Error('Não foi possível identificar a versão do tunnel-client.');
    return { executable: command, version: version.join('.'), supported: true };
  }

  async start(input: McpTunnelStartInput): Promise<McpTunnelStatus> {
    if (this.active) throw new Error('Secure MCP Tunnel já está em execução.');

    const tunnelId = requireTunnelId(input?.tunnelId);
    const localEndpoint = requireLocalEndpoint(input?.localEndpoint);
    const localBearerToken = requireSecret(input?.localBearerToken, 'Bearer local do MCP Gateway');
    const controlPlaneApiKey = requireSecret(
      input?.controlPlaneApiKey ?? this.parentEnvironment.CONTROL_PLANE_API_KEY ?? this.parentEnvironment.OPENAI_API_KEY,
      'Chave do control plane do Secure MCP Tunnel',
    );
    const doctor = await this.doctor(input?.executable);

    const healthDir = await fs.mkdtemp(path.join(this.tempRoot, 'auto-codez-mcp-tunnel-'));
    const healthFile = path.join(healthDir, 'health-url.txt');
    const args = [
      'run',
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', healthFile,
      '--log.level', 'info',
      '--log.format', 'struct-text',
    ];
    const env = createChildEnvironment(this.parentEnvironment, {
      tunnelId,
      endpoint: localEndpoint,
      bearerToken: localBearerToken,
      controlPlaneApiKey,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(doctor.executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      await fs.rm(healthDir, { recursive: true, force: true });
      throw new Error(`Não foi possível iniciar o Secure MCP Tunnel: ${sanitizedError(error)}`);
    }

    const active: ActiveTunnel = {
      child,
      healthFile,
      stdout: '',
      stderr: '',
      status: {
        running: true,
        ready: false,
        version: doctor.version,
        tunnelId,
        localEndpoint,
      },
    };
    this.active = active;
    this.lastStatus = { ...active.status };
    this.publishStatus();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const logRedactions = [controlPlaneApiKey, localBearerToken, `Bearer ${localBearerToken}`];
    child.stdout.on('data', (chunk: string) => { active.stdout = appendLog(active.stdout, chunk, logRedactions); });
    child.stderr.on('data', (chunk: string) => { active.stderr = appendLog(active.stderr, chunk, logRedactions); });
    child.once('error', (error) => this.finishActive(active, sanitizedError(error)));
    child.once('exit', (code) => this.finishActive(active, active.stderr.trim() || `tunnel-client encerrou com código ${code ?? 'desconhecido'}.`));

    try {
      await this.waitUntilReady(active);
      this.lastStatus = { ...active.status };
      this.publishStatus();
      return { ...active.status };
    } catch (error) {
      const message = sanitizedError(error);
      await this.stop();
      throw new Error(message);
    }
  }

  async stop(): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    this.active = undefined;
    this.lastStatus = { ...active.status, running: false, ready: false };
    this.publishStatus();
    await processTreeKill(active.child);
    await fs.rm(path.dirname(active.healthFile), { recursive: true, force: true }).catch((): undefined => undefined);
    return true;
  }

  private async runVersion(executable: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(executable, ['--version'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: createChildEnvironment(this.parentEnvironment, {
            tunnelId: 'tunnel_' + '0'.repeat(32),
            endpoint: 'http://127.0.0.1:1/mcp',
            bearerToken: 'doctor-placeholder-bearer',
            controlPlaneApiKey: 'doctor-placeholder-control-plane-key',
          }),
        });
      } catch (error) {
        reject(new Error(`tunnel-client não foi encontrado: ${sanitizedError(error)}`));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void processTreeKill(child);
        reject(new Error('tunnel-client --version excedeu o tempo limite.'));
      }, 5_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout = appendLog(stdout, chunk); });
      child.stderr.on('data', (chunk: string) => { stderr = appendLog(stderr, chunk); });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`tunnel-client não foi encontrado: ${sanitizedError(error)}`));
      });
      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`tunnel-client --version falhou: ${sanitizedError(stderr || `código ${code}`)}`));
        else resolve((stdout || stderr).trim());
      });
    });
  }

  private async waitUntilReady(active: ActiveTunnel): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.active !== active) throw new Error('Secure MCP Tunnel foi encerrado durante a inicialização.');
      const healthUrl = await readHealthUrl(active.healthFile);
      if (healthUrl) {
        active.status.healthUrl = healthUrl;
        try {
          const response = await this.fetchImpl(new URL('/readyz', healthUrl), { signal: AbortSignal.timeout(2_000) });
          if (response.ok) {
            active.status.ready = true;
            return;
          }
        } catch {
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(active.stderr.trim() || 'Secure MCP Tunnel não ficou pronto dentro do tempo limite.');
  }

  private finishActive(active: ActiveTunnel, reason: string): void {
    if (this.active !== active) return;
    active.status = {
      ...active.status,
      running: false,
      ready: false,
      error: sanitizedError(reason),
    };
    this.lastStatus = { ...active.status };
    this.active = undefined;
    this.publishStatus();
    void fs.rm(path.dirname(active.healthFile), { recursive: true, force: true }).catch((): undefined => undefined);
  }

  private publishStatus(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener({ ...status });
      } catch {
      }
    }
  }
}
