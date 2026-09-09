import assert from 'node:assert/strict';
import test from 'node:test';
import { LMStudioLocalRuntimeAdapter } from '../src/ai/local-runtimes/lm-studio';

const GIB = 1024 ** 3;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function withMockedFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('LM Studio runtime reads only local LLM inventory and preserves capability metadata', async () => {
  const adapter = new LMStudioLocalRuntimeAdapter({ apiToken: 'local-token' });
  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:1234/api/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-token');
    return jsonResponse({
      models: [
        {
          type: 'llm',
          key: 'qwen-local',
          display_name: 'Qwen Local',
          architecture: 'qwen3',
          quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
          size_bytes: 5 * GIB,
          params_string: '8B',
          max_context_length: 131072,
          capabilities: { vision: true, trained_for_tool_use: true },
        },
        {
          type: 'embedding',
          key: 'embedding-local',
          display_name: 'Embedding Local',
          size_bytes: GIB,
          max_context_length: 8192,
        },
      ],
    });
  }, async () => {
    const info = await adapter.getInfo();
    assert.equal(info.available, true);
    assert.equal(info.endpoint, 'http://127.0.0.1:1234');

    const models = await adapter.listInstalled();
    assert.deepEqual(models, [{
      id: 'qwen-local',
      name: 'Qwen Local',
      runtimeId: 'lm-studio',
      installed: true,
      sizeBytes: 5 * GIB,
      parameterSize: '8B',
      quantization: 'Q4_K_M',
      family: 'qwen3',
      capabilities: ['vision', 'tools'],
      contextWindow: 131072,
    }]);
  });
});

test('LM Studio runtime exposes polled download progress without inventing cancellation', async () => {
  const adapter = new LMStudioLocalRuntimeAdapter({ pollIntervalMs: 0 });
  let statusReads = 0;
  await withMockedFetch(async (input, init) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:1234/api/v1/models/download') {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'ibm/granite-4-micro' });
      return jsonResponse({
        job_id: 'job_test',
        status: 'downloading',
        total_size_bytes: 1000,
        downloaded_bytes: 100,
      });
    }
    assert.equal(url, 'http://127.0.0.1:1234/api/v1/models/download/status/job_test');
    statusReads += 1;
    if (statusReads === 1) {
      return jsonResponse({
        job_id: 'job_test',
        status: 'downloading',
        total_size_bytes: 1000,
        downloaded_bytes: 500,
      });
    }
    return jsonResponse({
      job_id: 'job_test',
      status: 'completed',
      total_size_bytes: 1000,
      downloaded_bytes: 1000,
    });
  }, async () => {
    const events = [];
    for await (const event of adapter.install('ibm/granite-4-micro')) events.push(event);
    assert.deepEqual(events.map((event) => event.percent), [10, 50, 100]);
    assert.equal(events.at(-1)?.done, true);
    assert.equal(events.at(-1)?.status, 'Concluído');
  });
});

test('LM Studio already-downloaded response completes without requiring a job id', async () => {
  const adapter = new LMStudioLocalRuntimeAdapter({ pollIntervalMs: 0 });
  let requests = 0;
  await withMockedFetch(async (input) => {
    requests += 1;
    assert.equal(String(input), 'http://127.0.0.1:1234/api/v1/models/download');
    return jsonResponse({ status: 'already_downloaded' });
  }, async () => {
    const events = [];
    for await (const event of adapter.install('ibm/granite-4-micro')) events.push(event);
    assert.equal(requests, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].percent, 100);
    assert.equal(events[0].done, true);
  });
});

test('LM Studio runtime rejects malformed and failed download states', async () => {
  const adapter = new LMStudioLocalRuntimeAdapter({ pollIntervalMs: 0 });
  await withMockedFetch(async () => jsonResponse({ status: 'failed', error: 'download failed' }), async () => {
    await assert.rejects(async () => {
      for await (const _event of adapter.install('model')) {
        // Drain until the runtime reports the failure.
      }
    }, /download failed/);
  });

  await withMockedFetch(async () => jsonResponse({ status: 'downloading' }), async () => {
    await assert.rejects(async () => {
      for await (const _event of adapter.install('model')) {
        // Drain until validation observes the missing job id.
      }
    }, /job_id/);
  });
});
