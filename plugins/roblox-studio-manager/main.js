const PLUGIN_ID = 'autocodez.roblox-studio-manager';
const TOOL_RISK = {
  search_game_tree: 'read',
  inspect_instance: 'read',
  script_read: 'read',
  get_console_output: 'read',
  screen_capture: 'read',
  get_studio_state: 'read',
  list_roblox_studios: 'read',
  script_search: 'read',
  script_grep: 'read',
  multi_edit: 'write',
  execute_luau: 'sensitive',
  start_stop_play: 'write',
  user_keyboard_input: 'write',
  user_mouse_input: 'write',
  character_navigation: 'write',
};

let sessionId = null;
let studioTools = new Map();
let studioState = { connected: false, server: null, tools: 0, instanceCount: 0 };

const hash = (value) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36).padStart(7, '0').slice(0, 7);
};

const normalizeToolId = (name, used) => {
  const normalized = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z]+/, '').replace(/_+/g, '_') || 'tool';
  let id = ('studio_' + normalized).slice(0, 48);
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  const suffix = '_' + hash(name);
  id = ('studio_' + normalized).slice(0, 48 - suffix.length) + suffix;
  let salt = 1;
  while (used.has(id)) {
    const nextSuffix = '_' + hash(name + ':' + salt);
    id = ('studio_' + normalized).slice(0, 48 - nextSuffix.length) + nextSuffix;
    salt += 1;
  }
  used.add(id);
  return id;
};

const sanitizeSchemaNode = (schema, depth = 0) => {
  if (depth > 8 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };
  const supported = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
  const type = typeof schema.type === 'string' && supported.has(schema.type) ? schema.type : 'string';
  const result = { type };
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 128) {
    const values = schema.enum.filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    if (values.length === schema.enum.length && new Set(values.map((item) => JSON.stringify(item))).size === values.length) result.enum = values;
  }
  if (type === 'object') {
    const source = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    const entries = Object.entries(source).filter(([key]) => key && key.length <= 128).slice(0, 64);
    result.properties = Object.fromEntries(entries.map(([key, child]) => [key, sanitizeSchemaNode(child, depth + 1)]));
    const keys = new Set(Object.keys(result.properties));
    result.required = Array.isArray(schema.required) ? [...new Set(schema.required.filter((key) => typeof key === 'string' && keys.has(key)))] : [];
    result.additionalProperties = false;
  } else if (type === 'array') {
    result.items = sanitizeSchemaNode(schema.items, depth + 1);
  }
  return result;
};

const MAX_AGENT_TOOLS = 32;
const MAX_PLAYTEST_INTERACTIONS = 24;
const HIGH_LEVEL_OPERATIONS = {
  inspect_game: 'search_game_tree',
  inspect_instance: 'inspect_instance',
  read_script: 'script_read',
  edit_scripts: 'multi_edit',
  execute_luau: 'execute_luau',
  studio_state: 'get_studio_state',
  list_studios: 'list_roblox_studios',
  search_scripts: 'script_search',
  grep_scripts: 'script_grep',
  read_console: 'get_console_output',
  capture_viewport: 'screen_capture',
  play: 'start_stop_play',
  keyboard: 'user_keyboard_input',
  mouse: 'user_mouse_input',
  navigate_character: 'character_navigation',
};

const PLAYTEST_TOOL_ID = 'run_playtest';

const toStrictSchema = (schema) => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return { type: 'object', properties: {}, required: [], additionalProperties: false };
  return sanitizeSchemaNode(schema);
};

const buildPlaytestInteractionSchema = (catalog) => {
  const definitions = [
    ['keyboard', 'user_keyboard_input', 'keyboardInput'],
    ['mouse', 'user_mouse_input', 'mouseInput'],
    ['navigate', 'character_navigation', 'navigationInput'],
  ].filter(([, toolName]) => catalog.tools.some((tool) => tool.name === toolName));
  if (definitions.length === 0) return null;
  const properties = {
    operation: { type: 'string', enum: definitions.map(([operation]) => operation) },
  };
  for (const [, toolName, inputKey] of definitions) {
    const tool = catalog.tools.find((candidate) => candidate.name === toolName);
    properties[inputKey] = toStrictSchema(tool.inputSchema);
  }
  return {
    type: 'array',
    items: {
      type: 'object',
      properties,
      required: ['operation'],
      additionalProperties: false,
    },
  };
};

async function connect(api) {
  if (sessionId) {
    const status = await api.mcp.status(sessionId);
    if (status && status.connected) return;
    sessionId = null;
    studioTools.clear();
    studioState = { connected: false, server: null, tools: 0, instanceCount: 0 };
    await api.settings.set('studioStatus', studioState);
  }
  await api.activity.publish('Conectando ao Roblox Studio...', 'running');
  const connected = await api.mcp.connectRobloxStudio(15000);
  sessionId = connected.sessionId;
  const catalog = await api.mcp.listTools(sessionId, 15000);
  const requiredPlaytestTools = ['start_stop_play', 'screen_capture', 'get_console_output'];
  const canRunPlaytest = requiredPlaytestTools.every((name) => catalog.tools.some((tool) => tool.name === name));
  if (catalog.tools.length + (canRunPlaytest ? 1 : 0) > MAX_AGENT_TOOLS) throw new Error('O Roblox Studio expôs operações demais para o catálogo seguro do Auto CodeZ.');
  const usedToolIds = new Set();
  const preferredIds = new Map(Object.entries(HIGH_LEVEL_OPERATIONS).map(([id, name]) => [name, id]));
  const tools = catalog.tools.map((tool) => {
    const preferred = preferredIds.get(tool.name);
    const id = preferred && !usedToolIds.has(preferred) ? preferred : normalizeToolId(tool.name, usedToolIds);
    if (preferred) usedToolIds.add(id);
    studioTools.set(id, tool);
    return {
      id,
      title: tool.name,
      description: tool.description || ('Executa ' + tool.name + ' no Roblox Studio conectado.'),
      risk: TOOL_RISK[tool.name] || 'sensitive',
      parameters: toStrictSchema(tool.inputSchema),
    };
  });
  if (canRunPlaytest) {
    const playTool = catalog.tools.find((tool) => tool.name === 'start_stop_play');
    const captureTool = catalog.tools.find((tool) => tool.name === 'screen_capture');
    const consoleTool = catalog.tools.find((tool) => tool.name === 'get_console_output');
    const playSchema = toStrictSchema(playTool.inputSchema);
    const interactionSchema = buildPlaytestInteractionSchema(catalog);
    const playtestProperties = {
      playInput: playSchema,
      captureInput: toStrictSchema(captureTool.inputSchema),
      consoleInput: toStrictSchema(consoleTool.inputSchema),
      stopInput: playSchema,
    };
    if (interactionSchema) playtestProperties.interactions = interactionSchema;
    tools.push({
      id: PLAYTEST_TOOL_ID,
      title: 'Run Playtest',
      description: 'Executa um ciclo de playtest no Roblox Studio, captura a viewport, lê o console e garante Stop ao finalizar.',
      risk: 'write',
      parameters: {
        type: 'object',
        properties: playtestProperties,
        required: ['playInput', 'stopInput'],
        additionalProperties: false,
      },
    });
  }
  await api.tools.register(tools);
  studioState = {
    connected: true,
    server: { name: connected.serverName || 'Roblox Studio', version: connected.serverVersion || null, protocolVersion: connected.protocolVersion || null },
    tools: tools.length,
    instanceCount: 0,
  };
  const listStudios = catalog.tools.find((tool) => tool.name === 'list_roblox_studios');
  if (listStudios) {
    try {
      const listed = await api.mcp.callTool(sessionId, listStudios.name, {}, 15000);
      const content = listed && typeof listed === 'object' && Array.isArray(listed.content) ? listed.content : [];
      const text = content.filter((item) => item && item.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
      const parsed = text ? JSON.parse(text) : null;
      const instances = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.studios) ? parsed.studios : []);
      studioState.instanceCount = Math.min(instances.length, 100);
    } catch {}
  }
  await api.settings.set('lastServer', studioState.server);
  await api.settings.set('studioStatus', studioState);
  await api.activity.publish('Roblox Studio conectado.', 'completed');
}

autoCodez.register({
  async activate(api) {
    try {
      await connect(api);
    } catch (error) {
      sessionId = null;
      studioTools.clear();
      studioState = { connected: false, server: null, tools: 0, instanceCount: 0 };
      await api.settings.set('studioStatus', studioState);
      await api.activity.publish('Abra o Roblox Studio para conectar.', 'waiting');
    }
  },

  async invoke(method, payload, api) {
    await connect(api);
    const rawInput = payload && typeof payload === 'object' && payload.input && typeof payload.input === 'object'
      ? payload.input
      : (payload && typeof payload === 'object' ? payload : {});
    if (method === PLAYTEST_TOOL_ID) {
      const playTool = [...studioTools.values()].find((tool) => tool.name === 'start_stop_play');
      const captureTool = [...studioTools.values()].find((tool) => tool.name === 'screen_capture');
      const consoleTool = [...studioTools.values()].find((tool) => tool.name === 'get_console_output');
      if (!playTool || !captureTool || !consoleTool) throw new Error('O Roblox Studio conectado não oferece todas as operações necessárias para playtest.');
      const job = await api.jobs.begin('Playtest do Roblox Studio');
      let started = false;
      let stopAttempted = false;
      try {
        await api.jobs.update(job.id, { progress: 0.1, activity: 'Iniciando Play...' });
        const play = await api.mcp.callTool(sessionId, playTool.name, rawInput.playInput || {}, 60000);
        started = true;
        const interactions = Array.isArray(rawInput.interactions) ? rawInput.interactions : [];
        if (interactions.length > MAX_PLAYTEST_INTERACTIONS) throw new Error('O playtest excedeu o limite de 24 interações.');
        const interactionTools = {
          keyboard: { tool: [...studioTools.values()].find((tool) => tool.name === 'user_keyboard_input'), key: 'keyboardInput' },
          mouse: { tool: [...studioTools.values()].find((tool) => tool.name === 'user_mouse_input'), key: 'mouseInput' },
          navigate: { tool: [...studioTools.values()].find((tool) => tool.name === 'character_navigation'), key: 'navigationInput' },
        };
        for (let index = 0; index < interactions.length; index += 1) {
          const step = interactions[index];
          if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Interação de playtest inválida.');
          const definition = interactionTools[step.operation];
          if (!definition || !definition.tool) throw new Error('Interação de playtest não disponível no Roblox Studio conectado.');
          const input = step[definition.key];
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Payload da interação de playtest inválido.');
          const unexpected = Object.keys(step).filter((key) => key !== 'operation' && key !== definition.key);
          if (unexpected.length > 0) throw new Error('Interação de playtest contém payload incompatível com a operação selecionada.');
          const progress = 0.2 + ((index + 1) / Math.max(interactions.length, 1)) * 0.35;
          await api.jobs.update(job.id, { progress, activity: 'Executando interação ' + (index + 1) + ' de ' + interactions.length + '...' });
          await api.mcp.callTool(sessionId, definition.tool.name, input, 60000);
        }
        await api.jobs.update(job.id, { progress: 0.65, activity: 'Capturando viewport...' });
        const viewport = await api.mcp.callTool(sessionId, captureTool.name, rawInput.captureInput || {}, 60000);
        await api.jobs.update(job.id, { progress: 0.8, activity: 'Lendo console...' });
        const consoleOutput = await api.mcp.callTool(sessionId, consoleTool.name, rawInput.consoleInput || {}, 60000);
        await api.jobs.update(job.id, { progress: 0.92, activity: 'Encerrando Play...' });
        stopAttempted = true;
        await api.mcp.callTool(sessionId, playTool.name, rawInput.stopInput || {}, 30000);
        await api.jobs.complete(job.id, 'Playtest concluído.');
        return { play, viewport, console: consoleOutput };
      } catch (error) {
        let failure = error instanceof Error ? error.message : String(error);
        if (started && !stopAttempted) {
          stopAttempted = true;
          try {
            await api.mcp.callTool(sessionId, playTool.name, rawInput.stopInput || {}, 30000);
          } catch (stopError) {
            failure += '; também não foi possível encerrar Play: ' + (stopError instanceof Error ? stopError.message : String(stopError));
          }
        }
        await api.jobs.fail(job.id, failure);
        throw new Error(failure);
      }
    }
    const tool = studioTools.get(method);
    if (!tool) throw new Error('A operação solicitada não está disponível no Roblox Studio conectado.');
    return api.mcp.callTool(sessionId, tool.name, rawInput, 60000);
  },

  async deactivate(api) {
    if (sessionId) await api.mcp.disconnect(sessionId);
    sessionId = null;
    studioTools.clear();
    studioState = { connected: false, server: null, tools: 0, instanceCount: 0 };
    await api.settings.set('studioStatus', studioState);
    await api.activity.clear();
  },
});
