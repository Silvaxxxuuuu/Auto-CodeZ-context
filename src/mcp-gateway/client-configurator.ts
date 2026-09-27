import fs from 'node:fs/promises';
import path from 'node:path';

export type McpLocalClientId = 'cursor';
export type McpClientConfigurationState = 'not-configured' | 'configured' | 'conflict' | 'unsupported';

export type McpClientConfigurationStatus = {
  clientId: McpLocalClientId;
  state: McpClientConfigurationState;
  configPath: string;
  detail: string;
};

type CursorConfigFile = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

type CursorServerConfig = {
  command: string;
  args: string[];
};

export type McpClientConfiguratorOptions = {
  cursorConfigPath: string;
  bridgeScriptPath: string;
  brokerAddress: string;
  appPath: string;
  platform?: NodeJS.Platform;
};

const SERVER_NAME = 'auto-codez';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectedServer(options: McpClientConfiguratorOptions): CursorServerConfig {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.bridgeScriptPath,
      '-BrokerAddress',
      options.brokerAddress,
      '-AppPath',
      options.appPath,
      '-ClientId',
      'cursor',
    ],
  };
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isManagedServer(value: unknown, expected: CursorServerConfig): boolean {
  if (!isRecord(value)) return false;
  return value.command === expected.command && sameStringArray(value.args, expected.args);
}

async function readCursorConfig(configPath: string): Promise<CursorConfigFile> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('Configuração global do Cursor precisa ser um objeto JSON.');
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
      throw new Error('A seção mcpServers do Cursor está em formato inválido.');
    }
    return parsed as CursorConfigFile;
  } catch (error) {
    if (isMissingFile(error)) return {};
    if (error instanceof SyntaxError) {
      throw new Error('O arquivo MCP global do Cursor contém JSON inválido. Corrija o arquivo antes de conectar o Auto CodeZ.');
    }
    throw error;
  }
}

async function writeJsonAtomic(configPath: string, value: CursorConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.autocodez-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, configPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch((): undefined => undefined);
  }
}

export class McpClientConfigurator {
  private readonly options: McpClientConfiguratorOptions;

  constructor(options: McpClientConfiguratorOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
    };
  }

  async status(clientId: McpLocalClientId): Promise<McpClientConfigurationStatus> {
    if (clientId !== 'cursor') throw new Error('Cliente MCP local inválido.');
    if (this.options.platform !== 'win32') {
      return {
        clientId,
        state: 'unsupported',
        configPath: this.options.cursorConfigPath,
        detail: 'A configuração automática do Cursor está disponível no Windows nesta versão.',
      };
    }

    const config = await readCursorConfig(this.options.cursorConfigPath);
    const current = config.mcpServers?.[SERVER_NAME];
    if (current === undefined) {
      return {
        clientId,
        state: 'not-configured',
        configPath: this.options.cursorConfigPath,
        detail: 'Cursor disponível para configuração automática.',
      };
    }

    if (isManagedServer(current, expectedServer(this.options))) {
      return {
        clientId,
        state: 'configured',
        configPath: this.options.cursorConfigPath,
        detail: 'Auto CodeZ já está configurado no Cursor.',
      };
    }

    return {
      clientId,
      state: 'conflict',
      configPath: this.options.cursorConfigPath,
      detail: 'Já existe uma conexão chamada auto-codez no Cursor que não foi criada por esta instalação.',
    };
  }

  async install(clientId: McpLocalClientId): Promise<McpClientConfigurationStatus> {
    if (clientId !== 'cursor') throw new Error('Cliente MCP local inválido.');
    if (this.options.platform !== 'win32') return this.status(clientId);

    await fs.access(this.options.bridgeScriptPath).catch(() => {
      throw new Error('O helper MCP do Auto CodeZ não foi encontrado nesta instalação.');
    });

    const config = await readCursorConfig(this.options.cursorConfigPath);
    const current = config.mcpServers?.[SERVER_NAME];
    const expected = expectedServer(this.options);
    if (current !== undefined && !isManagedServer(current, expected)) {
      throw new Error('Já existe uma conexão chamada auto-codez no Cursor. O Auto CodeZ não vai sobrescrever uma configuração que não criou.');
    }

    const next: CursorConfigFile = {
      ...config,
      mcpServers: {
        ...(config.mcpServers ?? {}),
        [SERVER_NAME]: expected,
      },
    };
    await writeJsonAtomic(this.options.cursorConfigPath, next);
    return this.status(clientId);
  }

  async remove(clientId: McpLocalClientId): Promise<McpClientConfigurationStatus> {
    if (clientId !== 'cursor') throw new Error('Cliente MCP local inválido.');
    if (this.options.platform !== 'win32') return this.status(clientId);

    const config = await readCursorConfig(this.options.cursorConfigPath);
    const current = config.mcpServers?.[SERVER_NAME];
    if (current === undefined) return this.status(clientId);

    const expected = expectedServer(this.options);
    if (!isManagedServer(current, expected)) {
      throw new Error('A conexão auto-codez existente no Cursor não pertence a esta instalação e não será removida.');
    }

    const servers = { ...(config.mcpServers ?? {}) };
    delete servers[SERVER_NAME];
    const next: CursorConfigFile = { ...config };
    if (Object.keys(servers).length) next.mcpServers = servers;
    else delete next.mcpServers;
    await writeJsonAtomic(this.options.cursorConfigPath, next);
    return this.status(clientId);
  }
}
