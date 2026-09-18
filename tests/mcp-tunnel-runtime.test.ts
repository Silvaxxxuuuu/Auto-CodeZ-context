import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  isSupportedTunnelClientVersion,
  McpTunnelRuntime,
  type McpTunnelSpawn,
} from '../src/mcp-gateway/tunnel-runtime';

type SpawnRecord = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: ChildProcessWithoutNullStreams;
};

function fakeChild(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    killed: false,
    kill: () => {
      Object.defineProperty(emitter, 'killed', { value: true, configurable: true, writable: true });
      queueMicrotask(() => emitter.emit('exit', 0, null));
      return true;
    },
  });
  return emitter;
}

function fixture(options: { version?: string; ready?: boolean } = {}) {
  const records: SpawnRecord[] = [];
  const rootPromise = fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-tunnel-test-'));
  const spawnProcess: McpTunnelSpawn = ((command, args, spawnOptions) => {
    const child = fakeChild();
    records.push({ command, args: [...args], env: { ...spawnOptions.env }, child });
    if (args.includes('--version')) {
      queueMicrotask(() => {
        child.stdout.write(options.version ?? 'tunnel-client v0.0.14\n');
        child.emit('exit', 0, null);
      });
      return child;
    }
    const urlFileIndex = args.indexOf('--health.url-file');
    const healthFile = urlFileIndex >= 0 ? args[urlFileIndex + 1] : undefined;
    if (options.ready !== false && healthFile) {
      void fs.writeFile(healthFile, 'http://127.0.0.1:47891/\n', 'utf8');
    }
    return child;
  }) as McpTunnelSpawn;

  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    assert.equal(url, 'http://127.0.0.1:47891/readyz');
    return new Response('{}', { status: options.ready === false ? 503 : 200 });
  }) as typeof fetch;

  return {
    records,
    rootPromise,
    create: async (env: NodeJS.ProcessEnv = {}) => new McpTunnelRuntime(spawnProcess, env, await rootPromise, fetchImpl),
    cleanup: async () => fs.rm(await rootPromise, { recursive: true, force: true }),
  };
}

test('Secure MCP Tunnel version gate rejects pre-sessionless clients and accepts v0.0.14+', () => {
  assert.equal(isSupportedTunnelClientVersion('tunnel-client v0.0.11'), false);
  assert.equal(isSupportedTunnelClientVersion('tunnel-client v0.0.13'), false);
  assert.equal(isSupportedTunnelClientVersion('tunnel-client v0.0.14'), true);
  assert.equal(isSupportedTunnelClientVersion('tunnel-client 0.1.0'), true);
  assert.equal(isSupportedTunnelClientVersion('unknown'), false);
});

test('Secure MCP Tunnel doctor reports a supported client version without retaining secrets', async () => {
  const f = fixture({ version: 'tunnel-client v0.0.14' });
  try {
    const runtime = await f.create();
    assert.deepEqual(await runtime.doctor('custom-tunnel-client'), {
      executable: 'custom-tunnel-client',
      version: '0.0.14',
      supported: true,
    });
    assert.equal(f.records.length, 1);
    assert.deepEqual(f.records[0].args, ['--version']);
    assert.equal(JSON.stringify(runtime.status()).includes('doctor-placeholder'), false);
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel doctor fails closed for incompatible clients', async () => {
  const f = fixture({ version: 'tunnel-client v0.0.11' });
  try {
    const runtime = await f.create();
    await assert.rejects(() => runtime.doctor(), /requer v0\.0\.14 ou posterior/);
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel rejects non-loopback MCP endpoints and malformed tunnel ids before run spawn', async () => {
  const f = fixture();
  try {
    const runtime = await f.create({ CONTROL_PLANE_API_KEY: 'sk-control-test' });
    await assert.rejects(() => runtime.start({
      tunnelId: 'bad',
      localEndpoint: 'http://127.0.0.1:3000/mcp',
      localBearerToken: 'local-bearer-value-1234567890',
    }), /Tunnel ID inválido/);
    await assert.rejects(() => runtime.start({
      tunnelId: 'tunnel_' + 'a'.repeat(32),
      localEndpoint: 'https://example.com/mcp',
      localBearerToken: 'local-bearer-value-1234567890',
    }), /localhost/);
    assert.equal(f.records.filter((record) => record.args[0] === 'run').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel fails closed when the control-plane key is absent', async () => {
  const f = fixture();
  try {
    const runtime = await f.create({});
    await assert.rejects(() => runtime.start({
      tunnelId: 'tunnel_' + 'b'.repeat(32),
      localEndpoint: 'http://127.0.0.1:3000/mcp',
      localBearerToken: 'local-bearer-value-1234567890',
    }), /Chave do control plane/);
    assert.equal(f.records.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel passes secrets only through a minimal child environment and not argv', async () => {
  const f = fixture();
  try {
    const runtime = await f.create({
      PATH: 'test-path',
      CONTROL_PLANE_API_KEY: 'sk-control-secret',
      SOME_OTHER_SECRET: 'must-not-propagate',
      OPENAI_API_KEY: 'must-not-propagate-either',
    });
    const status = await runtime.start({
      tunnelId: 'tunnel_' + 'c'.repeat(32),
      localEndpoint: 'http://127.0.0.1:3000/mcp',
      localBearerToken: 'local-bearer-secret-1234567890',
    });
    assert.equal(status.running, true);
    assert.equal(status.ready, true);

    const run = f.records.find((record) => record.args[0] === 'run');
    assert.ok(run);
    const argv = JSON.stringify(run.args);
    assert.equal(argv.includes('sk-control-secret'), false);
    assert.equal(argv.includes('local-bearer-secret'), false);
    assert.equal(run.env.CONTROL_PLANE_API_KEY, 'sk-control-secret');
    assert.equal(run.env.CONTROL_PLANE_TUNNEL_ID, 'tunnel_' + 'c'.repeat(32));
    assert.equal(run.env.MCP_SERVER_URL, 'http://127.0.0.1:3000/mcp');
    assert.equal(run.env.AUTO_CODEZ_MCP_AUTHORIZATION, 'Bearer local-bearer-secret-1234567890');
    assert.equal(run.env.MCP_EXTRA_HEADERS, 'Authorization: env:AUTO_CODEZ_MCP_AUTHORIZATION');
    assert.equal(run.env.MCP_DISCOVERY_EXTRA_HEADERS, 'Authorization: env:AUTO_CODEZ_MCP_AUTHORIZATION');
    assert.equal(run.env.SOME_OTHER_SECRET, undefined);
    assert.equal(run.env.OPENAI_API_KEY, undefined);

    const serializedStatus = JSON.stringify(runtime.status());
    assert.equal(serializedStatus.includes('sk-control-secret'), false);
    assert.equal(serializedStatus.includes('local-bearer-secret'), false);
    assert.equal(await runtime.stop(), true);
    assert.equal(await runtime.stop(), false);
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel accepts a session-only control-plane key override without exposing it in status', async () => {
  const f = fixture();
  try {
    const runtime = await f.create({});
    await runtime.start({
      tunnelId: 'tunnel_' + 'd'.repeat(32),
      localEndpoint: 'http://localhost:4123/mcp',
      localBearerToken: 'local-bearer-value-1234567890',
      controlPlaneApiKey: 'sk-session-only-secret',
    });
    const run = f.records.find((record) => record.args[0] === 'run');
    assert.equal(run?.env.CONTROL_PLANE_API_KEY, 'sk-session-only-secret');
    assert.equal(JSON.stringify(runtime.status()).includes('sk-session-only-secret'), false);
    await runtime.stop();
  } finally {
    await f.cleanup();
  }
});

test('Secure MCP Tunnel preserves a sanitized failure status after unexpected child exit', async () => {
  const f = fixture();
  try {
    const runtime = await f.create({ CONTROL_PLANE_API_KEY: 'sk-control-secret' });
    await runtime.start({
      tunnelId: 'tunnel_' + 'e'.repeat(32),
      localEndpoint: 'http://127.0.0.1:5555/mcp',
      localBearerToken: 'local-bearer-value-1234567890',
    });
    const run = f.records.find((record) => record.args[0] === 'run');
    assert.ok(run);
    run.child.stderr.write('token=super-secret-value fatal connection error');
    run.child.emit('exit', 17, null);
    await new Promise((resolve) => setImmediate(resolve));

    const status = runtime.status();
    assert.equal(status.running, false);
    assert.equal(status.ready, false);
    assert.match(status.error ?? '', /REDACTED/);
    assert.equal(JSON.stringify(status).includes('super-secret-value'), false);
  } finally {
    await f.cleanup();
  }
});
