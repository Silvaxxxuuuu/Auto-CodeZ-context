import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderConfig, ChatRecord } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'activity-provider',
  displayName: 'Activity Provider',
  apiKey: 'fixture',
  enabled: true,
};

function chat(): ChatRecord {
  return {
    id: 'activity-chat',
    title: 'Activity',
    projectId: 'project-1',
    providerId: config.id,
    model: 'activity-model',
    intelligence: 'normal',
    permissionLevel: 'safe',
    messages: [{ role: 'user', content: 'Atualize a configuração depois de verificar o arquivo.' }],
    createdAt: 1,
    updatedAt: 1,
  };
}

test('ChatRuntime turns provider pre-tool text into contextual live activity tied to the real tool call', async () => {
  const registry = new ProviderRegistry();
  let systemPrompt = '';
  registry.register({
    id: config.id,
    displayName: config.displayName,
    async listModels() {
      return [{ id: 'activity-model', name: 'Activity Model', providerId: config.id, capabilities: ['text', 'tools'] }];
    },
    async send(_providerConfig, request) {
      systemPrompt = request.messages[0]?.content || '';
      return {
        content: 'Vou conferir a configuração atual antes de alterar esse arquivo.',
        model: 'activity-model',
        providerId: config.id,
        toolCalls: [{ id: 'read-config-1', name: 'read_file', input: { path: 'src/config.ts' } }],
      };
    },
  });

  const activity = new ActivityRuntime();
  const events: Array<{ type: string; message: string; status: string; toolCallId?: string; toolName?: string }> = [];
  activity.subscribe((event) => events.push(event));
  const runtime = new ChatRuntime(registry, undefined, undefined, activity, undefined, [{
    name: 'read_file',
    description: 'Read file',
    parameters: { type: 'object' },
    requiresWriteAccess: false,
    requiresApproval: false,
  }]);

  await runtime.send(config, chat(), 'src/config.ts');
  assert.match(systemPrompt, /short, live activity summary/i);
  assert.match(systemPrompt, /specific action and target/i);
  const dynamic = events.find((event) => event.type === 'thought' && event.toolCallId === 'read-config-1');
  assert.deepEqual(dynamic, {
    type: 'thought',
    message: 'Vou conferir a configuração atual antes de alterar esse arquivo.',
    status: 'running',
    toolCallId: 'read-config-1',
    toolName: 'read_file',
  });
});
