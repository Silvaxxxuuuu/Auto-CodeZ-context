import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderConfig, ChatRecord, ToolName } from '../src/ai/types';
import { WebGroundingCoordinator } from '../src/web/web-grounding-coordinator';
import { WebRetrievalRuntime } from '../src/web/web-retrieval-runtime';
import type { WebSearchAdapter } from '../src/web/web-types';

const config: AIProviderConfig = { id: 'grounding-provider', displayName: 'Grounding Provider', apiKey: '', enabled: true };

function currentChat(projectId?: string): ChatRecord {
  return {
    id: 'chat-web',
    title: 'Web',
    ...(projectId ? { projectId } : {}),
    providerId: config.id,
    model: 'text-only',
    intelligence: 'normal',
    permissionLevel: 'read-only',
    messages: [{ role: 'user', content: 'Me diga a previsão de hoje e amanhã.' }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function tool(name: ToolName) {
  return { name, description: name, parameters: { type: 'object' }, requiresWriteAccess: false, requiresApproval: false };
}

function grounding(now: () => number, onSearch?: () => void): WebGroundingCoordinator {
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture-web',
    displayName: 'Fixture Web',
    async search() {
      onSearch?.();
      return [{ title: 'Meteorologia oficial', url: 'https://weather.example/forecast', snippet: 'Hoje 28°C. Amanhã 27°C.' }];
    },
  };
  return new WebGroundingCoordinator({
    runtime: new WebRetrievalRuntime({ searchAdapter }),
    now,
    fetchLimit: 0,
    cacheTtlMs: 1_000,
  });
}

test('ChatRuntime injects current Web context even when selected model has no tool capability', async () => {
  const registry = new ProviderRegistry();
  const requests: Array<{ messages: Array<{ role: string; content: string }>; toolsEnabled: boolean }> = [];
  registry.register({
    id: config.id,
    displayName: config.displayName,
    requiresApiKey: false,
    async listModels() { return [{ id: 'text-only', name: 'Text Only', providerId: config.id, capabilities: ['text'] }]; },
    async send(_config, request) {
      requests.push(request as typeof requests[number]);
      return { content: 'Hoje 28°C [1].', model: request.model, providerId: config.id };
    },
  });
  const activity = new ActivityRuntime();
  const activityMessages: string[] = [];
  activity.subscribe((event) => activityMessages.push(`${event.status}:${event.message}`));
  const runtime = new ChatRuntime(registry, undefined, undefined, activity, undefined, [], undefined, grounding(() => Date.UTC(2026, 8, 8, 12)));

  const response = await runtime.send(config, currentChat());
  assert.equal(response.content, 'Hoje 28°C [1].');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolsEnabled, false);
  const webMessage = requests[0].messages.find((message) => message.role === 'system' && message.content.startsWith('Contexto Web atual recuperado pelo Auto CodeZ'));
  assert.ok(webMessage);
  assert.match(webMessage.content, /Meteorologia oficial/);
  assert.match(webMessage.content, /Hoje 28°C/);
  assert.match(webMessage.content, /URL: https:\/\/weather\.example\/forecast/);
  assert.equal(activityMessages.some((message) => message === 'running:Verificando informações atuais na web.'), true);
  assert.equal(activityMessages.some((message) => message.startsWith('success:Grounding Web concluído:')), true);
});

test('ChatRuntime refreshes provider request fingerprint when fresh grounding expires', async () => {
  let now = 1_000;
  let searches = 0;
  let sends = 0;
  const registry = new ProviderRegistry();
  registry.register({
    id: config.id,
    displayName: config.displayName,
    requiresApiKey: false,
    async listModels() { return [{ id: 'text-only', name: 'Text Only', providerId: config.id, capabilities: ['text'] }]; },
    async send(_config, request) { sends += 1; return { content: `Resposta ${sends}`, model: request.model, providerId: config.id }; },
  });
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [], undefined, grounding(() => now, () => { searches += 1; }));
  const chat = currentChat();

  const first = await runtime.send(config, chat);
  now = 1_500;
  const cached = await runtime.send(config, chat);
  now = 3_000;
  const refreshed = await runtime.send(config, chat);

  assert.equal(first.content, 'Resposta 1');
  assert.equal(cached.content, 'Resposta 1');
  assert.equal(refreshed.content, 'Resposta 2');
  assert.equal(searches, 2);
  assert.equal(sends, 2);
});

test('normal chats expose web tools while still excluding project Git tools', async () => {
  const registry = new ProviderRegistry();
  let requestTools: string[] = [];
  registry.register({
    id: config.id,
    displayName: config.displayName,
    requiresApiKey: false,
    async listModels() { return [{ id: 'text-only', name: 'Tool Model', providerId: config.id, capabilities: ['text', 'tools'] }]; },
    async send(_config, request) {
      requestTools = request.tools?.map((definition) => definition.name) ?? [];
      return { content: 'ok', model: request.model, providerId: config.id };
    },
  });
  const noGrounding = new WebGroundingCoordinator({
    runtime: new WebRetrievalRuntime({ searchAdapter: { id: 'unused', displayName: 'Unused', async search() { return []; } } }),
  });
  const chat = currentChat();
  chat.messages = [{ role: 'user', content: 'Explique este conceito sem dados atuais.' }];
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [tool('web_search'), tool('web_fetch'), tool('git_status')], undefined, noGrounding);
  await runtime.send(config, chat);
  assert.deepEqual(requestTools, ['web_search', 'web_fetch']);
});
