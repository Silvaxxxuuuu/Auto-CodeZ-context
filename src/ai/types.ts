export type ProviderId = 'openai' | 'google' | 'anthropic' | string;

export type IntelligenceLevel = 'low' | 'normal' | 'high' | 'maximum';

export type PermissionLevel = 'read-only' | 'safe' | 'ask' | 'unrestricted';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type Capability =
  | 'text'
  | 'vision'
  | 'image'
  | 'video'
  | 'audio'
  | 'reasoning'
  | 'tools'
  | 'streaming';

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'create_file'
  | 'delete_file'
  | 'rename_file'
  | 'search_files'
  | 'run_command';

export interface AIMessage {
  role: MessageRole;
  content: string;
  createdAt?: number;
  toolCallId?: string;
  toolName?: ToolName;
}

export interface AIModel {
  id: string;
  name: string;
  providerId: ProviderId;
  capabilities: Capability[];
  contextWindow?: number;
  reasoningLevels?: IntelligenceLevel[];
}

export interface AIProviderConfig {
  id: ProviderId;
  displayName: string;
  apiKey: string;
  baseUrl?: string;
  selectedModel?: string;
  enabled: boolean;
}

export interface AIRequest {
  providerId: ProviderId;
  model: string;
  messages: AIMessage[];
  intelligence: IntelligenceLevel;
  projectContext?: string;
  toolsEnabled: boolean;
  tools?: AIToolDefinition[];
}

export interface AIResponse {
  content: string;
  model: string;
  providerId: ProviderId;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  toolCalls?: AIToolCall[];
}

export interface AIStreamEvent {
  type: 'start' | 'delta' | 'activity' | 'tool_call' | 'usage' | 'complete' | 'error';
  text?: string;
  activity?: ActivityEvent;
  toolCall?: AIToolCall;
  usage?: AIResponse['usage'];
  response?: AIResponse;
  error?: string;
}

export interface AIToolCall {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
}

export interface FileDiff {
  path: string;
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  before: string;
  after: string;
  addedLines: number;
  removedLines: number;
  renamedFrom?: string;
}

export interface AIToolResult {
  toolCallId: string;
  ok: boolean;
  output?: string;
  error?: string;
  approvalId?: string;
  pendingApproval?: boolean;
  changes?: FileDiff[];
}

export interface AIToolDefinition {
  name: ToolName;
  description: string;
  requiresWriteAccess: boolean;
  requiresApproval: boolean;
}

export interface ApprovalRequest {
  id: string;
  projectId: string;
  permissionLevel: PermissionLevel;
  toolCall: AIToolCall;
  createdAt: number;
}

export interface AIProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  listModels(config: AIProviderConfig): Promise<AIModel[]>;
  send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse>;
  stream?(config: AIProviderConfig, request: AIRequest): AsyncIterable<AIStreamEvent>;
}

export interface ProviderSummary {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  selectedModel?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  projectId?: string;
  providerId: ProviderId;
  model: string;
  intelligence: IntelligenceLevel;
  permissionLevel: PermissionLevel;
  messages: AIMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileChange {
  path: string;
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  accepted: boolean;
}

export interface ActivityEvent {
  id: string;
  type: 'thought' | 'action' | 'tool' | 'test' | 'build' | 'complete' | 'error';
  message: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  createdAt: number;
}
