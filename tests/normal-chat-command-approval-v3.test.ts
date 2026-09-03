import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProviderConfig, AIRequest, AIResponse, AIToolCall, ChatRecord } from '../src/ai/types';
import { ChatRuntime } from '../src/ai/chat-runtime';
import { AgentRuntime } from '../src/agent/agent-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { CommandRuntime, SYSTEM_PROJECT_ID } from '../src/agent/command-runtime';
import { PermissionRuntime } from '../src/agent/permission-runtime';
import { ProviderRegistry } from '../src/ai/provider-registry';

const config: AIProviderConfig = { id: 'google', displayName: 'Google AI', apiKey: 'test-key', models: [{ id: 'gemini-test', displayName: 'Gemini Test', capabilities: ['text', 'tools'] }] };
const chat: ChatRecord = { id: 'chat-1', title: 'Teste', providerId: 'google', model: 'gemini-test', intelligence: 'Normal', permissionLevel: 'ask', messages: [{ role: 'user', content: 'Crie a pasta teste.', createdAt: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() };
const call: AIToolCall = { id: 'call-1', name: 'run_command', arguments: { command: "node -e \"process.stdout.write('approval-test')\"" } };

function createRuntime(send: (request: AIRequest) => Promise<AIResponse>) {
  const adapter = { id: 'google' as const, displayName: 'Google AI', async listModels() { return config.models; }, send };
  const chatRuntime = new ChatRuntime(new ProviderRegistry([adapter]), undefined, undefined, undefined, [{ name: 'run_command', description: 'Executa um comando.', inputSchema: { type: 'object' } }]);
  return { chatRuntime, tools: new ToolRuntime(new PermissionRuntime(), new CommandRuntime(async () => [])) };
}

test('chat normal expõe run_command sem expor ferramentas de workspace', async () => {
  let request!: AIRequest;
  const { chatRuntime } = createRuntime(async (_request) => { request = _request; return { content: 'ok', model: 'gemini-test', providerId: 'google' }; });
  await chatRuntime.send(config, { ...chat, messages: [...chat.messages] });
  assert.deepEqual(request.tools?.map((tool) => tool.name), ['run_command']);
});

test('chat normal com permissão ask cria aprovação e só executa após aprovação', async () => {
  let executions = 0;
  const adapter = { id: 'google' as const, displayName: 'Google AI', async listModels() { return config.models; }, async send(_config: AIProviderConfig, request: AIRequest): Promise<AIResponse> { return request.messages.some((message) => message.role === 'tool') ? { content: 'Comando concluído.', model: 'gemini-test', providerId: 'google' } : { content: 'Vou executar o comando.', model: 'gemini-test', providerId: 'google', toolCalls: [call] }; } };
  const chatRuntime = new ChatRuntime(new ProviderRegistry([adapter]), undefined, undefined, undefined, [{ name: 'run_command', description: 'Executa um comando.', inputSchema: { type: 'object' } }]);
  const tools = new ToolRuntime(new PermissionRuntime(), new CommandRuntime(async () => { executions += 1; return []; }));
  const agent = new AgentRuntime(chatRuntime, tools);
  const result = await agent.run(config, { ...chat, messages: [...chat.messages] }, undefined, 'ask');
  assert.equal(result.pendingApprovalIds.length, 1);
  assert.equal(executions, 0);
  assert.equal(result.messages.some((message) => message.role === 'tool'), false);
  assert.equal(tools.listApprovals()[0].projectId, SYSTEM_PROJECT_ID);
  await agent.resume(result.pendingApprovalIds[0]);
  assert.equal(executions, 1);
});
