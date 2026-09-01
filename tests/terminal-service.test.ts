import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalService } from '../src/agent/terminal-service';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

const project = {
  id: 'project-a',
  name: 'Test Project',
  rootPath: process.cwd(),
  createdAt: 1,
  updatedAt: 1,
};

test('orchestrates terminal execution and persists its final history', async () => {
  const storage = new MemoryStorage();
  const service = new TerminalService(storage as never, async () => [project]);
  await service.init();

  const events: string[] = [];
  const unsubscribe = service.subscribe((event) => {
    events.push(event.type);
  });

  const session = await service.start('project-a', process.platform === 'win32' ? 'echo terminal-service-test' : 'printf terminal-service-test');
  assert.equal(session.status, 'running');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await service.listSessions()).find((item) => item.id === session.id);
    if (current?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const history = await service.listHistory('project-a');
  assert.equal(history.length, 1);
  assert.match(history[0].output, /terminal-service-test/);
  assert.deepEqual(events, ['output', 'exit']);

  unsubscribe();
  service.dispose();
});

test('isolates subscriber failures from terminal execution', async () => {
  const storage = new MemoryStorage();
  const service = new TerminalService(storage as never, async () => [project]);
  await service.init();
  service.subscribe(() => { throw new Error('observer failure'); });

  const session = await service.start('project-a', process.platform === 'win32' ? 'echo ok' : 'printf ok');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await service.listSessions()).find((item) => item.id === session.id);
    if (current?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const [history] = await service.listHistory('project-a');
  assert.equal(history.exitCode, 0);
  service.dispose();
});
