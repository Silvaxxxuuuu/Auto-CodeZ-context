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

const normalizeToolId = (name) => 'studio_' + name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

async function connect(api) {
  if (sessionId) return;
  await api.activity.publish('Conectando ao Roblox Studio...', 'running');
  const connected = await api.mcp.connectRobloxStudio(15000);
  sessionId = connected.sessionId;
  const catalog = await api.mcp.listTools(sessionId, 15000);
  studioTools = new Map(catalog.tools.map((tool) => [normalizeToolId(tool.name), tool]));
  const tools = catalog.tools.map((tool) => ({
    id: normalizeToolId(tool.name),
    title: tool.name,
    description: tool.description || ('Executa ' + tool.name + ' no Roblox Studio conectado.'),
    risk: TOOL_RISK[tool.name] || 'sensitive',
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', additionalProperties: true },
  }));
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
    if (!sessionId) await connect(api);
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
    studioState = { connected: false, server: null, tools: 0, instances: [] };
    await api.settings.set('studioStatus', studioState);
    await api.activity.clear();
  },
});
