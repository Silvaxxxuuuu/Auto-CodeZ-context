import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type PluginRegistration = {
  activate(api: FakeApi): Promise<void>;
  invoke(method: string, payload: unknown, api: FakeApi): Promise<unknown>;
  deactivate(api: FakeApi): Promise<void>;
};

type RegisteredTool = {
  id: string;
  risk: string;
  parameters: Record<string, unknown>;
};

type McpCall = {
  name: string;
  input: unknown;
};

type FakeApi = ReturnType<typeof createApi>['api'];

async function loadPlugin(): Promise<PluginRegistration> {
  const source = await readFile(path.resolve('plugins/roblox-studio-manager/main.js'), 'utf8');
  let registration: PluginRegistration | undefined;
  vm.runInNewContext(source, {
    autoCodez: {
      register(value: PluginRegistration) {
        registration = value;
      },
    },
  }, { filename: 'plugins/roblox-studio-manager/main.js' });
  assert.ok(registration);
  return registration;
}

function createApi(options: { failCapture?: boolean; failStop?: boolean } = {}) {
  const registeredTools: RegisteredTool[] = [];
  const calls: McpCall[] = [];
  const jobEvents: Array<{ type: string; value?: unknown }> = [];
  const catalog = {
    tools: [
      {
        name: 'start_stop_play',
        description: 'Start or stop Play mode.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['play', 'stop'] },
          },
          required: ['mode'],
          additionalProperties: false,
        },
      },
      {
        name: 'screen_capture',
        description: 'Capture Studio viewport.',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['png'] },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'get_console_output',
        description: 'Read Studio console output.',
        inputSchema: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['all', 'error'] },
          },
          required: [],
          additionalProperties: false,
        },
      },
    ],
  };

  const api = {
    activity: {
      async publish() {},
      async clear() {},
    },
    settings: {
      async set() {},
    },
    tools: {
      async register(tools: RegisteredTool[]) {
        registeredTools.splice(0, registeredTools.length, ...tools);
      },
    },
    jobs: {
      async begin(label: string) {
        jobEvents.push({ type: 'begin', value: label });
        return { id: 'job-1' };
      },
      async update(_jobId: string, value: unknown) {
        jobEvents.push({ type: 'update', value });
      },
      async complete(_jobId: string, value: unknown) {
        jobEvents.push({ type: 'complete', value });
      },
      async fail(_jobId: string, value: unknown) {
        jobEvents.push({ type: 'fail', value });
      },
    },
    mcp: {
      async connectRobloxStudio() {
        return {
          sessionId: 'studio-session',
          serverName: 'Roblox Studio',
          serverVersion: 'test',
          protocolVersion: '2025-06-18',
        };
      },
      async status() {
        return { connected: true };
      },
      async listTools() {
        return catalog;
      },
      async callTool(_sessionId: string, name: string, input: unknown) {
        calls.push({ name, input });
        if (name === 'screen_capture' && options.failCapture) throw new Error('capture failed');
        if (name === 'start_stop_play' && options.failStop && (input as { mode?: string } | undefined)?.mode === 'stop') throw new Error('stop failed');
        if (name === 'screen_capture') return { content: [{ type: 'image', data: 'fake' }] };
        if (name === 'get_console_output') return { content: [{ type: 'text', text: 'ok' }] };
        return { ok: true };
      },
      async disconnect() {
        return true;
      },
    },
  };

  return { api, registeredTools, calls, jobEvents };
}

test('Roblox Studio Manager derives guarded playtest schemas from the live MCP catalog', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  const playtest = fixture.registeredTools.find((tool) => tool.id === 'run_playtest');
  assert.ok(playtest);
  assert.equal(playtest.risk, 'write');

  const parameters = playtest.parameters as {
    properties: {
      playInput: { properties: { mode: { enum: string[] } }; required: string[] };
      stopInput: { properties: { mode: { enum: string[] } }; required: string[] };
      captureInput: { properties: { format: { enum: string[] } } };
      consoleInput: { properties: { level: { enum: string[] } } };
    };
    required: string[];
    additionalProperties: boolean;
  };

  assert.deepEqual(parameters.required, ['playInput', 'stopInput']);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties.playInput.required, ['mode']);
  assert.deepEqual(parameters.properties.playInput.properties.mode.enum, ['play', 'stop']);
  assert.deepEqual(parameters.properties.stopInput.properties.mode.enum, ['play', 'stop']);
  assert.deepEqual(parameters.properties.captureInput.properties.format.enum, ['png']);
  assert.deepEqual(parameters.properties.consoleInput.properties.level.enum, ['all', 'error']);
});

test('Roblox Studio Manager runs Play capture console Stop in order', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  const result = await plugin.invoke('run_playtest', {
    input: {
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play' } },
    { name: 'screen_capture', input: { format: 'png' } },
    { name: 'get_console_output', input: { level: 'all' } },
    { name: 'start_stop_play', input: { mode: 'stop' } },
  ]);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'complete'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'fail'), false);
  assert.deepEqual(result, {
    play: { ok: true },
    viewport: { content: [{ type: 'image', data: 'fake' }] },
    console: { content: [{ type: 'text', text: 'ok' }] },
  });
});

test('Roblox Studio Manager guarantees Stop when a playtest observation fails', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi({ failCapture: true });
  await plugin.activate(fixture.api);

  await assert.rejects(() => plugin.invoke('run_playtest', {
    input: {
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api), /capture failed/);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play' } },
    { name: 'screen_capture', input: { format: 'png' } },
    { name: 'start_stop_play', input: { mode: 'stop' } },
  ]);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'fail'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'complete'), false);
});


test('Roblox Studio Manager does not complete a playtest when Stop fails', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi({ failStop: true });
  await plugin.activate(fixture.api);

  await assert.rejects(() => plugin.invoke('run_playtest', {
    input: {
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api), /stop failed/);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play' } },
    { name: 'screen_capture', input: { format: 'png' } },
    { name: 'get_console_output', input: { level: 'all' } },
    { name: 'start_stop_play', input: { mode: 'stop' } },
  ]);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'fail'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'complete'), false);
});
