import assert from 'node:assert/strict';
import test from 'node:test';
import { LMStudioLocalRuntimeAdapter } from '../src/ai/local-runtimes/lm-studio';
import { OllamaLocalRuntimeAdapter } from '../src/ai/local-runtimes/ollama';

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

function neverRespondUntilAbort(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error(`Availability probe for ${String(input)} did not receive an AbortSignal.`));
      return;
    }
    const rejectAbort = (): void => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

test('local runtime availability probes fail closed on their bounded health timeout', async () => {
  const requests: string[] = [];
  await withMockedFetch((input, init) => {
    requests.push(String(input));
    return neverRespondUntilAbort(input, init);
  }, async () => {
    const ollama = new OllamaLocalRuntimeAdapter(undefined, 15);
    const lmStudio = new LMStudioLocalRuntimeAdapter({ availabilityTimeoutMs: 15 });
    const startedAt = Date.now();
    const [ollamaInfo, lmStudioInfo] = await Promise.all([
      ollama.getInfo(),
      lmStudio.getInfo(),
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(ollamaInfo.available, false);
    assert.equal(lmStudioInfo.available, false);
    assert.ok(elapsedMs < 1_000, `Availability probes took ${elapsedMs} ms.`);
  });

  assert.deepEqual(new Set(requests), new Set([
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:1234/api/v1/models',
  ]));
});
