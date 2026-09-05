import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderAdapter, AIProviderConfig, AIResponse, AIStreamEvent, ChatRecord, ToolName } from '../src/ai/types';

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

function tool(name: ToolName, requiresWriteAccess: boolean, requiresApproval: boolean) {
  return { name, description: name, parameters: { type: 'object' }, requiresWriteAccess, requiresApproval };
}

test('send includes workspace context and tool definitions only when tools are supported', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    tool('read_file', false, false),
  ]);

  await runtime.send(config, chat(), 'src/index.ts contains the current implementation.');
  const request = requests[0] as { messages: { role: string; content: string }[]; tools?: unknown[]; toolsEnabled: boolean; projectContext?: string };
  assert.equal(request.toolsEnabled, true);
  assert.equal(request.tools?.length, 1);
  assert.equal(request.projectContext, 'src/index.ts contains the current implementation.');
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /Contexto do workspace atual/);
  assert.equal(request.messages[1].role, 'system');
  assert.match(request.messages[1].content, /src\/index\.ts contains the current implementation/);
  assert.equal(request.messages[2].content, 'Hello');
});

test('send exposes protected file tools and run_command to a normal chat but excludes Git', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    tool('read_file', false, false),
    tool('write_file', true, true),
    tool('create_file', true, true),
    tool('replace_range', true, true),
    tool('insert_before', true, true),
    tool('insert_after', true, true),
    tool('delete_file', true, true),
    tool('rename_file', true, true),
    tool('search_files', false, false),
    tool('run_command', false, true),
    tool('git_status', false, false),
  ]);

  await runtime.send(config, chat('test-model', ''));
  const request = requests[0] as { toolsEnabled: boolean; tools?: Array<{ name: string }>; messages: Array<{ content: string }> };
  assert.equal(request.toolsEnabled, true);
  assert.deepEqual(request.tools?.map((item) => item.name), ['read_file', 'write_file', 'create_file', 'replace_range', 'insert_before', 'insert_after', 'delete_file', 'rename_file', 'search_files', 'run_command']);
  assert.equal(request.tools?.some((item) => item.name === 'git_status'), false);
  assert.match(request.messages[0].content, /Runtime OS:/);
  assert.match(request.messages[0].content, /protected system workspace rooted at the user's Home directory/i);
  assert.match(request.messages[0].content, /Desktop\/Novo site\/index\.html/i);
  assert.match(request.messages[0].content, /localized edits, prefer replace_range, insert_before or insert_after/i);
  assert.match(request.messages[0].content, /Use write_file when most or all of a file genuinely needs replacement/i);
});

test('send keeps available protected file tools in a normal chat even when run_command is unavailable', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    tool('read_file', false, false),
    tool('create_file', true, true),
    tool('replace_range', true, true),
  ]);

  await runtime.send(config, chat('test-model', ''));
  const request = requests[0] as { toolsEnabled: boolean; tools?: Array<{ name: string }> };
  assert.equal(request.toolsEnabled, true);
  assert.deepEqual(request.tools?.map((item) => item.name), ['read_file', 'create_file', 'replace_range']);
});

test('send disables tools for models without tool capability', async () => {
  const registry = new ProviderRegistry();
  const { requests } = registerAdapter(registry, ['text']);
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [
    tool('read_file', false, false),
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
