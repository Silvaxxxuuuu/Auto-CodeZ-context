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

const toStrictSchema = (schema) => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return { type: 'object', properties: {}, required: [], additionalProperties: false };
  return sanitizeSchemaNode(schema);
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
  const usedToolIds = new Set();
  const tools = catalog.tools.map((tool) => {
    const id = normalizeToolId(tool.name, usedToolIds);
    studioTools.set(id, tool);
    return {
      id,
      title: tool.name,
      description: tool.description || ('Executa ' + tool.name + ' no Roblox Studio conectado.'),
      risk: TOOL_RISK[tool.name] || 'sensitive',
      parameters: toStrictSchema(tool.inputSchema),
    };
  });
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
    const tool = studioTools.get(method);
    if (!tool) throw new Error('A operação solicitada não está disponível no Roblox Studio conectado.');
    const input = payload && typeof payload === 'object' && payload.input && typeof payload.input === 'object'
      ? payload.input
      : (payload && typeof payload === 'object' ? payload : {});
    return api.mcp.callTool(sessionId, tool.name, input, 60000);
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
