import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSSE } from '../src/ai/sse';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

test('parseSSE handles fragmented JSON events across chunks', async () => {
  const response = sseResponse([
    'data: {"type":"delta","text":"Hel',
    'lo"}\n\n',
    'data: {"type":"complete"}\n\n',
  ]);
  const events: unknown[] = [];
  for await (const event of parseSSE(response, 1_000)) events.push(event);
  assert.deepEqual(events, [
    { type: 'delta', text: 'Hello' },
    { type: 'complete' },
  ]);
});

test('parseSSE ignores malformed and empty data frames without stopping the stream', async () => {
  const response = sseResponse([
    'data: not-json\n\n',
    'data:\n\n',
    'event: ignored\n\n',
    'data: {"type":"delta","text":"ok"}\n\n',
    'data: [DONE]\n\n',
  ]);
  const events: unknown[] = [];
  for await (const event of parseSSE(response, 1_000)) events.push(event);
  assert.deepEqual(events, [{ type: 'delta', text: 'ok' }]);
});

test('parseSSE parses a final unterminated data frame', async () => {
  const response = sseResponse(['data: {"type":"complete","value":true}']);
  const events: unknown[] = [];
  for await (const event of parseSSE(response, 1_000)) events.push(event);
  assert.deepEqual(events, [{ type: 'complete', value: true }]);
});

test('parseSSE rejects responses without a readable body', async () => {
  const response = new Response(null);
  await assert.rejects(async () => {
    for await (const _event of parseSSE(response, 1_000)) {
      // The generator must fail before yielding an event.
    }
  }, /não retornou um stream de dados/);
});
