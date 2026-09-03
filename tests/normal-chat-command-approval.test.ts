import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProviderConfig, AIToolCall, ChatRecord } from '../src/ai/types';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { CommandRuntime, SYSTEM_PROJECT_ID } from '../src/agent/command-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';

const config: AIProviderConfig = {
  id: 'google',
  displayName: 'Google AI',
  apiKey: 'test-key',
  models: [],
};

const chat: ChatRecord = {
  id: 'chat-1',
  title: 'Teste',
  providerId: 'google',
  model: 'gemini-test',
  intelligence: 'Normal',
  permissionLevel: 'ask',
  messages: [{ role: 'user', content: 'Crie a pasta teste.', createdAt: Date.now() }],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function toolCall(): AIToolCall {
  return {
    id: 'call-1',
    name: 'run_command',
    arguments: { command: 'node -e "process.stdout.write(\'approval-test\')"' },
  };
}

function createToolRuntime() {
  const permissions = new PermissionRuntime();
  const commands = new CommandRuntime(async () => []);
  return new ToolRuntime(permissions, commands);
}

test('chat normal expõe run_command sem expor ferramentas de workspace', async () => {
  const adapter = {
    id: 'google' as const,
    displayName: 'Google AI',
    async send() {
      return { content: 'ok', model: 'gemini-test', providerId: 'google' as const };
    },
  };
  const registry = new ProviderRegistry([adapter]);
  const captured: any[] = [];
  const original = adapter.send;
  adapter.send = async (_config, request) => {
    captured.push(request);
    return original(_config, request);
  };
  const runtime = new ChatRuntime(registry, undefined, undefined, undefined, [
    { name: 'run_command', description: 'Executa um comando.', inputSchema: { type: 'object' } },
    { name: 'read_file', description: 'Lê um arquivo.', inputSchema: { type: 'object' } },
  ]);

  await runtime.send(config, { ...chat, messages: [...chat.messages] });

  assert.deepEqual(captured[0].tools?.map((tool: any) => tool.name), ['run_command']);
});

test('chat normal com permissão ask cria aprovação antes de executar run_command', async () => {
  const calls: AIToolCall[] = [];
  const adapter = {
    id: 'google' as const,
    displayName: 'Google AI',
    async send() {
      calls.push(toolCall());
      return {
        content: 'Vou executar o comando.',
        model: 'gemini-test',
        providerId: 'google' as const,
        toolCalls: [calls[calls.length - 1]],
      };
    },
  };
  const registry = new ProviderRegistry([adapter]);
  const chatRuntime = new ChatRuntime(registry, undefined, undefined, undefined, [
    { name: 'run_command', description: 'Executa um comando.', inputSchema: { type: 'object' } },
  ]);
  const tools = createToolRuntime();
  const agent = new AgentRuntime(chatRuntime, tools);

  const result = await agent.run(config, { ...chat, messages: [...chat.messages] }, undefined, 'ask');

  assert.equal(result.pendingApprovalIds.length, 1);
  assert.equal(tools.listApprovals().length, 1);
  assert.equal(result.messages.some((message) => message.role === 'tool'), false);
  assert.equal(tools.listApprovals()[0].toolName, 'run_command');
  assert.equal(tools.listApprovals()[0].projectId, SYSTEM_PROJECT_ID);
});
