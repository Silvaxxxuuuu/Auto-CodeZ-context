import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';
import { ChatRuntime } from '../src/ai/chat-runtime';
import type { AIProviderAdapter, AIProviderConfig, AIToolCall, ApprovalRequest, ChatRecord, ProjectRecord } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  constructor(initial: Record<string, unknown> = {}) { for (const [key, value] of Object.entries(initial)) this.values.set(key, value); }
  async read<T>(name: string, fallback: T): Promise<T> { return this.values.has(name) ? this.values.get(name) as T : fallback; }
  async write<T>(name: string, value: T): Promise<void> { this.values.set(name, value); }
  value<T>(name: string): T | undefined { return this.values.get(name) as T | undefined; }
}

const config: AIProviderConfig = { id: 'test-provider', displayName: 'Test Provider', apiKey: 'test-key', enabled: true };
const call: AIToolCall = { id: 'approval-call', name: 'run_command', input: { command: 'mkdir teste' } };
const chat: ChatRecord = { id: 'chat-recovered', title: 'Recovered', projectId: '__system__', providerId: config.id, model: 'test-model', intelligence: 'normal', permissionLevel: 'ask', messages: [], createdAt: 1, updatedAt: 1 };
const approval: ApprovalRequest = { id: 'approval-recovered', projectId: '__system__', permissionLevel: 'ask', toolCall: call, createdAt: 1 };

function adapter(): AIProviderAdapter {
  return {
    id: config.id,
    displayName: config.displayName,
    async listModels() { return [{ id: 'test-model', name: 'Test Model', providerId: config.id, capabilities: ['text', 'tools'] }]; },
    async send() { return { content: 'done', model: 'test-model', providerId: config.id }; },
  };
}

function createRuntime(storage: MemoryStorage): { runtime: AgentRuntime; tools: ToolRuntime } {
  const project: ProjectRecord = { id: '__system__', name: 'System', rootPath: process.cwd(), createdAt: 1, updatedAt: 1 };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const tools = new ToolRuntime(workspace);
  const registry = new ProviderRegistry();
  registry.register(adapter());
  return { runtime: new AgentRuntime(new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions()), tools, undefined, storage), tools };
}

test('migrates persisted approvals to the owning chat and run before exposing them', async () => {
  const storage = new MemoryStorage({
    'agent-runs.json': {
      version: 2,
      runs: [{ runId: 'run-recovered', config, chat, projectContext: undefined, permission: 'ask', workingChat: chat, pendingApprovalIds: [approval.id], approvalCalls: { [approval.id]: call }, toolRounds: 1 }],
      approvals: [approval],
    },
  });
  const { runtime, tools } = createRuntime(storage);

  await runtime.init();

  const persisted = storage.value<{ approvals: ApprovalRequest[] }>('agent-runs.json');
  assert.equal(persisted?.approvals[0]?.chatId, chat.id);
  assert.equal(persisted?.approvals[0]?.runId, 'run-recovered');
  assert.deepEqual(tools.listApprovals({ chatId: chat.id, runId: 'run-recovered' }).map((item) => item.id), [approval.id]);
  assert.deepEqual(tools.listApprovals({ chatId: chat.id, runId: 'other-run' }), []);
  assert.equal(runtime.getPendingRunId(approval.id), 'run-recovered');
});

test('keeps approvals from two chats and runs isolated after recovery', async () => {
  const chatA: ChatRecord = { ...chat, id: 'chat-a', title: 'A' };
  const chatB: ChatRecord = { ...chat, id: 'chat-b', title: 'B' };
  const callA: AIToolCall = { ...call, id: 'call-a' };
  const callB: AIToolCall = { ...call, id: 'call-b' };
  const approvalA: ApprovalRequest = { ...approval, id: 'approval-a', toolCall: callA };
  const approvalB: ApprovalRequest = { ...approval, id: 'approval-b', toolCall: callB };
  const storage = new MemoryStorage({
    'agent-runs.json': {
      version: 2,
      runs: [
        { runId: 'run-a', config, chat: chatA, projectContext: undefined, permission: 'ask', workingChat: chatA, pendingApprovalIds: [approvalA.id], approvalCalls: { [approvalA.id]: callA }, toolRounds: 1 },
        { runId: 'run-b', config, chat: chatB, projectContext: undefined, permission: 'ask', workingChat: chatB, pendingApprovalIds: [approvalB.id], approvalCalls: { [approvalB.id]: callB }, toolRounds: 1 },
      ],
      approvals: [approvalA, approvalB],
    },
  });
  const { runtime, tools } = createRuntime(storage);

  await runtime.init();

  assert.deepEqual(tools.listApprovals({ chatId: chatA.id, runId: 'run-a' }).map((item) => item.id), [approvalA.id]);
  assert.deepEqual(tools.listApprovals({ chatId: chatA.id, runId: 'run-b' }), []);
  assert.deepEqual(tools.listApprovals({ chatId: chatB.id, runId: 'run-b' }).map((item) => item.id), [approvalB.id]);
  assert.equal(runtime.getPendingRunId(approvalA.id), 'run-a');
  assert.equal(runtime.getPendingRunId(approvalB.id), 'run-b');
});
