import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderAdapter, AIProviderConfig, AIResponse, AIStreamEvent, ChatRecord } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'test-provider',
  displayName: 'Test Provider',
  apiKey: 'test-key',
  enabled: true,
};

function chat(model = 'test-model', projectId = 'project-test'): ChatRecord {
  return {
    id: 'chat-test',
    title: 'Chat Test',
    projectId: projectId || undefined,
    providerId: config.id,
    model,
    intelligence: 'normal',
    permissionLevel: 'ask',
    messages: [{ role: 'user', content: 'Hello' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function registerAdapter(registry: ProviderRegistry, capabilities: ('text' | 'tools' | 'streaming')[] = ['text', 'tools', 'streaming'], stream?: AIProviderAdapter['stream']): { requests: unknown[]; responses: AIResponse[] } {
  const requests: unknown[] = [];
  const responses: AIResponse[] = [{ content: 'Done.', model: 'test-model', providerId: config.id }];
  registry.register({
    id: config.id,
    displayName: config.displayName,
    async listModels() {
      return [{ id: 'test-model', name: 'Test Model', providerId: config.id, capabilities }];
    },
    async send(_config, request) {
      requests.push(request);
      return responses[0];
    },
    stream,
  });
  return { requests, responses };
}

test('send includes workspace context and tool definitions only when tools are supported', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object' },
      requiresWriteAccess: false,
      requiresApproval: false,
    },
  ]);

  await runtime.send(config, chat(), 'src/index.ts contains the current implementation.');
  const request = requests[0] as { messages: { role: string; content: string }[]; tools?: unknown[]; toolsEnabled: boolean; projectContext?: string };
  assert.equal(request.toolsEnabled, true);
  assert.equal(request.tools?.length, 1);
  assert.equal(request.projectContext, 'src/index.ts contains the current implementation.');
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Contexto do workspace atual/);
  assert.equal(request.messages[1].content, 'Hello');
});

test('send does not expose workspace tools to a normal chat', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object' },
      requiresWriteAccess: false,
      requiresApproval: false,
    },
  ]);

  await runtime.send(config, chat('test-model', ''));
  const request = requests[0] as { toolsEnabled: boolean; tools?: unknown[] };
  assert.equal(request.toolsEnabled, false);
  assert.equal(request.tools, undefined);
});

test('send disables tools for models without tool capability', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry, ['text']);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object' },
      requiresWriteAccess: false,
      requiresApproval: false,
    },
  ]);

  await runtime.send(config, chat());
  const request = requests[0] as { toolsEnabled: boolean; tools?: unknown[] };
  assert.equal(request.toolsEnabled, false);
  assert.equal(request.tools, undefined);
});

test('stream falls back to send when the adapter does not expose streaming', async () => {
  const registry = new ProviderRegistry();
  registerAdapter(registry, ['text']);
  const runtime = new ChatRuntime(registry);
  const events: AIStreamEvent[] = [];

  for await (const event of runtime.stream(config, chat())) events.push(event);

  assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'complete']);
  assert.equal(events[1].text, 'Done.');
  assert.equal(events[2].response?.content, 'Done.');
});

test('stream preserves provider stream events and final response', async () => {
  const registry = new ProviderRegistry();
  const providerEvents: AIStreamEvent[] = [
    { type: 'start' },
    { type: 'delta', text: 'Hello' },
    { type: 'complete', response: { content: 'Hello', model: 'test-model', providerId: config.id } },
  ];
  registerAdapter(registry, ['text', 'streaming'], async function* () {
    for (const event of providerEvents) yield event;
  });
  const runtime = new ChatRuntime(registry);
  const events: AIStreamEvent[] = [];

  for await (const event of runtime.stream(config, chat())) events.push(event);

  assert.deepEqual(events, providerEvents);
});
