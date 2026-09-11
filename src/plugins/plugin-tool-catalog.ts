import crypto from 'node:crypto';
import type { AIToolDefinition, AIToolResult, PermissionLevel, ToolName } from '../ai/types';

export type PluginToolRisk = 'read' | 'write' | 'sensitive';

export type PluginToolRegistration = {
  id: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: PluginToolRisk;
};

export type PluginToolDescriptor = {
  pluginId: string;
  toolId: string;
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  risk: PluginToolRisk;
};

type CatalogEntry = PluginToolDescriptor;

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
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_PROPERTIES_PER_OBJECT = 64;
const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateEnum(schema: Record<string, unknown>, path: string): void {
  if (schema.enum === undefined) return;
  if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 128) throw new Error(`Enum inválido em '${path}'.`);
  const seen = new Set<string>();
  for (const item of schema.enum) {
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error(`Enum usa valor não suportado em '${path}'.`);
    const key = JSON.stringify(item);
    if (seen.has(key)) throw new Error(`Enum duplicado em '${path}'.`);
    seen.add(key);
  }
}

function validateSchemaNode(schema: unknown, path: string, depth: number): void {
  if (!isRecord(schema)) throw new Error(`Schema inválido em '${path}'.`);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('Schema de tool do plugin excede a profundidade máxima.');
  if (typeof schema.type !== 'string' || !SUPPORTED_TYPES.has(schema.type)) throw new Error(`Tipo de schema não suportado em '${path}'.`);
  validateEnum(schema, path);

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) throw new Error(`Objeto em '${path}' deve usar additionalProperties=false.`);
    if (!isRecord(schema.properties)) throw new Error(`Objeto em '${path}' precisa declarar properties.`);
    const properties = Object.entries(schema.properties);
    if (properties.length > MAX_PROPERTIES_PER_OBJECT) throw new Error(`Objeto em '${path}' possui propriedades demais.`);
    const required = schema.required === undefined ? [] : schema.required;
    if (!Array.isArray(required) || !required.every((item) => typeof item === 'string')) throw new Error(`required inválido em '${path}'.`);
    const requiredSet = new Set(required as string[]);
    if (requiredSet.size !== required.length) throw new Error(`required contém duplicatas em '${path}'.`);
    for (const key of requiredSet) if (!(key in schema.properties)) throw new Error(`required referencia '${key}' sem property em '${path}'.`);
    for (const [key, child] of properties) {
      if (!key || key.length > 128) throw new Error(`Nome de propriedade inválido em '${path}'.`);
      validateSchemaNode(child, `${path}.${key}`, depth + 1);
    }
    return;
  }

  if (schema.type === 'array') {
    validateSchemaNode(schema.items, `${path}[]`, depth + 1);
    if (schema.maxItems !== undefined && (typeof schema.maxItems !== 'number' || !Number.isInteger(schema.maxItems) || schema.maxItems < 0 || schema.maxItems > 1024)) {
      throw new Error(`maxItems inválido em '${path}'.`);
    }
    return;
  }

  if (schema.maxLength !== undefined && (schema.type !== 'string' || typeof schema.maxLength !== 'number' || !Number.isInteger(schema.maxLength) || schema.maxLength < 0 || schema.maxLength > 131072)) {
    throw new Error(`maxLength inválido em '${path}'.`);
  }
}

function validateSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(parameters);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) throw new Error('Schema de tool do plugin excede 32 KB.');
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  if (parsed.type !== 'object') throw new Error('Schema de tool do plugin precisa ser um objeto JSON Schema.');
  validateSchemaNode(parsed, '$', 0);
  return parsed;
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return false;
}

function validateInputNode(schema: Record<string, unknown>, value: unknown, path: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('Entrada da tool excede a profundidade permitida.');
  const type = schema.type as string;
  if (!typeMatches(type, value)) throw new Error(`Valor inválido para '${path}': esperado ${type}.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) throw new Error(`Valor de '${path}' não pertence ao enum permitido.`);

  if (type === 'object') {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(objectValue, key)) throw new Error(`Parâmetro obrigatório ausente: '${path}.${key}'.`);
    for (const [key, item] of Object.entries(objectValue)) {
      const child = properties[key];
      if (!child) throw new Error(`Parâmetro não permitido: '${path}.${key}'.`);
      validateInputNode(child, item, `${path}.${key}`, depth + 1);
    }
    return;
  }

  if (type === 'array') {
    const items = value as unknown[];
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : 1024;
    if (items.length > maxItems) throw new Error(`Lista '${path}' excede o limite de ${maxItems} item(ns).`);
    const child = schema.items as Record<string, unknown>;
    items.forEach((item, index) => validateInputNode(child, item, `${path}[${index}]`, depth + 1));
    return;
  }

  if (type === 'string' && typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) {
    throw new Error(`Texto '${path}' excede o limite de ${schema.maxLength} caractere(s).`);
  }
}

function validateInput(schema: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(input)) throw new Error('Entrada da tool do plugin inválida.');
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw new Error('Entrada da tool do plugin excede 128 KB.');
  const cloned = JSON.parse(serialized) as Record<string, unknown>;
  validateInputNode(schema, cloned, '$', 0);
  return cloned;
}

function generatedName(pluginId: string, toolId: string): ToolName {
  const digest = crypto.createHash('sha256').update(pluginId).digest('hex').slice(0, 10);
  return `plugin_${digest}_${toolId}` as ToolName;
}

function cloneEntry(entry: CatalogEntry): PluginToolDescriptor {
  return { ...entry, parameters: structuredClone(entry.parameters) };
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

  get(name: ToolName): PluginToolDescriptor | undefined {
    const entry = this.entries.get(name);
    return entry ? cloneEntry(entry) : undefined;
  }

  list(pluginId?: string): PluginToolDescriptor[] {
    return [...this.entries.values()]
      .filter((entry) => !pluginId || entry.pluginId === pluginId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cloneEntry);
  }

  listDefinitions(pluginId?: string): AIToolDefinition[] {
    return this.list(pluginId).map((entry) => ({
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
    try {
      const validatedInput = validateInput(entry.parameters, input);
      const value = await this.executor(entry.pluginId, entry.toolId, validatedInput, context);
      const output = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return { toolCallId: '', ok: true, output: output.slice(0, 64 * 1024) };
    } catch (error) {
      return { toolCallId: '', ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) };
    }
  }
}

export const pluginToolCatalog = new PluginToolCatalog();
