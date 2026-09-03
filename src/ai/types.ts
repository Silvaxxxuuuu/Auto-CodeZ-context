export type ProviderId = 'openai' | 'google' | 'anthropic' | string;
export type IntelligenceLevel = 'low' | 'normal' | 'high' | 'maximum';
export type PermissionLevel = 'read-only' | 'safe' | 'ask' | 'unrestricted';
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type Capability = 'text' | 'vision' | 'image' | 'video' | 'audio' | 'reasoning' | 'tools' | 'streaming';
export type ToolName = 'read_file' | 'write_file' | 'create_file' | 'delete_file' | 'rename_file' | 'search_files' | 'run_command' | 'git_status' | 'git_diff' | 'git_log' | 'git_branches' | 'git_create_branch' | 'git_checkout' | 'git_stage' | 'git_stage_all' | 'git_commit';
export interface AIMessage { role: MessageRole; content: string; createdAt?: number; toolCallId?: string; toolName?: ToolName; toolCalls?: AIToolCall[]; changes?: FileDiff[]; diffPlan?: DiffPlan; commandResult?: CommandResultSummary; gitResult?: GitOperationSummary; }
export interface AIModel { id: string; name: string; providerId: ProviderId; capabilities: Capability[]; contextWindow?: number; reasoningLevels?: IntelligenceLevel[]; }
export interface AIProviderConfig { id: ProviderId; displayName: string; apiKey: string; baseUrl?: string; selectedModel?: string; enabled: boolean; }
export interface AIRequest { providerId: ProviderId; model: string; messages: AIMessage[]; intelligence: IntelligenceLevel; projectContext?: string; toolsEnabled: boolean; tools?: AIToolDefinition[]; }
export interface AIResponse { content: string; model: string; providerId: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; toolCalls?: AIToolCall[]; }
export interface AIStreamEvent { type: 'start' | 'delta' | 'activity' | 'tool_call' | 'usage' | 'complete' | 'approval_required' | 'error'; text?: string; activity?: Omit<ActivityEvent, 'id' | 'createdAt'> | ActivityEvent; toolCall?: AIToolCall; usage?: AIResponse['usage']; response?: AIResponse; pendingApprovalIds?: string[]; error?: string; }
export interface AIToolCall { id: string; name: ToolName; input: Record<string, unknown>; providerData?: Record<string, unknown>; }
export interface FileDiff { path: string; type: 'created' | 'modified' | 'deleted' | 'renamed'; before: string; after: string; addedLines: number; removedLines: number; renamedFrom?: string; }
export interface DiffSummary { files: number; created: number; modified: number; deleted: number; renamed: number; addedLines: number; removedLines: number; }
export interface DiffPlan { id: string; createdAt: number; changes: FileDiff[]; summary: DiffSummary; }
export interface CommandResultSummary { command: string; exitCode: number; stdout: string; stderr: string; timedOut: boolean; startedAt: number; finishedAt: number; durationMs: number; }
export interface GitOperationSummary { operation: 'create_branch' | 'checkout' | 'stage' | 'stage_all' | 'commit'; branch: string; output: string; }
export interface AIToolResult { toolCallId: string; ok: boolean; output?: string; error?: string; approvalId?: string; pendingApproval?: boolean; changes?: FileDiff[]; diffPlan?: DiffPlan; commandResult?: CommandResultSummary; gitResult?: GitOperationSummary; }
export interface AIToolDefinition { name: ToolName; description: string; parameters: Record<string, unknown>; requiresWriteAccess: boolean; requiresApproval: boolean; }
export interface ApprovalRequest { id: string; projectId: string; chatId?: string; permissionLevel: PermissionLevel; toolCall: AIToolCall; createdAt: number; diffPlan?: DiffPlan; }
export interface AIProviderAdapter { readonly id: ProviderId; readonly displayName: string; listModels(config: AIProviderConfig): Promise<AIModel[]>; send(config: AIProviderConfig, request: AIRequest): Promise<AIResponse>; stream?(config: AIProviderConfig, request: AIRequest): AsyncIterable<AIStreamEvent>; }
export interface ProviderSummary { id: ProviderId; displayName: string; configured: boolean; apiKeyConfigured: boolean; selectedModel?: string; }
export interface ChatRecord { id: string; title: string; projectId?: string; apiKeyId?: string; providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel; messages: AIMessage[]; createdAt: number; updatedAt: number; }
export interface ProjectRecord { id: string; name: string; rootPath: string; createdAt: number; updatedAt: number; }
export interface FileChange { path: string; type: 'created' | 'modified' | 'deleted' | 'renamed'; accepted: boolean; }
export interface ActivityEvent { id: string; runId?: string; type: 'thought' | 'action' | 'tool' | 'test' | 'build' | 'complete' | 'error'; message: string; status: 'pending' | 'running' | 'success' | 'failed'; createdAt: number; toolCallId?: string; toolName?: ToolName; commandResult?: CommandResultSummary; gitResult?: GitOperationSummary; changes?: FileDiff[]; diffPlan?: DiffPlan; error?: string; }
