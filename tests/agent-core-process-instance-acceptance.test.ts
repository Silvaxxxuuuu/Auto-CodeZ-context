import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';
import { ProcessRuntime } from '../src/agent/process-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderAdapter, AIProviderConfig, AIRequest, AIResponse, ChatRecord, ProjectRecord } from '../src/ai/types';

const providerConfig: AIProviderConfig = {
  id: 'acceptance-provider',
  displayName: 'Acceptance Provider',
  apiKey: 'test-key',
  enabled: true,
};

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function parsedToolPayload(request: AIRequest, toolName: string): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((item) => item.role === 'tool' && item.toolName === toolName);
  if (!message?.content) return undefined;
  try {
    const value = JSON.parse(message.content) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function acceptanceAdapter(port: number): AIProviderAdapter {
  return {
    id: providerConfig.id,
    displayName: providerConfig.displayName,
    async listModels() {
      return [{ id: 'acceptance-model', name: 'Acceptance Model', providerId: providerConfig.id, capabilities: ['text', 'tools'] }];
    },
    async send(_config, request): Promise<AIResponse> {
      const stopped = parsedToolPayload(request, 'stop_process');
      if (stopped) {
        return {
          content: 'Preview lifecycle completed with process stopped and instance closed.',
          model: request.model,
          providerId: providerConfig.id,
        };
      }

      const closed = parsedToolPayload(request, 'close_instance');
      if (closed) {
        const processPayload = parsedToolPayload(request, 'start_process');
        assert.equal(typeof processPayload?.processId, 'string');
        return {
          content: '',
          model: request.model,
          providerId: providerConfig.id,
          toolCalls: [{
            id: 'stop-server',
            name: 'stop_process',
            input: { processId: processPayload?.processId },
          }],
        };
      }

      const instanceStatus = parsedToolPayload(request, 'instance_status');
      if (instanceStatus) {
        const openPayload = parsedToolPayload(request, 'open_instance');
        assert.equal(typeof openPayload?.instanceId, 'string');
        return {
          content: '',
          model: request.model,
          providerId: providerConfig.id,
          toolCalls: [{
            id: 'close-preview',
            name: 'close_instance',
            input: { instanceId: openPayload?.instanceId },
          }],
        };
      }

      const opened = parsedToolPayload(request, 'open_instance');
      if (opened) {
        assert.equal(typeof opened.instanceId, 'string');
        return {
          content: '',
          model: request.model,
          providerId: providerConfig.id,
          toolCalls: [{
            id: 'preview-status',
            name: 'instance_status',
            input: { instanceId: opened.instanceId },
          }],
        };
      }

      const ready = parsedToolPayload(request, 'wait_for_port');
      if (ready) {
        assert.equal(ready.ready, true);
        return {
          content: '',
          model: request.model,
          providerId: providerConfig.id,
          toolCalls: [{
            id: 'open-preview',
            name: 'open_instance',
            input: { kind: 'preview', target: `http://127.0.0.1:${port}/` },
          }],
        };
      }

      const started = parsedToolPayload(request, 'start_process');
      if (started) {
        assert.equal(typeof started.processId, 'string');
        assert.equal(started.executionId, 'process:acceptance-run:start-server');
        return {
          content: '',
          model: request.model,
          providerId: providerConfig.id,
          toolCalls: [{
            id: 'wait-ready',
            name: 'wait_for_port',
            input: {
              processId: started.processId,
              host: '127.0.0.1',
              port,
              timeoutMs: 10_000,
            },
          }],
        };
      }

      return {
        content: '',
        model: request.model,
        providerId: providerConfig.id,
        toolCalls: [{
          id: 'start-server',
          name: 'start_process',
          input: {
            command: `node -e "require('node:http').createServer((req,res)=>res.end('agent-core-acceptance')).listen(${port},'127.0.0.1')"`,
          },
        }],
      };
    },
  };
}

test('AgentRuntime orchestrates a full process and preview lifecycle with stable execution identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-agent-lifecycle-'));
  const project: ProjectRecord = {
    id: 'project-a',
    name: 'Acceptance Project',
    rootPath: root,
    createdAt: 1,
    updatedAt: 1,
  };
  const projects = async (): Promise<ProjectRecord[]> => [project];
  const processRuntime = new ProcessRuntime(projects);
  const openedTargets: string[] = [];
  const closedInstances: string[] = [];
  const instanceRuntime = new InstanceRuntime({
    open: async ({ instanceId, kind, target }): Promise<InstancePlatformHandle> => {
      assert.equal(kind, 'preview');
      openedTargets.push(target);
      let open = true;
      return {
        canFocus: true,
        canClose: true,
        close: () => {
          open = false;
          closedInstances.push(instanceId);
        },
        isOpen: () => open,
      };
    },
  });
  const workspace = new WorkspaceRuntime(projects);
  const tools = new ToolRuntime(workspace);
  tools.configureProcessRuntime(processRuntime);
  tools.configureInstanceRuntime(instanceRuntime);
  const port = await reservePort();
  const registry = new ProviderRegistry();
  registry.register(acceptanceAdapter(port));
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions());
  const agent = new AgentRuntime(chatRuntime, tools);
  const chat: ChatRecord = {
    id: 'chat-a',
    title: 'Lifecycle acceptance',
    projectId: 'project-a',
    providerId: providerConfig.id,
    model: 'acceptance-model',
    intelligence: 'normal',
    permissionLevel: 'unrestricted',
    messages: [{ role: 'user', content: 'Start a preview server, verify it, open the preview, then close and stop everything.' }],
    createdAt: 1,
    updatedAt: 1,
  };

  try {
    const result = await agent.run(
      providerConfig,
      chat,
      undefined,
      'unrestricted',
      'acceptance-run',
    );

    assert.equal(result.response.content, 'Preview lifecycle completed with process stopped and instance closed.');
    assert.equal(result.toolRounds, 6);
    assert.deepEqual(
      result.messages.filter((message) => message.role === 'tool').map((message) => message.toolName),
      ['start_process', 'wait_for_port', 'open_instance', 'instance_status', 'close_instance', 'stop_process'],
    );
    assert.equal(tools.listApprovals({ chatId: 'chat-a', runId: 'acceptance-run' }).length, 0);

    const process = processRuntime.list('project-a')[0];
    assert.ok(process);
    assert.equal(process.status, 'stopped');
    assert.equal(process.executionId, 'process:acceptance-run:start-server');
    assert.equal(process.chatId, 'chat-a');
    assert.equal(process.runId, 'acceptance-run');
    assert.equal(process.toolCallId, 'start-server');
    assert.equal(process.capabilityId, 'process.start');

    const instance = instanceRuntime.list('project-a')[0];
    assert.ok(instance);
    assert.equal(instance.status, 'closed');
    assert.deepEqual(openedTargets, [`http://127.0.0.1:${port}/`]);
    assert.deepEqual(closedInstances, [instance.instanceId]);
  } finally {
    await instanceRuntime.closeAll().catch((): void => {});
    await processRuntime.stopAll().catch((): never[] => []);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 50 : 0,
      retryDelay: 100,
    });
  }
});
