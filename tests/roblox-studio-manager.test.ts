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

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
            studio_id: { type: 'string' },
          },
          required: ['mode', 'studio_id'],
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
            studio_id: { type: 'string' },
          },
          required: ['studio_id'],
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
            studio_id: { type: 'string' },
          },
          required: ['studio_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'user_keyboard_input',
        description: 'Send keyboard input.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' }, studio_id: { type: 'string' } },
          required: ['key', 'studio_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'user_mouse_input',
        description: 'Send mouse input.',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, studio_id: { type: 'string' } },
          required: ['x', 'y', 'studio_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'character_navigation',
        description: 'Navigate the character.',
        inputSchema: {
          type: 'object',
          properties: { direction: { type: 'string' }, studio_id: { type: 'string' } },
          required: ['direction', 'studio_id'],
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
      async attachArtifact(jobId: string, artifactId: string) {
        jobEvents.push({ type: 'artifact', value: { jobId, artifactId } });
        return { id: jobId, artifactIds: [artifactId] };
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
        if (name === 'start_stop_play' && options.failStop && (input as { mode?: string } | undefined)?.mode === 'stop') throw new Error('stop failed');
        return { ok: true };
      },
      async callToolObserved(_sessionId: string, name: string, input: unknown) {
        calls.push({ name, input });
        if (name === 'screen_capture' && options.failCapture) throw new Error('capture failed');
        if (name === 'screen_capture') return { content: [{ type: 'artifact', artifact: { id: 'image-1', pluginId: 'autocodez.roblox-studio-manager', kind: 'image', mimeType: 'image/png', bytes: 128, createdAt: 1 } }] };
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

  const parameters = plain(playtest.parameters) as {
    properties: {
      playInput: { properties: { mode: { enum: string[] } }; required: string[] };
      stopInput: { properties: { mode: { enum: string[] } }; required: string[] };
      captureInput: { properties: { format: { enum: string[] } } };
      consoleInput: { properties: { level: { enum: string[] } } };
      interactions: {
        items: {
          properties: {
            operation: { enum: string[] };
            keyboardInput: { required: string[] };
            mouseInput: { required: string[] };
            navigationInput: { required: string[] };
            captureInput: { properties: { format: { enum: string[] } } };
            consoleInput: { properties: { level: { enum: string[] } } };
          };
        };
      };
    };
    required: string[];
    additionalProperties: boolean;
  };

  assert.deepEqual(parameters.required, ['studioId', 'playInput', 'stopInput']);
  assert.equal((parameters.properties as Record<string, unknown>).studioId !== undefined, true);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties.playInput.required, ['mode']);
  assert.deepEqual(parameters.properties.playInput.properties.mode.enum, ['play', 'stop']);
  assert.deepEqual(parameters.properties.stopInput.properties.mode.enum, ['play', 'stop']);
  assert.deepEqual(parameters.properties.captureInput.properties.format.enum, ['png']);
  assert.deepEqual(parameters.properties.consoleInput.properties.level.enum, ['all', 'error']);
  assert.deepEqual(parameters.properties.interactions.items.properties.operation.enum, ['keyboard', 'mouse', 'navigate', 'capture', 'console']);
  assert.deepEqual(parameters.properties.interactions.items.properties.keyboardInput.required, ['key']);
  assert.deepEqual(parameters.properties.interactions.items.properties.mouseInput.required, ['x', 'y']);
  assert.deepEqual(parameters.properties.interactions.items.properties.navigationInput.required, ['direction']);
  assert.deepEqual(parameters.properties.interactions.items.properties.captureInput.properties.format.enum, ['png']);
  assert.deepEqual(parameters.properties.interactions.items.properties.consoleInput.properties.level.enum, ['all', 'error']);
});

test('Roblox Studio Manager runs Play capture console Stop in order', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  const result = plain(await plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api));

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'get_console_output', input: { level: 'all', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'artifact' && (event.value as { artifactId?: string }).artifactId === 'image-1'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'complete'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'fail'), false);
  assert.deepEqual(result, {
    playStarted: true,
    checkpoints: [],
    viewport: {
      operation: 'capture',
      artifacts: [{ id: 'image-1', pluginId: 'autocodez.roblox-studio-manager', kind: 'image', mimeType: 'image/png', bytes: 128, createdAt: 1 }],
    },
    console: {
      operation: 'console',
      artifacts: [],
      text: 'ok',
    },
  });
});

test('Roblox Studio Manager guarantees Stop when a playtest observation fails', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi({ failCapture: true });
  await plugin.activate(fixture.api);

  await assert.rejects(() => plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api), /capture failed/);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
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
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api), /stop failed/);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'get_console_output', input: { level: 'all', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'fail'), true);
  assert.equal(fixture.jobEvents.some((event) => event.type === 'complete'), false);
});


test('Roblox Studio Manager executes bounded playtest interactions in declared order', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  await plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      interactions: [
        { operation: 'keyboard', keyboardInput: { key: 'W' } },
        { operation: 'mouse', mouseInput: { x: 320, y: 180 } },
        { operation: 'navigate', navigationInput: { direction: 'forward' } },
      ],
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api);

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'user_keyboard_input', input: { key: 'W', studio_id: 'studio-a' } },
    { name: 'user_mouse_input', input: { x: 320, y: 180, studio_id: 'studio-a' } },
    { name: 'character_navigation', input: { direction: 'forward', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'get_console_output', input: { level: 'all', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);
});

test('Roblox Studio Manager rejects mismatched and oversized playtest interactions and still stops Play', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  await assert.rejects(() => plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      interactions: [{ operation: 'keyboard', mouseInput: { x: 1, y: 2 } }],
      captureInput: {},
      consoleInput: {},
      stopInput: { mode: 'stop' },
    },
  }, fixture.api), /Payload da interação de playtest inválido/);
  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);

  const overflow = createApi();
  const secondPlugin = await loadPlugin();
  await secondPlugin.activate(overflow.api);
  await assert.rejects(() => secondPlugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      interactions: Array.from({ length: 25 }, () => ({ operation: 'keyboard', keyboardInput: { key: 'W' } })),
      captureInput: {},
      consoleInput: {},
      stopInput: { mode: 'stop' },
    },
  }, overflow.api), /limite de 24 interações/);
  assert.deepEqual(overflow.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);
});


test('Roblox Studio Manager returns visual and console checkpoints in timeline order', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  await plugin.activate(fixture.api);

  const result = plain(await plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      interactions: [
        { operation: 'keyboard', keyboardInput: { key: 'W' } },
        { operation: 'capture', captureInput: { format: 'png' } },
        { operation: 'mouse', mouseInput: { x: 100, y: 200 } },
        { operation: 'console', consoleInput: { level: 'error' } },
      ],
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api)) as {
    checkpoints: Array<{ index: number; operation: string; artifacts: unknown[]; text?: string }>;
  };

  assert.deepEqual(fixture.calls, [
    { name: 'start_stop_play', input: { mode: 'play', studio_id: 'studio-a' } },
    { name: 'user_keyboard_input', input: { key: 'W', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'user_mouse_input', input: { x: 100, y: 200, studio_id: 'studio-a' } },
    { name: 'get_console_output', input: { level: 'error', studio_id: 'studio-a' } },
    { name: 'screen_capture', input: { format: 'png', studio_id: 'studio-a' } },
    { name: 'get_console_output', input: { level: 'all', studio_id: 'studio-a' } },
    { name: 'start_stop_play', input: { mode: 'stop', studio_id: 'studio-a' } },
  ]);
  assert.equal(fixture.jobEvents.filter((event) => event.type === 'artifact').length, 2);
  assert.deepEqual(result.checkpoints, [
    {
      index: 1,
      operation: 'capture',
      artifacts: [{ id: 'image-1', pluginId: 'autocodez.roblox-studio-manager', kind: 'image', mimeType: 'image/png', bytes: 128, createdAt: 1 }],
    },
    {
      index: 3,
      operation: 'console',
      artifacts: [],
      text: 'ok',
    },
  ]);
});


test('Roblox Studio Manager keeps maximum checkpoint output below the agent tool result budget', async () => {
  const plugin = await loadPlugin();
  const fixture = createApi();
  const originalObserved = fixture.api.mcp.callToolObserved;
  fixture.api.mcp.callToolObserved = async (sessionId: string, name: string, input: unknown) => {
    if (name === 'get_console_output') {
      fixture.calls.push({ name, input });
      return { content: [{ type: 'text', text: 'x'.repeat(16000) }] };
    }
    return originalObserved(sessionId, name, input);
  };
  await plugin.activate(fixture.api);

  const result = plain(await plugin.invoke('run_playtest', {
    input: {
      studioId: 'studio-a',
      playInput: { mode: 'play' },
      interactions: Array.from({ length: 24 }, () => ({ operation: 'console', consoleInput: { level: 'all' } })),
      captureInput: { format: 'png' },
      consoleInput: { level: 'all' },
      stopInput: { mode: 'stop' },
    },
  }, fixture.api));

  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024);
});
