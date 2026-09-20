import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureOpenAIAdapter } from '../src/ai/providers/azure-openai';
import type { AIProviderConfig, AIRequest } from '../src/ai/types';

function config(baseUrl: string): AIProviderConfig {
  return {
    id: 'azure-openai',
    displayName: 'Azure OpenAI',
    apiKey: 'azure-test-key',
    baseUrl,
    enabled: true,
  };
}

function request(): AIRequest {
  return {
    providerId: 'azure-openai',
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Olá' }],
    intelligence: 'high',
    toolsEnabled: true,
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      requiresWriteAccess: false,
      requiresApproval: false,
    }],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

test('Azure OpenAI discovers models using the v1 endpoint and api-key header', async () => {
  const adapter = new AzureOpenAIAdapter();

  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://example.openai.azure.com/openai/v1/models');
    assert.equal((init?.headers as Record<string, string>)['api-key'], 'azure-test-key');
    return jsonResponse({
      object: 'list',
      data: [
        { id: 'gpt-5.6-luna' },
        { id: 'gpt-4o' },
      ],
    });
  }, async () => {
    const models = await adapter.listModels(config('https://example.openai.azure.com'));
    assert.deepEqual(models.map((model) => model.id), ['gpt-5.6-luna', 'gpt-4o']);
    assert.equal(models[0]?.providerId, 'azure-openai');
    assert.ok(models[0]?.capabilities.includes('reasoning'));
    assert.ok(models[0]?.capabilities.includes('tools'));
  });
});

test('Azure OpenAI preserves a fully qualified openai v1 base URL', async () => {
  const adapter = new AzureOpenAIAdapter();

  await withMockedFetch(async (input) => {
    assert.equal(String(input), 'https://example.services.ai.azure.com/openai/v1/models');
    return jsonResponse({ data: [] });
  }, async () => {
    await adapter.listModels(config('https://example.services.ai.azure.com/openai/v1/'));
  });
});

test('Azure OpenAI sends Responses API requests with reasoning and tools', async () => {
  const adapter = new AzureOpenAIAdapter();

  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://example.openai.azure.com/openai/v1/responses');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['api-key'], 'azure-test-key');
    assert.equal(headers['Content-Type'], 'application/json');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-5.6-luna');
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.ok(Array.isArray(body.tools));
    assert.deepEqual(body.input, [{
      role: 'user',
      content: [{ type: 'input_text', text: 'Olá' }],
    }]);

    return jsonResponse({
      output_text: 'Pronto',
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });
  }, async () => {
    const response = await adapter.send(config('https://example.openai.azure.com'), request());
    assert.equal(response.providerId, 'azure-openai');
    assert.equal(response.content, 'Pronto');
    assert.deepEqual(response.usage, {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    assert.deepEqual(response.toolCalls, [{
      id: 'call_1',
      name: 'read_file',
      input: { path: 'README.md' },
    }]);
  });
});

test('Azure OpenAI refuses missing resource endpoint before making a request', async () => {
  const adapter = new AzureOpenAIAdapter();
  await assert.rejects(
    () => adapter.listModels(config('')),
    /exige a URL base do recurso/i,
  );
});


test('Azure Foundry sends Kimi deployments through chat completions with api-key auth', async () => {
  const adapter = new AzureOpenAIAdapter();
  const kimiRequest: AIRequest = {
    ...request(),
    model: 'Kimi-K2.6',
    intelligence: 'normal',
  };

  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://example.services.ai.azure.com/openai/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['api-key'], 'azure-test-key');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'Kimi-K2.6');
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.tools));
    assert.equal('input' in body, false);
    assert.equal('reasoning' in body, false);

    return jsonResponse({
      choices: [{
        message: {
          content: 'Kimi pronto',
          tool_calls: [{
            id: 'call_kimi_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"src/main.ts"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
      },
    });
  }, async () => {
    const response = await adapter.send(
      config('https://example.services.ai.azure.com/openai/v1'),
      kimiRequest,
    );
    assert.equal(response.providerId, 'azure-openai');
    assert.equal(response.content, 'Kimi pronto');
    assert.deepEqual(response.usage, {
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
    });
    assert.deepEqual(response.toolCalls, [{
      id: 'call_kimi_1',
      name: 'read_file',
      input: { path: 'src/main.ts' },
    }]);
  });
});

test('Azure Foundry streams Kimi chat completions and tool calls', async () => {
  const adapter = new AzureOpenAIAdapter();
  const kimiRequest: AIRequest = {
    ...request(),
    model: 'Kimi-K2.6',
    intelligence: 'normal',
  };

  const sse = [
    'data: {"choices":[{"delta":{"content":"Olá "},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"do Kimi"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  await withMockedFetch(async (input, init) => {
    assert.equal(String(input), 'https://example.services.ai.azure.com/openai/v1/chat/completions');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.stream, true);
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }, async () => {
    const events = [];
    for await (const event of adapter.stream!(
      config('https://example.services.ai.azure.com/openai/v1'),
      kimiRequest,
    )) {
      events.push(event);
    }

    assert.deepEqual(
      events.filter((event) => event.type === 'delta').map((event) => event.text),
      ['Olá ', 'do Kimi'],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_call').map((event) => event.toolCall),
      [{
        id: 'call_stream_1',
        name: 'read_file',
        input: { path: 'README.md' },
      }],
    );
    const complete = events.find((event) => event.type === 'complete');
    assert.equal(complete?.response?.content, 'Olá do Kimi');
    assert.deepEqual(complete?.usage, {
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
    });
  });
});
