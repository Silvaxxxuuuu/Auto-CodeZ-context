import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { McpGatewayBridgeBinding } from './binding-store';

const MAX_RESPONSE_BYTES = 8 * 1024;
const CONNECT_TIMEOUT_MS = 1_500;

export function mcpBindingBrokerAddress(appDataRoot: string): string {
  const digest = crypto.createHash('sha256').update(path.resolve(appDataRoot)).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\auto-codez-mcp-${digest}`;
  return path.join(os.tmpdir(), `auto-codez-mcp-${digest}.sock`);
}

export class McpGatewayBindingBroker {
  private server?: net.Server;

  constructor(
    private readonly address: string,
    private readonly resolveBinding: () => Promise<McpGatewayBridgeBinding | undefined>,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== 'win32') await fs.rm(this.address, { force: true }).catch((): undefined => undefined);
    const server = net.createServer((socket) => {
      socket.setTimeout(2_000);
      void this.resolveBinding()
        .then((binding) => {
          if (!binding) {
            socket.end('null\n');
            return;
          }
          socket.end(`${JSON.stringify(binding)}\n`);
        })
        .catch(() => socket.end('null\n'));
    });
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.address);
    });
    this.server = server;
    if (process.platform !== 'win32') await fs.chmod(this.address, 0o600).catch((): undefined => undefined);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(this.address, { force: true }).catch((): undefined => undefined);
  }
}

export async function readMcpGatewayBindingFromBroker(address: string): Promise<McpGatewayBridgeBinding | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    let settled = false;
    let body = '';
    const finish = (value?: McpGatewayBridgeBinding) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), CONNECT_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('connect', () => clearTimeout(timer));
    socket.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) finish();
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish();
    });
    socket.once('end', () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(body.trim()) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          finish();
          return;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.endpoint !== 'string' || typeof record.bearerToken !== 'string' || !Number.isInteger(record.ownerPid) || typeof record.updatedAt !== 'number') {
          finish();
          return;
        }
        finish({
          endpoint: record.endpoint,
          bearerToken: record.bearerToken,
          ownerPid: Number(record.ownerPid),
          updatedAt: record.updatedAt,
        });
      } catch {
        finish();
      }
    });
  });
}
