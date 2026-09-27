import fs from 'node:fs/promises';
import path from 'node:path';

export type McpLocalClientId = 'cursor' | 'codex' | 'claude-code';
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

type ClaudeCodeServerConfig = CursorServerConfig & {
  type: 'stdio';
};

export type McpClientConfiguratorOptions = {
  cursorConfigPath: string;
  codexConfigPath: string;
  claudeCodeConfigPath: string;
  bridgeScriptPath: string;
  brokerAddress: string;
  appPath: string;
  platform?: NodeJS.Platform;
};

const SERVER_NAME = 'auto-codez';
const CODEX_MANAGED_START = '# >>> Auto CodeZ MCP: auto-codez';
const CODEX_MANAGED_END = '# <<< Auto CodeZ MCP: auto-codez';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectedServer(options: McpClientConfiguratorOptions, clientId: McpLocalClientId): CursorServerConfig {
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
      clientId,
    ],
  };
}

function expectedClaudeCodeServer(options: McpClientConfiguratorOptions): ClaudeCodeServerConfig {
  return {
    type: 'stdio',
    ...expectedServer(options, 'claude-code'),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexManagedBlock(options: McpClientConfiguratorOptions): string {
  const server = expectedServer(options, 'codex');
  return [
    CODEX_MANAGED_START,
    '[mcp_servers.auto-codez]',
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map((value) => tomlString(value)).join(', ')}]`,
    CODEX_MANAGED_END,
  ].join('\n');
}

function codexManagedRange(text: string): { start: number; end: number; block: string } | undefined {
  const start = text.indexOf(CODEX_MANAGED_START);
  if (start < 0) return undefined;
  const endMarker = text.indexOf(CODEX_MANAGED_END, start + CODEX_MANAGED_START.length);
  if (endMarker < 0) throw new Error('A seção MCP gerenciada pelo Auto CodeZ no config.toml está incompleta.');
  const end = endMarker + CODEX_MANAGED_END.length;
  return { start, end, block: text.slice(start, end) };
}

function codexHasExternalConflict(text: string): boolean {
  const withoutManaged = (() => {
    const range = codexManagedRange(text);
    return range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text;
  })();
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:auto-codez|"auto-codez"|'auto-codez')\s*\]\s*$/mi.test(withoutManaged)
    || /^\s*mcp_servers\s*\.\s*(?:auto-codez|"auto-codez"|'auto-codez')\s*=/mi.test(withoutManaged);
}

async function readText(configPath: string): Promise<string> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return '';
    throw error;
  }
}

async function writeTextAtomic(configPath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.autocodez-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, configPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch((): undefined => undefined);
  }
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

function isManagedClaudeCodeServer(value: unknown, expected: ClaudeCodeServerConfig): boolean {
  return isRecord(value)
    && value.type === expected.type
    && isManagedServer(value, expected);
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

async function readClaudeCodeConfig(configPath: string): Promise<CursorConfigFile> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('A configuração global do Claude Code precisa ser um objeto JSON.');
    if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
      throw new Error('A seção mcpServers do Claude Code está em formato inválido.');
    }
    return parsed as CursorConfigFile;
  } catch (error) {
    if (isMissingFile(error)) return {};
    if (error instanceof SyntaxError) {
      throw new Error('O ~/.claude.json contém JSON inválido. Corrija o arquivo antes de conectar o Auto CodeZ.');
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
    const configPath = clientId === 'cursor'
      ? this.options.cursorConfigPath
      : clientId === 'codex'
        ? this.options.codexConfigPath
        : this.options.claudeCodeConfigPath;
    if (this.options.platform !== 'win32') {
      return {
        clientId,
        state: 'unsupported',
        configPath,
        detail: `A configuração automática do ${clientId === 'cursor' ? 'Cursor' : clientId === 'codex' ? 'Codex' : 'Claude Code'} está disponível no Windows nesta versão.`,
      };
    }

    if (clientId === 'codex') {
      const text = await readText(this.options.codexConfigPath);
      if (codexHasExternalConflict(text)) {
        return {
          clientId,
          state: 'conflict',
          configPath,
          detail: 'Já existe uma conexão chamada auto-codez no Codex que não foi criada por esta instalação.',
        };
      }
      const range = codexManagedRange(text);
      if (!range) {
        return {
          clientId,
          state: 'not-configured',
          configPath,
          detail: 'Codex disponível para configuração automática.',
        };
      }
      const expected = codexManagedBlock(this.options);
      return range.block.trim() === expected.trim()
        ? { clientId, state: 'configured', configPath, detail: 'Auto CodeZ já está configurado no Codex.' }
        : { clientId, state: 'not-configured', configPath, detail: 'A configuração gerenciada do Codex precisa ser atualizada.' };
    }

    if (clientId === 'claude-code') {
      const config = await readClaudeCodeConfig(this.options.claudeCodeConfigPath);
      const current = config.mcpServers?.[SERVER_NAME];
      if (current === undefined) {
        return {
          clientId,
          state: 'not-configured',
          configPath,
          detail: 'Claude Code disponível para configuração automática.',
        };
      }
      const expected = expectedClaudeCodeServer(this.options);
      if (isManagedClaudeCodeServer(current, expected)) {
        return {
          clientId,
          state: 'configured',
          configPath,
          detail: 'Auto CodeZ já está configurado no Claude Code.',
        };
      }
      return {
        clientId,
        state: 'conflict',
        configPath,
        detail: 'Já existe uma conexão chamada auto-codez no Claude Code que não foi criada por esta instalação.',
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

    if (isManagedServer(current, expectedServer(this.options, 'cursor'))) {
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
    if (this.options.platform !== 'win32') return this.status(clientId);

    await fs.access(this.options.bridgeScriptPath).catch(() => {
      throw new Error('O helper MCP do Auto CodeZ não foi encontrado nesta instalação.');
    });

    if (clientId === 'codex') {
      const current = await readText(this.options.codexConfigPath);
      if (codexHasExternalConflict(current)) {
        throw new Error('Já existe uma conexão chamada auto-codez no Codex. O Auto CodeZ não vai sobrescrever uma configuração que não criou.');
      }
      const managed = codexManagedRange(current);
      const base = managed
        ? `${current.slice(0, managed.start)}${current.slice(managed.end)}`.trimEnd()
        : current.trimEnd();
      const block = codexManagedBlock(this.options);
      const next = base ? `${base}\n\n${block}\n` : `${block}\n`;
      await writeTextAtomic(this.options.codexConfigPath, next);
      return this.status(clientId);
    }

    if (clientId === 'claude-code') {
      const config = await readClaudeCodeConfig(this.options.claudeCodeConfigPath);
      const current = config.mcpServers?.[SERVER_NAME];
      const expected = expectedClaudeCodeServer(this.options);
      if (current !== undefined && !isManagedClaudeCodeServer(current, expected)) {
        throw new Error('Já existe uma conexão chamada auto-codez no Claude Code. O Auto CodeZ não vai sobrescrever uma configuração que não criou.');
      }
      const next: CursorConfigFile = {
        ...config,
        mcpServers: {
          ...(config.mcpServers ?? {}),
          [SERVER_NAME]: expected,
        },
      };
      await writeJsonAtomic(this.options.claudeCodeConfigPath, next);
      return this.status(clientId);
    }

    const config = await readCursorConfig(this.options.cursorConfigPath);
    const current = config.mcpServers?.[SERVER_NAME];
    const expected = expectedServer(this.options, 'cursor');
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
    if (this.options.platform !== 'win32') return this.status(clientId);

    if (clientId === 'codex') {
      const current = await readText(this.options.codexConfigPath);
      if (codexHasExternalConflict(current)) {
        throw new Error('A conexão auto-codez existente no Codex não pertence a esta instalação e não será removida.');
      }
      const managed = codexManagedRange(current);
      if (!managed) return this.status(clientId);
      const next = `${current.slice(0, managed.start)}${current.slice(managed.end)}`
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
      await writeTextAtomic(this.options.codexConfigPath, next ? `${next}\n` : '');
      return this.status(clientId);
    }

    if (clientId === 'claude-code') {
      const config = await readClaudeCodeConfig(this.options.claudeCodeConfigPath);
      const current = config.mcpServers?.[SERVER_NAME];
      if (current === undefined) return this.status(clientId);
      const expected = expectedClaudeCodeServer(this.options);
      if (!isManagedClaudeCodeServer(current, expected)) {
        throw new Error('A conexão auto-codez existente no Claude Code não pertence a esta instalação e não será removida.');
      }
      const servers = { ...(config.mcpServers ?? {}) };
      delete servers[SERVER_NAME];
      const next: CursorConfigFile = { ...config };
      if (Object.keys(servers).length) next.mcpServers = servers;
      else delete next.mcpServers;
      await writeJsonAtomic(this.options.claudeCodeConfigPath, next);
      return this.status(clientId);
    }

    const config = await readCursorConfig(this.options.cursorConfigPath);
    const current = config.mcpServers?.[SERVER_NAME];
    if (current === undefined) return this.status(clientId);

    const expected = expectedServer(this.options, 'cursor');
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
