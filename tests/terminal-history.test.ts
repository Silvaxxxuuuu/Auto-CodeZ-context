import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalHistory } from '../src/agent/terminal-history';
import type { TerminalHistoryRecord } from '../src/agent/terminal-history';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

function record(projectId: string, command: string, finishedAt: number): Omit<TerminalHistoryRecord, 'id'> {
  return {
    projectId,
    command,
    cwd: '/tmp/project',
    startedAt: finishedAt - 100,
    finishedAt,
    exitCode: 0,
    status: 'exited',
    output: `output for ${command}`,
  };
}

test('persists terminal sessions and restores them', async () => {
  const storage = new MemoryStorage();
  const first = new TerminalHistory(storage as never);
  await first.init();

  const created = await first.add(record('project-a', 'npm test', 20));
  assert.equal(created.projectId, 'project-a');
  assert.match(created.id, /^[0-9a-f-]{36}$/);

  const second = new TerminalHistory(storage as never);
  await second.init();
  assert.deepEqual(await second.list(), [created]);
});

test('filters history by project and keeps newest first', async () => {
  const storage = new MemoryStorage();
  const history = new TerminalHistory(storage as never);
  await history.init();

  const older = await history.add(record('project-a', 'npm test', 10));
  const newer = await history.add(record('project-b', 'npm run build', 20));
  const newest = await history.add(record('project-a', 'npm run lint', 30));

  assert.deepEqual((await history.list()).map((item) => item.id), [newest.id, newer.id, older.id]);
  assert.deepEqual((await history.list('project-a')).map((item) => item.id), [newest.id, older.id]);
});

test('clears one project without affecting another', async () => {
  const storage = new MemoryStorage();
  const history = new TerminalHistory(storage as never);
  await history.init();

  await history.add(record('project-a', 'npm test', 10));
  await history.add(record('project-b', 'npm test', 20));
  await history.clear('project-a');

  assert.deepEqual((await history.list()).map((item) => item.projectId), ['project-b']);
});

test('rejects invalid records', async () => {
  const storage = new MemoryStorage();
  const history = new TerminalHistory(storage as never);
  await history.init();

  await assert.rejects(() => history.add(record('', 'npm test', 10)), /Projeto da sessão inválido/);
  await assert.rejects(() => history.add(record('project-a', '', 10)), /Comando da sessão inválido/);
  await assert.rejects(() => history.add({ ...record('project-a', 'npm test', 10), startedAt: 20 }), /Término da sessão inválido/);
});

test('trims oversized output from the end', async () => {
  const storage = new MemoryStorage();
  const history = new TerminalHistory(storage as never);
  await history.init();

  const output = 'x'.repeat(2_000_100);
  const created = await history.add({ ...record('project-a', 'npm test', 10), output });

  assert.equal(created.output.length, 2_000_000);
  assert.equal(created.output, output.slice(-2_000_000));
});
