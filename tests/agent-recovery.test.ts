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
import type { AIProviderAdapter, AIProviderConfig, AIResponse, ChatRecord, ProjectRecord } from '../src/ai/types';

const config: AIProviderConfig = { id: 'recovery-provider', displayName: 'Recovery Provider', apiKey: 'test-key', enabled: true };

function makeChat(): ChatRecord {
  return {
    id: 'recovery-chat',
    title: 'Recovery Test',
    projectId: 'recovery-project',
    providerId: config.id,
    model: 'test-model',
    intelligence: 'normal',
    permissionLevel: 'ask',
    messages: [{ role: 'user', content: 'Edit the project.' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeAdapter(responses: AIResponse[], failAfter = Number.POSITIVE_INFINITY): AIProviderAdapter {
  let calls = 0;
  return {
    id: config.id,
    displayName: config.displayName,
    async listModels() {
      return [{ id: 'test-model', name: 'Test Model', providerId: config.id, capabilities: ['text', 'tools'] }];
    },
    async send() {
      calls += 1;
      if (calls > failAfter) throw new Error('Provider indisponível durante a retomada.');
      return responses[Math.min(calls - 1, responses.length - 1)];
    },
  };
}

async function createFixture(responses: AIResponse[], failAfter = Number.POSITIVE_INFINITY): Promise<{ agent: AgentRuntime; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-recovery-test-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
  const project: ProjectRecord = { id: 'recovery-project', name: 'Recovery Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const tools = new ToolRuntime(workspace);
  const registry = new ProviderRegistry();
  registry.register(makeAdapter(responses, failAfter));
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions());
  return { agent: new AgentRuntime(chatRuntime, tools), root };
}

const writeCall = {
  id: 'recovery-write',
  name: 'write_file' as const,
  input: { path: 'src/index.ts', content: 'export const value = 2;' },
};

test('denying an approval records the refusal and allows the run to finish', async () => {
  const fixture = await createFixture([
    { content: '', model: 'test-model', providerId: config.id, toolCalls: [writeCall] },
    { content: 'The operation was denied.', model: 'test-model', providerId: config.id },
  ]);
  try {
    const pending = await fixture.agent.run(config, makeChat(), undefined, 'ask');
    const result = await fixture.agent.reject(pending.pendingApprovalIds[0]);
    assert.equal(result.pendingApprovalIds.length, 0);
    assert.match(result.messages.at(-1)?.content || '', /recusada pelo usuário/);
    assert.equal(result.response.content, 'The operation was denied.');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('a tool failure is recorded as a tool result and the agent continues', async () => {
  const missingFileCall = { id: 'missing-write', name: 'write_file' as const, input: { path: 'src/missing.ts', content: 'x' } };
  const fixture = await createFixture([
    { content: '', model: 'test-model', providerId: config.id, toolCalls: [missingFileCall] },
    { content: 'Recovered from tool failure.', model: 'test-model', providerId: config.id },
  ]);
  try {
    const pending = await fixture.agent.run(config, makeChat(), undefined, 'unrestricted');
    const result = await fixture.agent.resume(pending.pendingApprovalIds[0]);
    assert.equal(result.pendingApprovalIds.length, 0);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 1);
    assert.match(result.messages.find((message) => message.role === 'tool')?.content || '', /arquivo não existe/i);
    assert.equal(result.response.content, 'Recovered from tool failure.');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('provider failure after an approved tool does not re-execute the tool', async () => {
  const fixture = await createFixture([
    { content: '', model: 'test-model', providerId: config.id, toolCalls: [writeCall] },
    { content: 'Never reached.', model: 'test-model', providerId: config.id },
  ], 1);
  try {
    const pending = await fixture.agent.run(config, makeChat(), undefined, 'ask');
    await assert.rejects(fixture.agent.resume(pending.pendingApprovalIds[0]), /Provider indisponível/);
    assert.equal(await fs.readFile(path.join(fixture.root, 'src', 'index.ts'), 'utf8'), 'export const value = 2;');
    await assert.rejects(fixture.agent.resume(pending.pendingApprovalIds[0]), /Aprovação não encontrada/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
