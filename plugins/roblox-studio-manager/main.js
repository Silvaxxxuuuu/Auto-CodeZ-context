const PLUGIN_ID = 'autocodez.roblox-studio-manager';
const TOOL_RISK = {
  search_game_tree: 'read',
  inspect_instance: 'read',
  script_read: 'read',
  get_console_output: 'read',
  screen_capture: 'read',
  multi_edit: 'write',
  execute_luau: 'sensitive',
  start_stop_play: 'write',
  user_keyboard_input: 'write',
  user_mouse_input: 'write',
};

let sessionId = null;
let studioTools = new Map();

const normalizeToolId = (name) => 'studio_' + name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

async function connect(api) {
  if (sessionId) return;
  const command = await api.settings.get('mcpCommand');
  const resolved = typeof command === 'string' && command.trim()
    ? command.trim()
    : (await api.mcp.resolveRobloxStudio()).command;
  await api.activity.publish('Conectando ao Roblox Studio...', 'running');
  const connected = await api.mcp.connect({ command: resolved, timeoutMs: 15000 });
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
  await api.settings.set('lastServer', {
    name: connected.serverName || 'Roblox Studio',
    version: connected.serverVersion || null,
    protocolVersion: connected.protocolVersion || null,
    tools: tools.length,
  });
  await api.activity.publish('Roblox Studio conectado.', 'completed');
}

autoCodez.register({
  async activate(api) {
    try {
      await connect(api);
    } catch (error) {
      sessionId = null;
      studioTools.clear();
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
    await api.activity.clear();
  },
});
