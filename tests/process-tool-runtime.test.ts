import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { ProcessRuntime } from '../src/agent/process-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

async function fixture() {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-tool-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-tool-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  const workspace = new WorkspaceRuntime(async () => projects);
  const processes = new ProcessRuntime(async () => projects);
  const tools = new ToolRuntime(workspace);
  tools.configureProcessRuntime(processes);
  return {
    rootA,
    tools,
    processes,
    cleanup: async () => {
      await processes.stopAll().catch((): never[] => []);
      const cleanupOptions = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 };
      await fs.rm(rootA, cleanupOptions);
      await fs.rm(rootB, cleanupOptions);
    },
  };
}

function nodeCommand(expression: string): string {
  return `node -e "${expression}"`;
}

test('ToolRuntime exposes the full persistent process lifecycle without approvals in unrestricted mode', async () => {
  const f = await fixture();
  try {
    const started = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('start', 'start_process', {
      command: nodeCommand("process.stdout.write('ready'); setTimeout(() => {}, 30000)"),
    }), 'run-a');
    assert.equal(started.ok, true);
    assert.equal(started.pendingApproval, undefined);
    const startedPayload = JSON.parse(started.output ?? '{}');
    assert.equal(typeof startedPayload.processId, 'string');
    assert.equal(startedPayload.runId, 'run-a');
    assert.equal(startedPayload.toolCallId, 'start');

    const processId = startedPayload.processId as string;
    assert.equal(f.processes.get(processId).runId, 'run-a');
    assert.equal(f.processes.get(processId).toolCallId, 'start');
    const polled = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('wait', 'wait_process', {
      processId,
      timeoutMs: 250,
    }), 'run-a');
    assert.equal(polled.ok, true);
    assert.equal(JSON.parse(polled.output ?? '{}').status, 'running');

    const output = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('read', 'read_process_output', {
      processId,
      afterSequence: 0,
    }), 'run-a');
    assert.equal(output.ok, true);
    assert.match(JSON.parse(output.output ?? '{}').events.map((event: { text: string }) => event.text).join(''), /ready/);

    const listed = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('list', 'list_processes', {}), 'run-a');
    assert.equal(listed.ok, true);
    assert.equal(JSON.parse(listed.output ?? '[]').some((item: { id: string }) => item.id === processId), true);

    const stopped = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('stop', 'stop_process', { processId }), 'run-a');
    assert.equal(stopped.ok, true);
    assert.equal(JSON.parse(stopped.output ?? '{}').status, 'stopped');
    assert.equal(f.tools.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
  } finally {
    await f.cleanup();
  }
});

test('start_process uses the same command safety deny rules as run_command', async () => {
  const f = await fixture();
  try {
    const result = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('unsafe', 'start_process', {
      command: 'echo TOKEN=x > .env',
    }), 'run-a');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /política de segurança|segredo|credencial|variáveis de ambiente/i);
    assert.equal(f.processes.list('project-a').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('process lifecycle tools cannot cross project boundaries', async () => {
  const f = await fixture();
  try {
    const started = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('start', 'start_process', {
      command: nodeCommand("setTimeout(() => {}, 30000)"),
    }), 'run-a');
    const processId = JSON.parse(started.output ?? '{}').processId as string;

    for (const [name, input] of [
      ['read_process_output', { processId, afterSequence: 0 }],
      ['wait_process', { processId, timeoutMs: 0 }],
      ['stop_process', { processId }],
    ] as const) {
      const result = await f.tools.execute('chat-b', 'project-b', 'unrestricted', call(`cross-${name}`, name, input), 'run-b');
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /outro projeto/i);
    }

    assert.equal(f.processes.get(processId).status, 'running');
  } finally {
    await f.cleanup();
  }
});

test('start_process in ask mode requires approval and starts only after approval', async () => {
  const f = await fixture();
  try {
    const pending = await f.tools.execute('chat-a', 'project-a', 'ask', call('start-ask', 'start_process', {
      command: nodeCommand("setTimeout(() => {}, 30000)"),
    }), 'run-a');
    assert.equal(pending.pendingApproval, true);
    assert.equal(f.processes.list('project-a').length, 0);

    const approved = await f.tools.approve(pending.approvalId as string);
    assert.equal(approved.ok, true);
    assert.equal(f.processes.list('project-a').length, 1);
  } finally {
    await f.cleanup();
  }
});


test('wait_for_port tool reports readiness only for loopback port associated with the active project', async () => {
  const f = await fixture();
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const started = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('start-port', 'start_process', {
      command: nodeCommand("setTimeout(() => {}, 30000)"),
    }), 'run-a');
    const processId = JSON.parse(started.output ?? '{}').processId as string;

    const ready = await f.tools.execute('chat-a', 'project-a', 'unrestricted', call('wait-port', 'wait_for_port', {
      processId,
      port: address.port,
      timeoutMs: 1000,
      host: 'localhost',
    }), 'run-a');
    assert.equal(ready.ok, true);
    const payload = JSON.parse(ready.output ?? '{}');
    assert.equal(payload.ready, true);
    assert.equal(payload.host, '127.0.0.1');
    assert.equal(payload.port, address.port);
    assert.equal(f.tools.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch((): undefined => undefined);
    await f.cleanup();
  }
});
