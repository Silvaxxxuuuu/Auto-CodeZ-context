import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateQuantizedModelRam,
  evaluateLocalModelCompatibility,
} from '../src/ai/local-model-runtime';
import { OllamaLocalRuntimeAdapter } from '../src/ai/local-runtimes/ollama';

const GIB = 1024 ** 3;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function ndjsonResponse(values: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of values) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

async function withMockedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try { await action(); } finally { globalThis.fetch = originalFetch; }
}

test('compatibility blocks models that exceed safe RAM headroom', () => {
  const result = evaluateLocalModelCompatibility({
    totalRamBytes: 16 * GIB,
    availableRamBytes: 12 * GIB,
    freeDiskBytes: 100 * GIB,
  }, {
    downloadBytes: 18 * GIB,
    estimatedRamBytes: 15 * GIB,
  });
  assert.equal(result.level, 'blocked');
  assert.match(result.reasons[0] ?? '', /RAM total/);
});

test('compatibility marks a model excellent when memory and disk have headroom', () => {
  const estimatedRamBytes = estimateQuantizedModelRam(5 * GIB);
  assert.ok(estimatedRamBytes);
  const result = evaluateLocalModelCompatibility({
    totalRamBytes: 32 * GIB,
    availableRamBytes: 24 * GIB,
    freeDiskBytes: 100 * GIB,
    totalVramBytes: 12 * GIB,
  }, {
    downloadBytes: 5 * GIB,
    estimatedRamBytes,
    estimatedVramBytes: 4 * GIB,
  });
  assert.equal(result.level, 'excellent');
});

test('Ollama local runtime reads installed model metadata', async () => {
  const adapter = new OllamaLocalRuntimeAdapter();
  await withMockedFetch(async (input) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/tags');
    return jsonResponse({ models: [{ model: 'qwen3:8b', size: 5 * GIB, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] });
  }, async () => {
    const models = await adapter.listInstalled();
    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      runtimeId: 'ollama',
      installed: true,
      sizeBytes: 5 * GIB,
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
      family: 'qwen3',
    });
  });
});

test('Ollama pull exposes real byte progress and requires terminal success', async () => {
  const adapter = new OllamaLocalRuntimeAdapter();
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/pull');
    assert.equal(init?.method, 'POST');
    return ndjsonResponse([
      { status: 'pulling manifest' },
      { status: 'downloading', digest: 'sha256:test', total: 1000, completed: 400 },
      { status: 'downloading', digest: 'sha256:test', total: 1000, completed: 1000 },
      { status: 'success' },
    ]);
  }, async () => {
    const events = [];
    for await (const event of adapter.install('qwen3:8b')) events.push(event);
    assert.equal(events[1]?.percent, 40);
    assert.equal(events[2]?.percent, 100);
    assert.equal(events.at(-1)?.done, true);
  });
});

test('Ollama removal uses the native delete endpoint with the exact model id', async () => {
  const adapter = new OllamaLocalRuntimeAdapter();
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/delete');
    assert.equal(init?.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'qwen3:4b' });
    return jsonResponse({});
  }, async () => {
    await adapter.remove('qwen3:4b');
  });
});
