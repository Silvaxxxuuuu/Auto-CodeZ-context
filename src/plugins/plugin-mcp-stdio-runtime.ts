import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Session = { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; buffer: string; nextId: number };
export type McpConnectInput = { command: string; args?: string[]; timeoutMs?: number };
export type McpSpawn = (command: string, args: string[], options: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;

const DEFAULT_TIMEOUT = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 4;

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
    const child = this.spawnProcess(command(input?.command), args(input?.args), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const sessionId = crypto.randomUUID();
    const session: Session = { child, pending: new Map(), buffer: '', nextId: 1 };
    owned.set(sessionId, session);
    this.sessions.set(pluginId, owned);
    this.bind(pluginId, sessionId, session);
    try {
      const result = await this.request(session, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Auto CodeZ', version: '2.0.0-alpha.1' },
      }, timeout(input?.timeoutMs)) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } };
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

  listTools(pluginId: string, sessionId: string, timeoutMs?: number): Promise<unknown> {
    return this.request(this.requireSession(pluginId, sessionId), 'tools/list', {}, timeout(timeoutMs));
  }

  callTool(pluginId: string, sessionId: string, name: string, input: unknown, timeoutMs?: number): Promise<unknown> {
    if (typeof name !== 'string' || !name.trim() || name.length > 256) throw new Error('Tool MCP inválida.');
    const toolInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return this.request(this.requireSession(pluginId, sessionId), 'tools/call', { name: name.trim(), arguments: toolInput }, timeout(timeoutMs));
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
    if (Buffer.byteLength(session.buffer, 'utf8') > MAX_LINE_BYTES) {
      session.child.kill();
      return;
    }
    let newline = session.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = session.buffer.slice(0, newline).trim();
      session.buffer = session.buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown } };
          if (message.jsonrpc === '2.0' && typeof message.id === 'number') {
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
  }

  private request(session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Solicitação MCP '${method}' excedeu o tempo limite.`));
      }, timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      session.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(session: Session, method: string, params: unknown): void {
    session.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private requireSession(pluginId: string, sessionId: string): Session {
    const session = this.sessions.get(pluginId)?.get(sessionId);
    if (!session) throw new Error('Sessão MCP não encontrada para este plugin.');
    return session;
  }
}
