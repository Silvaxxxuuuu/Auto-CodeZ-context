import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRuntime } from '../src/agent/activity-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIAttachment, AIProviderConfig, ChatRecord } from '../src/ai/types';
import type { AttachmentIndexer } from '../src/ai/attachment-indexer';

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
  assert.match(systemPrompt, /short, dynamically generated live activity summary/i);
  assert.match(systemPrompt, /exact action you are taking now and the current context/i);
  const dynamic = events.find((event) => event.type === 'thought' && event.toolCallId === 'read-config-1');
  assert.ok(dynamic);
  assert.equal(dynamic.type, 'thought');
  assert.equal(dynamic.message, 'Vou conferir a configuração atual antes de alterar esse arquivo.');
  assert.equal(dynamic.status, 'running');
  assert.equal(dynamic.toolCallId, 'read-config-1');
  assert.equal(dynamic.toolName, 'read_file');
});


test('ChatRuntime exposes one human image-analysis activity and hides local vision implementation steps', async () => {
  const registry = new ProviderRegistry();
  registry.register({
    id: config.id,
    displayName: config.displayName,
    async listModels() {
      return [{ id: 'activity-model', name: 'Activity Model', providerId: config.id, capabilities: ['text'] }];
    },
    async send() {
      return {
        content: 'A imagem mostra uma interface com informações técnicas.',
        model: 'activity-model',
        providerId: config.id,
      };
    },
  });

  const source: AIAttachment = {
    id: 'image-1',
    kind: 'image',
    name: 'captura.png',
    mediaType: 'image/png',
    size: 1234,
    storageKey: 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    createdAt: 1,
  };

  let progressCallbackWasExposed = false;
  const attachmentIndexer: AttachmentIndexer = {
    async index(attachment, _signal, onProgress) {
      progressCallbackWasExposed = typeof onProgress === 'function';
      onProgress?.({ message: 'Preparando visão local para captura.png.' });
      onProgress?.({ message: 'Lendo texto de captura.png com OCR do Windows.' });
      return {
        ...attachment,
        contexts: [{
          kind: 'caption',
          text: 'Uma interface técnica com texto legível.',
          model: 'fixture-vision',
          createdAt: 2,
        }],
      };
    },
    async stop() {
      return;
    },
  };

  const imageChat: ChatRecord = {
    ...chat(),
    messages: [{
      role: 'user',
      content: 'Sobre o que é essa imagem?',
      attachments: [source],
    }],
  };

  const activity = new ActivityRuntime();
  const messages: string[] = [];
  activity.subscribe((event) => messages.push(event.message));

  const runtime = new ChatRuntime(
    registry,
    undefined,
    undefined,
    activity,
    undefined,
    [],
    undefined,
    undefined,
    attachmentIndexer,
  );

  await runtime.send(config, imageChat);

  assert.equal(progressCallbackWasExposed, false);
  assert.deepEqual(
    messages.filter((message) => /imagem|visão|OCR|index/i.test(message)),
    ['Analisando imagem anexada…'],
  );
  assert.equal(messages.some((message) => /Preparando visão local|OCR do Windows|llama\.cpp|indexando/i.test(message)), false);
});
