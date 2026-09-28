import fs from 'node:fs/promises';
import path from 'node:path';

export type ClaudeDesktopExtensionState = 'not-configured' | 'prepared' | 'configured' | 'unsupported';

export type ClaudeDesktopExtensionStatus = {
  clientId: 'claude-desktop';
  state: ClaudeDesktopExtensionState;
  configPath: string;
  detail: string;
};

export type ClaudeDesktopExtensionManagerOptions = {
  extensionRoot: string;
  claudeUserDataPath: string;
  brokerAddress: string;
  appPath: string;
  appArgument?: string;
  appVersion: string;
  platform?: NodeJS.Platform;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsAutoCodezManifest(value: unknown, depth = 0): boolean {
  if (depth > 16 || !value) return false;
  if (Array.isArray(value)) return value.some((item) => containsAutoCodezManifest(item, depth + 1));
  if (!isRecord(value)) return false;
  if (isRecord(value.manifest) && value.manifest.name === 'auto-codez') return true;
  return Object.values(value).some((item) => containsAutoCodezManifest(item, depth + 1));
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export class ClaudeDesktopExtensionManager {
  constructor(private readonly options: ClaudeDesktopExtensionManagerOptions) {}

  private get manifestPath(): string {
    return path.join(this.options.extensionRoot, 'manifest.json');
  }

  private get serverPath(): string {
    return path.join(this.options.extensionRoot, 'server', 'index.cjs');
  }

  private get installationsPath(): string {
    return path.join(this.options.claudeUserDataPath, 'extensions-installations.json');
  }

  private manifest(): Record<string, unknown> {
    return {
      manifest_version: '0.3',
      name: 'auto-codez',
      display_name: 'Auto CodeZ',
      version: this.options.appVersion,
      description: 'Conecta o Claude Desktop às ferramentas MCP autorizadas do Auto CodeZ.',
      author: { name: 'Auto CodeZ' },
      server: {
        type: 'node',
        entry_point: 'server/index.cjs',
        mcp_config: {
          command: 'node',
          args: ['${__dirname}/server/index.cjs'],
          env: {},
        },
      },
      tools_generated: true,
      keywords: ['auto-codez', 'mcp', 'development', 'workspace'],
      license: 'MIT',
      compatibility: {
        claude_desktop: '>=1.0.0',
        platforms: ['win32'],
        runtimes: { node: '>=18.0.0' },
      },
    };
  }

  private serverSource(): string {
    const brokerAddress = JSON.stringify(this.options.brokerAddress);
    const appPath = JSON.stringify(this.options.appPath);
    const appArgument = JSON.stringify(this.options.appArgument ?? '');
    return `'use strict';

const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const BROKER_ADDRESS = ${brokerAddress};
const APP_PATH = ${appPath};
const APP_ARGUMENT = ${appArgument};
const CLIENT_ID = 'claude-desktop';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBinding() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(BROKER_ADDRESS);
    let settled = false;
    let buffer = '';

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const parseBuffer = () => {
      const line = buffer.split(/\\r?\\n/, 1)[0].trim();
      if (!line || line === 'null') return finish(null, null);
      try {
        const value = JSON.parse(line);
        if (!value || typeof value.endpoint !== 'string' || typeof value.bearerToken !== 'string') return finish(null, null);
        return finish(null, value);
      } catch (error) {
        return finish(error);
      }
    };

    socket.setEncoding('utf8');
    socket.setTimeout(1500, () => finish(new Error('Tempo limite ao consultar o broker MCP do Auto CodeZ.')));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\\n')) parseBuffer();
    });
    socket.on('end', parseBuffer);
    socket.on('error', (error) => finish(error));
  });
}

function launchAutoCodez() {
  const args = APP_ARGUMENT ? [APP_ARGUMENT] : [];
  const child = spawn(APP_PATH, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function resolveBinding() {
  try {
    const binding = await readBinding();
    if (binding) return binding;
  } catch {}

  launchAutoCodez();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      const binding = await readBinding();
      if (binding) return binding;
    } catch {}
  }
  throw new Error('Auto CodeZ não iniciou o MCP local dentro do tempo esperado.');
}

async function invokeMcp(binding, payload) {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: {
      authorization: \`Bearer \${binding.bearerToken}\`,
      'content-type': 'application/json',
      'x-auto-codez-mcp-client': CLIENT_ID,
    },
    body: payload,
  });
  if (response.status === 202) return null;
  const body = await response.text();
  if (!response.ok) throw new Error(\`MCP Gateway retornou HTTP \${response.status}.\`);
  return body;
}

async function main() {
  let binding = await resolveBinding();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let requestId = null;
    try {
      const request = JSON.parse(line);
      requestId = request && Object.prototype.hasOwnProperty.call(request, 'id') ? request.id : null;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON-RPC inválido.' } }) + '\\n');
      continue;
    }

    try {
      let response;
      try {
        response = await invokeMcp(binding, line);
      } catch {
        binding = await resolveBinding();
        response = await invokeMcp(binding, line);
      }
      if (response !== null) process.stdout.write(response + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      }) + '\\n');
    }
  }
}

main().catch((error) => {
  process.stderr.write('Auto CodeZ MCP extension: ' + (error instanceof Error ? error.message : String(error)) + '\\n');
  process.exitCode = 1;
});
`;
  }

  private async installedInClaude(): Promise<boolean> {
    const registry = await readJson(this.installationsPath);
    return containsAutoCodezManifest(registry);
  }

  private async preparedAndCurrent(): Promise<boolean> {
    try {
      const [manifestText, serverText] = await Promise.all([
        fs.readFile(this.manifestPath, 'utf8'),
        fs.readFile(this.serverPath, 'utf8'),
      ]);
      return manifestText === JSON.stringify(this.manifest(), null, 2) + '\n'
        && serverText === this.serverSource();
    } catch {
      return false;
    }
  }

  async status(): Promise<ClaudeDesktopExtensionStatus> {
    if ((this.options.platform ?? process.platform) !== 'win32') {
      return {
        clientId: 'claude-desktop',
        state: 'unsupported',
        configPath: this.options.extensionRoot,
        detail: 'A extensão local do Claude Desktop está disponível no Windows nesta versão.',
      };
    }
    if (await this.installedInClaude()) {
      return {
        clientId: 'claude-desktop',
        state: 'configured',
        configPath: this.options.extensionRoot,
        detail: 'Extensão Auto CodeZ detectada no registro real do Claude Desktop.',
      };
    }
    if (await this.preparedAndCurrent()) {
      return {
        clientId: 'claude-desktop',
        state: 'prepared',
        configPath: this.options.extensionRoot,
        detail: 'Extensão local pronta. Falta instalá-la uma vez no Claude Desktop.',
      };
    }
    return {
      clientId: 'claude-desktop',
      state: 'not-configured',
      configPath: this.options.extensionRoot,
      detail: 'A extensão local do Auto CodeZ ainda não foi preparada.',
    };
  }

  async prepare(): Promise<ClaudeDesktopExtensionStatus> {
    if ((this.options.platform ?? process.platform) !== 'win32') return this.status();
    await fs.mkdir(path.dirname(this.serverPath), { recursive: true });
    await Promise.all([
      fs.writeFile(this.manifestPath, JSON.stringify(this.manifest(), null, 2) + '\n', 'utf8'),
      fs.writeFile(this.serverPath, this.serverSource(), 'utf8'),
    ]);
    return this.status();
  }

  async removePrepared(): Promise<ClaudeDesktopExtensionStatus> {
    await fs.rm(this.options.extensionRoot, { recursive: true, force: true });
    return this.status();
  }
}
