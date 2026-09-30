import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIMessage, AIProviderConfig, AIRequest, AIToolCall, ProjectRecord } from '../src/ai/types';
import { AttachmentStore } from '../src/ai/attachment-store';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { InstanceCaptureArtifactRuntime } from '../src/agent/instance-capture-artifact-runtime';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/gAAAAABJRU5ErkJggg==', 'base64');
const config: AIProviderConfig = { id: 'capture-test', displayName: 'Capture test', apiKey: 'local-test', enabled: true };

async function fixture() {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-capture-tool-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-capture-tool-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  let captures = 0;
  const instances = new InstanceRuntime({
    open: async ({ kind }): Promise<InstancePlatformHandle> => {
      if (kind !== 'preview') return { canFocus: false, canClose: false };
      let open = true;
      return {
        canFocus: true,
        canClose: true,
        focus: () => undefined,
        close: () => { open = false; },
        isOpen: () => open,
        capture: async () => { captures += 1; return PNG; },
      };
    },
  });
  const store = new AttachmentStore(() => path.join(rootA, 'capture-artifacts'));
  const tools = new ToolRuntime(new WorkspaceRuntime(async () => projects));
  tools.configureInstanceRuntime(instances);
  tools.configureInstanceCaptureRuntime(new InstanceCaptureArtifactRuntime(instances, store));
  return {
    instances, tools, store, captures: () => captures,
    cleanup: async () => {
      await instances.closeAll().catch((): void => {});
      const opts = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 };
      await fs.rm(rootA, opts);
      await fs.rm(rootB, opts);
    },
  };
}

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

test('capture_instance returns only a verified artifact reference and cannot cross projects', async () => {
  const f = await fixture();
  try {
    const opened = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('open', 'open_instance', {
      kind: 'preview', target: 'http://localhost:5173',
    }), 'run-a');
    assert.equal(opened.ok, true, opened.error);
    const instanceId = (JSON.parse(opened.output ?? '{}') as { instanceId: string }).instanceId;
    const foreign = await f.tools.execute('chat-b', 'project-b', 'read-only', call('foreign', 'capture_instance', { instanceId }), 'run-b');
    assert.equal(foreign.ok, false);
    assert.match(foreign.error ?? '', /outro projeto/i);
    assert.equal(f.captures(), 0);

    const captured = await f.tools.execute('chat-a', 'project-a', 'read-only', call('capture', 'capture_instance', { instanceId }), 'run-a');
    assert.equal(captured.ok, true, captured.error);
    assert.equal(captured.pendingApproval, undefined);
    assert.equal(f.captures(), 1);
    assert.equal(captured.attachments?.length, 1);
    assert.deepEqual(await f.store.readBytes(captured.attachments![0]), PNG);
    assert.equal(captured.attachments![0].dataBase64, undefined);
    const metadata = JSON.parse(captured.output ?? '{}');
    assert.equal(metadata.visualAnalysis, 'requires_model_vision_delivery');
    assert.equal(metadata.artifact.storageKey, captured.attachments![0].storageKey);
    assert.equal(captured.output?.includes(PNG.toString('base64')), false);
    assert.equal(f.tools.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);

    const closed = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('close', 'close_instance', { instanceId }), 'run-a');
    assert.equal(closed.ok, true);
    const afterClose = await f.tools.execute('chat-a', 'project-a', 'read-only', call('closed', 'capture_instance', { instanceId }), 'run-a');
    assert.equal(afterClose.ok, false);
    assert.equal(f.captures(), 1);
  } finally {
    await f.cleanup();
  }
});

test('latest capture is hydrated only for a vision provider and only in ephemeral provider messages', async () => {
  const f = await fixture();
  try {
    const instance = await f.instances.open({ projectId: 'project-a', kind: 'preview', target: 'http://localhost:5173' });
    const capture = await f.tools.execute('chat-a', 'project-a', 'read-only', call('capture', 'capture_instance', { instanceId: instance.instanceId }), 'run-a');
    assert.equal(capture.ok, true, capture.error);
    assert.equal(capture.attachments?.[0].dataBase64, undefined);
    const history: AIMessage[] = [
      { role: 'user', content: 'Capture a preview and inspect it.' },
      { role: 'assistant', content: '', toolCalls: [call('capture', 'capture_instance', { instanceId: instance.instanceId })] },
      { role: 'tool', content: capture.output!, toolName: 'capture_instance', toolCallId: 'capture', attachments: capture.attachments },
    ];
    for (const vision of [true, false]) {
      const registry = new ProviderRegistry();
      let observed: AIRequest | undefined;
      registry.register({
        id: config.id,
        displayName: 'Test',
        async listModels() {
          return [{ id: 'capture-model', name: 'Capture', providerId: config.id, capabilities: vision ? ['text', 'vision', 'tools'] : ['text', 'tools'] }];
        },
        async send(_config, request) {
          observed = request;
          return { content: 'Model response', model: 'capture-model', providerId: config.id };
        },
      });
      const runtime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, f.store);
      await runtime.send(config, {
        id: 'chat-a', title: 'Capture', projectId: 'project-a', providerId: config.id,
        model: 'capture-model', intelligence: 'normal', permissionLevel: 'read-only',
        messages: history, createdAt: 1, updatedAt: 1,
      });
      assert.ok(observed);
      assert.equal(observed.messages.at(-1)?.role, vision ? 'user' : 'tool');
      if (vision) {
        const ephemeral = observed.messages.at(-1)!;
        assert.match(ephemeral.content, /gerada automaticamente/);
        assert.equal(ephemeral.attachments?.[0].dataBase64, PNG.toString('base64'));
      } else {
        assert.equal(observed.messages.some((item) => item.attachments?.some((att) => Boolean(att.dataBase64))), false);
      }
      assert.equal(history[2].attachments?.[0].dataBase64, undefined);
    }
  } finally {
    await f.cleanup();
  }
});
