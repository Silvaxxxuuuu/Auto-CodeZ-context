import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTO_CODEZ_LOCAL_ENGINE_ASSET,
  AUTO_CODEZ_LOCAL_ENGINE_RELEASE,
} from '../src/ai/auto-codez-local-engine';
import type { LocalModelInstallProgress } from '../src/ai/local-model-runtime';
import { AutoCodezLocalRuntimeAdapter } from '../src/ai/local-runtimes/auto-codez-local';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-managed-runtime-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function seedEngine(root: string): Promise<void> {
  const engineDir = path.join(root, 'engine', AUTO_CODEZ_LOCAL_ENGINE_RELEASE);
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, 'llama-server.exe'), 'test-engine');
  await fs.writeFile(path.join(engineDir, 'engine.json'), `${JSON.stringify({
    release: AUTO_CODEZ_LOCAL_ENGINE_RELEASE,
    asset: AUTO_CODEZ_LOCAL_ENGINE_ASSET.fileName,
    sha256: AUTO_CODEZ_LOCAL_ENGINE_ASSET.sha256,
  })}\n`, 'utf8');
}

function fakeFetch(bytes: Uint8Array): typeof fetch {
  const body = new TextDecoder().decode(bytes);
  return async () => new Response(body, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

test('Auto CodeZ Local installs verified GGUF metadata and removes it idempotently', async () => {
  await withTempDir(async (root) => {
    await seedEngine(root);
    const modelBytes = new TextEncoder().encode('tiny-gguf-fixture');
    const sha256 = crypto.createHash('sha256').update(modelBytes).digest('hex');
    const runtime = new AutoCodezLocalRuntimeAdapter(root, {
      platform: 'win32',
      arch: 'x64',
      modelFetcher: fakeFetch(modelBytes),
    });

    const info = await runtime.getInfo();
    assert.equal(info.available, true);
    assert.equal(info.id, 'auto-codez-local');

    const progress: LocalModelInstallProgress[] = [];
    for await (const event of runtime.install({
      modelId: 'qwen-test',
      source: 'https://example.test/qwen-test.gguf',
      fileName: 'qwen-test.gguf',
      sha256,
      expectedBytes: modelBytes.byteLength,
      name: 'Qwen Test',
      parameterSize: '0.1B',
      quantization: 'Q4_0',
      family: 'qwen',
      capabilities: ['tools', 'reasoning'],
      contextWindow: 8192,
    })) progress.push(event);

    assert.equal(progress.at(-1)?.done, true);
    assert.equal(progress.at(-1)?.digest, sha256);
    const installed = await runtime.listInstalled();
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0], {
      id: 'qwen-test',
      name: 'Qwen Test',
      runtimeId: 'auto-codez-local',
      installed: true,
      sizeBytes: modelBytes.byteLength,
      parameterSize: '0.1B',
      quantization: 'Q4_0',
      family: 'qwen',
      capabilities: ['tools', 'reasoning'],
      contextWindow: 8192,
    });
    assert.ok(await runtime.modelPath('qwen-test'));

    await runtime.remove('qwen-test');
    await runtime.remove('qwen-test');
    assert.deepEqual(await runtime.listInstalled(), []);
  });
});

test('Auto CodeZ Local reports unsupported platforms instead of pretending to be usable', async () => {
  await withTempDir(async (root) => {
    const runtime = new AutoCodezLocalRuntimeAdapter(root, { platform: 'linux', arch: 'x64' });
    const info = await runtime.getInfo();
    assert.equal(info.available, false);
    await assert.rejects(async () => {
      for await (const _event of runtime.install({
        modelId: 'x',
        source: 'https://example.test/x.gguf',
        fileName: 'x.gguf',
        sha256: '0'.repeat(64),
        expectedBytes: 1,
      })) void _event;
    }, /somente Windows x64/);
  });
});
