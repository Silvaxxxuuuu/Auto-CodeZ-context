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

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

const config: AIProviderConfig = { id: 'recovery-provider', displayName: 'Recovery Provider', apiKey: 'test-key', enabled: true };

function makeChat(): ChatRecord {
  return {
    id: 'recovery-chat', title: 'Recovery Test', projectId: 'recovery-project', providerId: config.id, model: 'test-model', intelligence: 'normal', permissionLevel: 'ask',
    messages: [{ role: 'user', content: 'Edit the project.' }], createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function makeAdapter(responses: AIResponse[], failAfter = Number.POSITIVE_INFINITY): AIProviderAdapter {
  let calls = 0;
  return {
    id: config.id, displayName: config.displayName,
    async listModels() { return [{ id: 'test-model', name: 'Test Model', providerId: config.id, capabilities: ['text', 'tools'] }]; },
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

async function createPersistentFixture(storage: MemoryStorage, responses: AIResponse[], root: string): Promise<AgentRuntime> {
  const project: ProjectRecord = { id: 'recovery-project', name: 'Recovery Project', rootPath: root, createdAt: Date.now(), updatedAt: Date.now() };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const tools = new ToolRuntime(workspace, undefined, undefined, undefined, undefined, undefined, storage);
  const registry = new ProviderRegistry();
  registry.register(makeAdapter(responses));
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions());
  await tools.init();
  const agent = new AgentRuntime(chatRuntime, tools, undefined, storage);
  await agent.init();
  return agent;
}

const writeCall = { id: 'recovery-write', name: 'write_file' as const, input: { path: 'src/index.ts', content: 'export const value = 2;' } };

test('denying an approval records the refusal and allows the run to finish', async () => {
  const fixture = await createFixture([
    { content: '', model: 'test-model', providerId: config.id, toolCalls: [writeCall] },
    { content: 'The operation was denied.', model: 'test-model', providerId: config.id },
  ]);
  try {
    const pending = await fixture.agent.run(config, makeChat(), undefined, 'ask');
    const result = await fixture.agent.reject(pending.pendingApprovalIds[0]);
    assert.equal(result.pendingApprovalIds.length, 0);
    const refusal = result.messages.find((message) => message.role === 'tool' && message.toolCallId === writeCall.id);
    assert.equal(refusal?.content, 'Operação recusada pelo usuário.');
    assert.equal(result.response.content, 'The operation was denied.');
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test('a tool failure is recorded as a tool result and the agent continues', async () => {
  const missingFileCall = { id: 'missing-write', name: 'write_file' as const, input: { path: 'src/missing.ts', content: 'x' } };
  const fixture = await createFixture([
    { content: '', model: 'test-model', providerId: config.id, toolCalls: [missingFileCall] },
    { content: 'Recovered from tool failure.', model: 'test-model', providerId: config.id },
  ]);
  try {
    const pending = await fixture.agent.run(config, makeChat(), undefined, 'ask');
    const result = await fixture.agent.resume(pending.pendingApprovalIds[0]);
    assert.equal(result.pendingApprovalIds.length, 0);
    assert.equal(result.messages.filter((message) => message.role === 'tool').length, 1);
    assert.match(result.messages.find((message) => message.role === 'tool')?.content || '', /arquivo não existe/i);
    assert.equal(result.response.content, 'Recovered from tool failure.');
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
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
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test('recovers pending approvals after runtime reconstruction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-recovery-persisted-'));
  const storage = new MemoryStorage();
  const firstResponse: AIResponse = { content: '', model: 'test-model', providerId: config.id, toolCalls: [writeCall] };
  const finalResponse: AIResponse = { content: 'Recovered and finished.', model: 'test-model', providerId: config.id };
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
    const first = await createPersistentFixture(storage, [firstResponse], root);
    const pending = await first.run(config, makeChat(), undefined, 'ask');
    assert.equal(pending.pendingApprovalIds.length, 1);
    assert.equal(await fs.readFile(path.join(root, 'src', 'index.ts'), 'utf8'), 'export const value = 1;');

    const recovered = await createPersistentFixture(storage, [finalResponse], root);
    const approvalId = pending.pendingApprovalIds[0];
    assert.equal(recovered.hasPendingForChat('recovery-chat'), true);
    const result = await recovered.resume(approvalId);

    assert.equal(result.pendingApprovalIds.length, 0);
    assert.equal(result.response.content, 'Recovered and finished.');
    assert.equal(await fs.readFile(path.join(root, 'src', 'index.ts'), 'utf8'), 'export const value = 2;');
    assert.equal(recovered.hasPendingForChat('recovery-chat'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('recovers an already-applied mutation from the write-ahead journal without executing it twice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-journal-recovery-'));
  const storage = new MemoryStorage();
  const firstResponse: AIResponse = { content: '', model: 'test-model', providerId: config.id, toolCalls: [writeCall] };
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;');
    const first = await createPersistentFixture(storage, [firstResponse], root);
    const pending = await first.run(config, makeChat(), undefined, 'ask');
    assert.equal(pending.pendingApprovalIds.length, 1);
    const approvals = await storage.read<any[]>('agent-runs.json', []);
    const approval = approvals.approvals[0];
    assert.ok(approval?.diffPlan);

    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 2;');
    await storage.write('tool-execution-journal.json', [{ approvalId: approval.id, projectId: 'recovery-project', toolCall: writeCall, diffPlan: approval.diffPlan, status: 'executing' }]);

    const recovered = await createPersistentFixture(storage, [{ content: 'Journal recovery complete.', model: 'test-model', providerId: config.id }], root);
    const result = await recovered.resume(approval.id);

    assert.equal(result.pendingApprovalIds.length, 0);
    assert.equal(result.response.content, 'Journal recovery complete.');
    assert.equal(await fs.readFile(path.join(root, 'src', 'index.ts'), 'utf8'), 'export const value = 2;');
    assert.deepEqual(await storage.read('tool-execution-journal.json', []), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('discards persisted runs whose approvals no longer exist', async () => {
  const storage = new MemoryStorage();
  await storage.write('agent-runs.json', {
    version: 1,
    runs: [{
      config,
      chat: makeChat(),
      permission: 'ask',
      workingChat: makeChat(),
      pendingApprovalIds: ['missing-approval'],
      approvalCalls: { 'missing-approval': writeCall },
      toolRounds: 1,
    }],
    approvals: [],
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-recovery-invalid-'));
  try {
    const runtime = await createPersistentFixture(storage, [], root);
    assert.equal(runtime.hasPendingForChat('recovery-chat'), false);
    const state = await storage.read<{ runs: unknown[] }>('agent-runs.json', { runs: [] });
    assert.deepEqual(state.runs, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
