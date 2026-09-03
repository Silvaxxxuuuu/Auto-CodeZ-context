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

test('migrates persisted approvals to the owning chat before exposing them', async () => {
  const project: ProjectRecord = { id: '__system__', name: 'System', rootPath: process.cwd(), createdAt: 1, updatedAt: 1 };
  const workspace = new WorkspaceRuntime(async () => [project]);
  const tools = new ToolRuntime(workspace);
  const registry = new ProviderRegistry();
  registry.register(adapter());
  const storage = new MemoryStorage({
    'agent-runs.json': {
      version: 2,
      runs: [{ runId: 'run-recovered', config, chat, projectContext: undefined, permission: 'ask', workingChat: chat, pendingApprovalIds: [approval.id], approvalCalls: { [approval.id]: call }, toolRounds: 1 }],
      approvals: [approval],
    },
  });
  const runtime = new AgentRuntime(new ChatRuntime(registry, undefined, undefined, undefined, undefined, tools.listDefinitions()), tools, undefined, storage);

  await runtime.init();

  const persisted = storage.value<{ approvals: ApprovalRequest[] }>('agent-runs.json');
  assert.equal(persisted?.approvals[0]?.chatId, chat.id);
});
