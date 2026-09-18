import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Session = { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; buffer: string; nextId: number; closed: boolean; closeReason?: string; protocolVersion?: string; serverName?: string; serverVersion?: string };
export type McpConnectInput = { command: string; args?: string[]; timeoutMs?: number };
export type McpToolDescriptor = { name: string; description?: string; inputSchema?: unknown };
export type McpToolList = { tools: McpToolDescriptor[] };
export type McpSessionStatus = { connected: boolean; protocolVersion?: string; serverName?: string; serverVersion?: string };
export type McpSpawn = (command: string, args: string[], options: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
export type RobloxStudioLaunchPlan = { command: string; args: string[] };

const DEFAULT_TIMEOUT = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 4;
const MAX_SERVER_TOOL_CATALOG = 256;

export function resolveRobloxStudioMcpCommand(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error('LOCALAPPDATA não está disponível para localizar o Roblox Studio MCP.');
    const candidate = path.join(localAppData, 'Roblox', 'mcp.bat');
    if (!fs.existsSync(candidate)) throw new Error('Roblox Studio MCP não foi encontrado. Atualize ou abra o Roblox Studio e tente novamente.');
    return candidate;
  }
  if (platform === 'darwin') {
    const candidate = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP';
    if (!fs.existsSync(candidate)) throw new Error('Roblox Studio MCP não foi encontrado. Atualize ou abra o Roblox Studio e tente novamente.');
    return candidate;
  }
  throw new Error('O MCP oficial do Roblox Studio é suportado pelo Auto CodeZ apenas no Windows e macOS.');
}

export function buildRobloxStudioLaunchPlan(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  launcher = resolveRobloxStudioMcpCommand(platform, env),
): RobloxStudioLaunchPlan {
  if (platform === 'win32') return { command: env.ComSpec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', launcher] };
  return { command: launcher, args: [] };
}

function timeout(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT;
  if (!Number.isInteger(value) || value < 1000 || value > 120_000) throw new Error('Timeout MCP inválido.');
  return value;
}

function command(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Comando MCP inválido.');
  const result = value.trim();
  if (!result || result.length > 4096 || /[\u0000\r\n]/.test(result)) throw new Error('Comando MCP inválido.');
  return result;
}

function args(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error('Argumentos MCP inválidos.');
  return value.map((item) => {
    if (typeof item !== 'string' || item.length > 8192 || /\u0000/.test(item)) throw new Error('Argumento MCP inválido.');
    return item;
  });
}

export class PluginMcpStdioRuntime {
  private readonly sessions = new Map<string, Map<string, Session>>();

  constructor(private readonly spawnProcess: McpSpawn = spawn) {}

  async connect(pluginId: string, input: McpConnectInput): Promise<{ sessionId: string; protocolVersion?: string; serverName?: string; serverVersion?: string }> {
    const owned = this.sessions.get(pluginId) ?? new Map<string, Session>();
    if (owned.size >= MAX_SESSIONS) throw new Error('Plugin excedeu o limite de sessões MCP.');
    const requestedCommand = command(input?.command);
    const requestedArgs = args(input?.args);
    const child = this.spawnProcess(requestedCommand, requestedArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const sessionId = crypto.randomUUID();
    const session: Session = { child, pending: new Map(), buffer: '', nextId: 1, closed: false };
    owned.set(sessionId, session);
    this.sessions.set(pluginId, owned);
    this.bind(pluginId, sessionId, session);
    try {
      const result = await this.request(session, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Auto CodeZ', version: '2.0.0-alpha.1' },
      }, timeout(input?.timeoutMs)) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } };
      if (!result?.protocolVersion || typeof result.protocolVersion !== 'string' || result.protocolVersion.length > 128) throw new Error('Servidor MCP retornou protocolVersion inválida.');
      session.protocolVersion = result.protocolVersion;
      if (typeof result?.serverInfo?.name === 'string') session.serverName = result.serverInfo.name;
      if (typeof result?.serverInfo?.version === 'string') session.serverVersion = result.serverInfo.version;
      this.notify(session, 'notifications/initialized', {});
      return {
        sessionId,
        ...(typeof result?.protocolVersion === 'string' ? { protocolVersion: result.protocolVersion } : {}),
        ...(typeof result?.serverInfo?.name === 'string' ? { serverName: result.serverInfo.name } : {}),
        ...(typeof result?.serverInfo?.version === 'string' ? { serverVersion: result.serverInfo.version } : {}),
      };
    } catch (error) {
      this.disconnect(pluginId, sessionId);
      throw error;
    }
  }

  async connectRobloxStudio(pluginId: string, timeoutMs?: number): Promise<{ sessionId: string; protocolVersion?: string; serverName?: string; serverVersion?: string }> {
    const plan = buildRobloxStudioLaunchPlan();
    return this.connect(pluginId, { ...plan, timeoutMs });
  }

  async listTools(pluginId: string, sessionId: string, timeoutMs?: number): Promise<McpToolList> {
    const session = this.requireSession(pluginId, sessionId);
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 64; page += 1) {
      const result = await this.request(session, 'tools/list', cursor ? { cursor } : {}, timeout(timeoutMs));
      if (!result || typeof result !== 'object' || !Array.isArray((result as { tools?: unknown }).tools)) throw new Error('Servidor MCP retornou catálogo de tools inválido.');
      const pageTools = (result as { tools: unknown[] }).tools.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Servidor MCP retornou tool inválida.');
      const value = item as Record<string, unknown>;
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256) throw new Error('Servidor MCP retornou tool inválida.');
      return {
        name: value.name.trim(),
        ...(typeof value.description === 'string' ? { description: value.description.slice(0, 4096) } : {}),
        ...(Object.prototype.hasOwnProperty.call(value, 'inputSchema') ? { inputSchema: value.inputSchema } : {}),
      };
      });
      for (const tool of pageTools) {
        if (seen.has(tool.name)) throw new Error(`Servidor MCP retornou tool duplicada: '${tool.name}'.`);
        seen.add(tool.name);
        tools.push(tool);
        if (tools.length > MAX_SERVER_TOOL_CATALOG) throw new Error('Servidor MCP excedeu o limite de 256 tools.');
      }
      const next = (result as { nextCursor?: unknown }).nextCursor;
      if (next === undefined || next === null || next === '') return { tools };
      if (typeof next !== 'string' || next.length > 4096) throw new Error('Servidor MCP retornou cursor de paginação inválido.');
      cursor = next;
    }
    throw new Error('Servidor MCP excedeu o limite de paginação de tools.');
  }

  callTool(pluginId: string, sessionId: string, name: string, input: unknown, timeoutMs?: number): Promise<unknown> {
    if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('Tool MCP inválida.');
    const toolInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return this.request(this.requireSession(pluginId, sessionId), 'tools/call', { name: name.trim(), arguments: toolInput }, timeout(timeoutMs));
  }

  status(pluginId: string, sessionId: string): McpSessionStatus {
    const session = this.sessions.get(pluginId)?.get(sessionId);
    if (!session || session.closed) return { connected: false };
    return {
      connected: true,
      ...(session.protocolVersion ? { protocolVersion: session.protocolVersion } : {}),
      ...(session.serverName ? { serverName: session.serverName } : {}),
      ...(session.serverVersion ? { serverVersion: session.serverVersion } : {}),
    };
  }

  disconnect(pluginId: string, sessionId: string): boolean {
    const owned = this.sessions.get(pluginId);
    const session = owned?.get(sessionId);
    if (!session) return false;
    owned?.delete(sessionId);
    if (owned?.size === 0) this.sessions.delete(pluginId);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Sessão MCP encerrada.'));
    }
    session.pending.clear();
    session.closed = true;
    session.closeReason = 'Sessão MCP encerrada.';
    session.child.kill();
    return true;
  }

  disconnectPlugin(pluginId: string): void {
    const owned = this.sessions.get(pluginId);
    if (!owned) return;
    for (const id of [...owned.keys()]) this.disconnect(pluginId, id);
  }

  private bind(pluginId: string, sessionId: string, session: Session): void {
    session.child.stdout.setEncoding('utf8');
    session.child.stdout.on('data', (chunk: string) => this.consume(session, chunk));
    let stderr = '';
    session.child.stderr.setEncoding('utf8');
    session.child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    const close = (reason: string) => {
      if (session.closed) return;
      session.closed = true;
      session.closeReason = stderr.trim() || reason;
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(stderr.trim() || reason));
      }
      session.pending.clear();
      this.sessions.get(pluginId)?.delete(sessionId);
      if (this.sessions.get(pluginId)?.size === 0) this.sessions.delete(pluginId);
    };
    session.child.once('error', (error) => close(error.message));
    session.child.once('exit', (code) => close(`Servidor MCP encerrou com código ${code ?? 'desconhecido'}.`));
  }

  private consume(session: Session, chunk: string): void {
    session.buffer += chunk;
    let newline = session.buffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = session.buffer.slice(0, newline);
      session.buffer = session.buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, 'utf8') > MAX_LINE_BYTES) { session.child.kill(); return; }
      const line = rawLine.trim();
      if (line) {
        try {
          const message = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown } };
          if (message.jsonrpc !== '2.0') { session.child.kill(); return; }
          if (typeof message.id === 'number') {
            const pending = session.pending.get(message.id);
            if (pending) {
              session.pending.delete(message.id);
              clearTimeout(pending.timer);
              if (message.error) pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message.slice(0, 2048) : 'Servidor MCP retornou um erro.'));
              else pending.resolve(message.result);
            }
          }
        } catch {
          session.child.kill();
          return;
        }
      }
      newline = session.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(session.buffer, 'utf8') > MAX_LINE_BYTES) session.child.kill();
  }

  private request(session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (session.closed) return Promise.reject(new Error(session.closeReason || 'Sessão MCP encerrada.'));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Solicitação MCP '${method}' excedeu o tempo limite.`));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
          if (!error) return;
          const pending = session.pending.get(id);
          if (!pending) return;
          session.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } catch (error) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(session: Session, method: string, params: unknown): void {
    if (session.closed) throw new Error(session.closeReason || 'Sessão MCP encerrada.');
    session.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private requireSession(pluginId: string, sessionId: string): Session {
    const session = this.sessions.get(pluginId)?.get(sessionId);
    if (!session) throw new Error('Sessão MCP não encontrada para este plugin.');
    return session;
  }
}
