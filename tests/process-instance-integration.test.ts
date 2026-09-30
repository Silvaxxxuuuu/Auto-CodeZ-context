import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AIToolCall, ProjectRecord } from '../src/ai/types';
import { InstanceRuntime, type InstancePlatformHandle } from '../src/agent/instance-runtime';
import { ProcessRuntime } from '../src/agent/process-runtime';
import { ToolRuntime } from '../src/agent/tool-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

function call(id: string, name: AIToolCall['name'], input: Record<string, unknown>): AIToolCall {
  return { id, name, input };
}

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

function readHttp(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.once('end', () => resolve(body));
      response.once('error', reject);
    }).once('error', reject);
  });
}

test('real managed server becomes ready, opens a scoped preview, and supports its full lifecycle', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-instance-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-process-instance-b-'));
  const projects: ProjectRecord[] = [
    { id: 'project-a', name: 'A', rootPath: rootA, createdAt: 1, updatedAt: 1 },
    { id: 'project-b', name: 'B', rootPath: rootB, createdAt: 1, updatedAt: 1 },
  ];
  const processes = new ProcessRuntime(async () => projects);
  const openedUrls: string[] = [];
  const focusedIds: string[] = [];
  const closedIds: string[] = [];
  const instances = new InstanceRuntime({
    open: async ({ instanceId, kind, target }): Promise<InstancePlatformHandle> => {
      assert.equal(kind, 'preview');
      assert.equal(await readHttp(target), 'auto-codez-preview-ready');
      openedUrls.push(target);
      let open = true;
      return {
        canFocus: true,
        canClose: true,
        focus: () => { focusedIds.push(instanceId); },
        close: () => { open = false; closedIds.push(instanceId); },
        isOpen: () => open,
      };
    },
  });
  const tools = new ToolRuntime(new WorkspaceRuntime(async () => projects));
  tools.configureProcessRuntime(processes);
  tools.configureInstanceRuntime(instances);

  try {
    const port = await reservePort();
    const command = `node -e "require('node:http').createServer((req,res)=>res.end('auto-codez-preview-ready')).listen(${port},'127.0.0.1')"`;
    const started = await tools.execute('chat-a', 'project-a', 'unrestricted', call('start', 'start_process', { command }), 'run-a');
    assert.equal(started.ok, true, started.error);
    const processId = JSON.parse(started.output ?? '{}').processId as string;

    const crossPort = await tools.execute('chat-b', 'project-b', 'unrestricted', call('cross-port', 'wait_for_port', {
      processId, port, timeoutMs: 0, host: '127.0.0.1',
    }), 'run-b');
    assert.equal(crossPort.ok, false);
    assert.match(crossPort.error ?? '', /outro projeto/i);

    const ready = await tools.execute('chat-a', 'project-a', 'unrestricted', call('ready', 'wait_for_port', {
      processId, port, timeoutMs: 10000, host: '127.0.0.1',
    }), 'run-a');
    assert.equal(ready.ok, true, ready.error);
    assert.equal(JSON.parse(ready.output ?? '{}').ready, true);

    const target = `http://127.0.0.1:${port}/`;
    const opened = await tools.execute('chat-a', 'project-a', 'unrestricted', call('open', 'open_instance', {
      kind: 'preview', target,
    }), 'run-a');
    assert.equal(opened.ok, true, opened.error);
    const instance = JSON.parse(opened.output ?? '{}');
    assert.equal(instance.projectId, 'project-a');
    assert.equal(instance.status, 'open');
    assert.deepEqual(instance.capabilities, { focus: true, close: true });
    assert.deepEqual(openedUrls, [target]);

    const foreign = await tools.execute('chat-b', 'project-b', 'unrestricted', call('foreign', 'instance_status', {
      instanceId: instance.instanceId,
    }), 'run-b');
    assert.equal(foreign.ok, false);
    assert.match(foreign.error ?? '', /outro projeto/i);

    const status = await tools.execute('chat-a', 'project-a', 'unrestricted', call('status', 'instance_status', {
      instanceId: instance.instanceId,
    }), 'run-a');
    assert.equal(status.ok, true);
    assert.equal(JSON.parse(status.output ?? '{}').status, 'open');

    const listed = await tools.execute('chat-a', 'project-a', 'unrestricted', call('list', 'list_instances', {}), 'run-a');
    assert.equal(listed.ok, true);
    assert.deepEqual(JSON.parse(listed.output ?? '[]').map((item: { instanceId: string }) => item.instanceId), [instance.instanceId]);

    const focused = await tools.execute('chat-a', 'project-a', 'unrestricted', call('focus', 'focus_instance', {
      instanceId: instance.instanceId,
    }), 'run-a');
    assert.equal(focused.ok, true);
    assert.deepEqual(focusedIds, [instance.instanceId]);

    const closed = await tools.execute('chat-a', 'project-a', 'unrestricted', call('close', 'close_instance', {
      instanceId: instance.instanceId,
    }), 'run-a');
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.output ?? '{}').status, 'closed');
    assert.deepEqual(closedIds, [instance.instanceId]);

    const stopped = await tools.execute('chat-a', 'project-a', 'unrestricted', call('stop', 'stop_process', { processId }), 'run-a');
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(JSON.parse(stopped.output ?? '{}').status, 'stopped');
    assert.equal(tools.listApprovals({ chatId: 'chat-a', runId: 'run-a' }).length, 0);
  } finally {
    await instances.closeAll().catch((): void => {});
    await processes.stopAll().catch((): never[] => []);
    const cleanupOptions = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 50 : 0, retryDelay: 100 };
    await fs.rm(rootA, cleanupOptions);
    await fs.rm(rootB, cleanupOptions);
  }
});
