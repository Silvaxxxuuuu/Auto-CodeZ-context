import crypto from 'node:crypto';
import type { AIToolDefinition, AIToolResult, PermissionLevel, ToolName } from '../ai/types';

export type PluginToolRisk = 'read' | 'write' | 'sensitive';

export type PluginToolRegistration = {
  id: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: PluginToolRisk;
};

type CatalogEntry = {
  pluginId: string;
  toolId: string;
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  risk: PluginToolRisk;
};

export type PluginToolExecutionContext = {
  chatId: string;
  projectId: string;
  runId?: string;
  permission: PermissionLevel;
};

export type PluginToolExecutor = (
  pluginId: string,
  toolId: string,
  input: Record<string, unknown>,
  context: PluginToolExecutionContext,
) => Promise<unknown>;

const TOOL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_TOOLS_PER_PLUGIN = 32;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;

function validateSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || parameters.type !== 'object') {
    throw new Error('Schema de tool do plugin precisa ser um objeto JSON Schema.');
  }
  const serialized = JSON.stringify(parameters);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) throw new Error('Schema de tool do plugin excede 32 KB.');
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  if (parsed.additionalProperties !== false) throw new Error('Schema de tool do plugin deve usar additionalProperties=false.');
  return parsed;
}

function generatedName(pluginId: string, toolId: string): ToolName {
  const digest = crypto.createHash('sha256').update(pluginId).digest('hex').slice(0, 10);
  return `plugin_${digest}_${toolId}` as ToolName;
}

export class PluginToolCatalog {
  private readonly entries = new Map<ToolName, CatalogEntry>();
  private readonly byPlugin = new Map<string, Set<ToolName>>();
  private executor?: PluginToolExecutor;

  configureExecutor(executor: PluginToolExecutor): void {
    this.executor = executor;
  }

  register(pluginId: string, tools: PluginToolRegistration[]): AIToolDefinition[] {
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS_PER_PLUGIN) throw new Error('Plugin excede o limite de 32 tools.');
    this.clear(pluginId);
    const names = new Set<ToolName>();
    try {
      for (const tool of tools) {
        if (!tool || typeof tool !== 'object' || !TOOL_ID_PATTERN.test(tool.id)) throw new Error('ID de tool do plugin inválido.');
        const description = tool.description?.trim();
        if (!description || description.length > MAX_DESCRIPTION_LENGTH) throw new Error('Descrição de tool do plugin inválida.');
        if (tool.risk !== 'read' && tool.risk !== 'write' && tool.risk !== 'sensitive') throw new Error('Risco de tool do plugin inválido.');
        const name = generatedName(pluginId, tool.id);
        if (this.entries.has(name)) throw new Error('Colisão de tool de plugin detectada.');
        const entry: CatalogEntry = {
          pluginId,
          toolId: tool.id,
          name,
          description,
          parameters: validateSchema(tool.parameters),
          risk: tool.risk,
        };
        this.entries.set(name, entry);
        names.add(name);
      }
      this.byPlugin.set(pluginId, names);
      return this.listDefinitions(pluginId);
    } catch (error) {
      this.clear(pluginId);
      throw error;
    }
  }

  clear(pluginId: string): void {
    const names = this.byPlugin.get(pluginId);
    if (names) for (const name of names) this.entries.delete(name);
    this.byPlugin.delete(pluginId);
  }

  owns(name: ToolName): boolean {
    return this.entries.has(name);
  }

  get(name: ToolName): CatalogEntry | undefined {
    const entry = this.entries.get(name);
    return entry ? { ...entry, parameters: structuredClone(entry.parameters) } : undefined;
  }

  listDefinitions(pluginId?: string): AIToolDefinition[] {
    return [...this.entries.values()]
      .filter((entry) => !pluginId || entry.pluginId === pluginId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        parameters: structuredClone(entry.parameters),
        requiresWriteAccess: entry.risk !== 'read',
        requiresApproval: entry.risk !== 'read',
      }));
  }

  async execute(name: ToolName, input: Record<string, unknown>, context: PluginToolExecutionContext): Promise<AIToolResult> {
    const entry = this.entries.get(name);
    if (!entry) return { toolCallId: '', ok: false, error: `Tool de plugin desconhecida: ${name}` };
    if (!this.executor) return { toolCallId: '', ok: false, error: 'Executor de plugins ainda não está disponível.' };
    const value = await this.executor(entry.pluginId, entry.toolId, structuredClone(input), context);
    const output = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return { toolCallId: '', ok: true, output: output.slice(0, 64 * 1024) };
  }
}

export const pluginToolCatalog = new PluginToolCatalog();
