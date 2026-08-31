import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderAdapter, AIProviderConfig, AIResponse, AIToolCall, ChatRecord, ProjectRecord } from '../src/ai/types';

const config: AIProviderConfig = {
  id: 'test-provider',
  displayName: 'Test Provider',
  apiKey: 'test-key',
  enabled: true,
};

function chat(permissionLevel: ChatRecord['permissionLevel'] = 'ask'): ChatRecord {
  return {
    id: 'chat-test',
    title: 'Agent Test',
    projectId: 'project-test',
    providerId: config.id,
    model: 'test-model',
    intelligence: 'normal',
    permissionLevel,
    messages: [{ role: 'user', content: 'Do the task.' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function toolCall(id: string): AIToolCall {
  return { id, name: 'write_file', input: { path: 'src/index.ts', content: 'export const value = 43;' } };
}

function adapter(responses: AIResponse[]): AIProviderAdapter {
  let index = 0;
  return {
    id: config.id,
    displayName: config.displayName,
    async listModels() {
      return [{ id: 'test-model', name: 'Test Model', providerId: config.id, capabilities: ['text', 'tools'] }];
    },
    async send() {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

async function fixture(responses: AIResponse[]): Promise<{ root: string; agent: AgentRuntime; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-agent-test-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 42;');

  const project: ProjectRecord = {
    id: 'project-test',
    name: 'Agent Test Project',
    rootPath: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const tools = new ToolRuntime(workspace);
  const registry = new ProviderRegistry();
  registry.register(adapter(responses));
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions());

  return {
    root,
    agent: new AgentRuntime(chatRuntime, tools),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('run returns a normal response without tools', async () => {
  const fixtureData = await fixture([{ content: 'Done.', model: 'test-model', providerId: config.id }]);
  try {
    const result = await fixtureData.agent.run(config, chat(), undefined, 'ask');
    assert.equal(result.response.content, 'Done.');
    assert.equal(result.toolRounds, 0);
    assert.deepEqual(result.pendingApprovalIds, []);
    assert.equal(result.messages.at(-1)?.content, 'Done.');
  } finally {
    await fixtureData.cleanup();
  }
});

test('run preserves the tool round count across an approval resume', async () => {
  const fixtureData = await fixture(fixtureDataResponses());
  try {
    const pending = await fixtureData.agent.run(config, chat(), undefined, 'ask');
    assert.equal(pending.toolRounds, 1);
    assert.equal(pending.pendingApprovalIds.length, 1);

    const resumed = await fixtureData.agent.resume(pending.pendingApprovalIds[0]);
    assert.equal(resumed.toolRounds, 1);
    assert.equal(resumed.pendingApprovalIds.length, 0);
    assert.equal(resumed.response.content, 'Finished.');
    assert.equal(resumed.messages.filter((message) => message.role === 'tool').length, 1);
  } finally {
    await fixtureData.cleanup();
  }
});

test('resume consumes an approval exactly once', async () => {
  const fixtureData = await fixture(fixtureDataResponses());
  try {
    const pending = await fixtureData.agent.run(config, chat(), undefined, 'ask');
    const approvalId = pending.pendingApprovalIds[0];
    await fixtureData.agent.resume(approvalId);
    await assert.rejects(fixtureData.agent.resume(approvalId), /Aprovação não encontrada/);
  } finally {
    await fixtureData.cleanup();
  }
});

test('agent stops after the global twelve-round tool limit', async () => {
  const responses = Array.from({ length: 12 }, (_, index) => ({
    content: '',
    model: 'test-model',
    providerId: config.id,
    toolCalls: [toolCall(`call-${index + 1}`)],
  }));
  const fixtureData = await fixture(responses);
  try {
    await assert.rejects(
      fixtureData.agent.run(config, chat('unrestricted'), undefined, 'unrestricted'),
      /limite de ciclos de ferramentas/,
    );
  } finally {
    await fixtureData.cleanup();
  }
});

function fixtureDataResponses(): AIResponse[] {
  return [
    {
      content: '',
      model: 'test-model',
      providerId: config.id,
      toolCalls: [toolCall('call-approval')],
    },
    { content: 'Finished.', model: 'test-model', providerId: config.id },
  ];
}
