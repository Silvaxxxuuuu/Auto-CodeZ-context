import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpRuntimeInstaller } from '../src/mcp-gateway/runtime-installer';

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true,
  });
  return child;
}

test('MCP runtime installer fails closed on unsupported architecture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-runtime-installer-'));
  try {
    const installer = new McpRuntimeInstaller(() => root, fetch, undefined, 'win32', 'ia32');
    const status = await installer.inspect();
    assert.equal(status.supported, false);
    assert.equal(status.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('MCP runtime installer downloads, verifies and installs the exact Windows amd64 release', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-runtime-installer-'));
  const archive = Buffer.alloc(100_001, 7);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const requested: string[] = [];

  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith('/SHA256SUMS.txt')) {
      return new Response(`${checksum}  tunnel-client-v0.0.14-windows-amd64.zip\n`, { status: 200 });
    }
    if (url.endsWith('/tunnel-client-v0.0.14-windows-amd64.zip')) {
      return new Response(archive, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const spawnProcess = ((command: string, args: string[]) => {
    const child = fakeChild();
    if (args.includes('--version')) {
      queueMicrotask(() => {
        (child.stdout as PassThrough).end('0.0.14+fixture\n');
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      });
      return child;
    }
    if (command === 'tar.exe') {
      const destination = args[args.indexOf('-C') + 1];
      void (async () => {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, 'tunnel-client.exe'), 'fixture', 'utf8');
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      })();
      return child;
    }
    queueMicrotask(() => {
      Object.defineProperty(child, 'exitCode', { value: 1, configurable: true });
      child.emit('exit', 1, null);
    });
    return child;
  }) as never;

  try {
    const installer = new McpRuntimeInstaller(() => root, fetchImpl, spawnProcess, 'win32', 'x64');
    const result = await installer.prepare();
    assert.equal(result.ready, true);
    assert.equal(result.managed, true);
    assert.equal(result.version, '0.0.14');
    assert.ok(result.executable?.endsWith(path.join('runtime', 'mcp', 'tunnel-client', '0.0.14', 'tunnel-client.exe')));
    assert.deepEqual(requested, [
      'https://github.com/openai/tunnel-client/releases/download/v0.0.14/SHA256SUMS.txt',
      'https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-windows-amd64.zip',
    ]);
    assert.equal(await fs.readFile(result.executable!, 'utf8'), 'fixture');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('MCP runtime installer rejects a release archive with a checksum mismatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-runtime-installer-'));
  const archive = Buffer.alloc(100_001, 9);
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/SHA256SUMS.txt')) {
      return new Response(`${'0'.repeat(64)}  tunnel-client-v0.0.14-windows-amd64.zip\n`, { status: 200 });
    }
    return new Response(archive, { status: 200 });
  }) as typeof fetch;
  try {
    const installer = new McpRuntimeInstaller(() => root, fetchImpl, undefined, 'win32', 'x64');
    await assert.rejects(() => installer.prepare(), /integridade/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
