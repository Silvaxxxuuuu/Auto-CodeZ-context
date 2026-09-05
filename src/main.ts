import { app, dialog, ipcMain, Menu, shell, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStorage } from './core/storage';
import { ProviderManager } from './ai/provider-manager';
import { ChatManager } from './ai/chat-manager';
import { ProjectManager } from './project/project-manager';
import { ToolRuntime } from './agent/tool-runtime';
import { AgentRuntime } from './agent/agent-runtime';
import { ChatRuntime } from './ai/chat-runtime';
import { ProviderRequestJournal } from './ai/provider-request-journal';
import { runWithAbortSignal } from './ai/request-cancellation';
import { TerminalService, type TerminalEvent } from './agent/terminal-service';
import { GitRuntime } from './agent/git-runtime';
import { GitService } from './agent/git-service';
import { WorkspaceRuntime } from './agent/workspace-runtime';
import { PermissionRuntime } from './agent/permission-runtime';
import { ActivityRuntime } from './agent/activity-runtime';
import { ApprovalRuntime } from './agent/approval-runtime';
import { CommandRuntime } from './agent/command-runtime';
import { DiffRuntime } from './agent/diff-runtime';
import { ComputerContextRuntime } from './agent/computer-context';
import { ExecutionManager, type ExecutionChange } from './execution-manager';
import { ExecutionStatePersistence, ExecutionStateStore } from './execution-state-store';
import { ExecutionTimeline } from './execution-timeline';
import { ExecutionTimelinePersistence, ExecutionTimelineStore } from './execution-timeline-store';
import { ExecutionCoordinator } from './execution-coordinator';
import { ExecutionPlanner, type ExecutionPlanChange } from './execution-planner';
import { ExecutionPlanPersistence, ExecutionPlanStore } from './execution-plan-store';
import { ExecutionPlanHistory } from './execution-plan-history';
import { ExecutionPlanHistoryPersistence, ExecutionPlanHistoryStore } from './execution-plan-history-store';
import { ExecutionReportBuilder } from './execution-report';
import { ExecutionQualityGateRuntime, type ExecutionQualityGateRequirement } from './execution-quality-gate';
import { ExecutionQualityGatePersistence, ExecutionQualityGateStore } from './execution-quality-gate-store';
import { ExecutionTaskCapsuleRuntime } from './execution-task-capsule';
import { ExecutionTaskCapsulePersistence, ExecutionTaskCapsuleStore } from './execution-task-capsule-store';
import { ExecutionCheckpointRuntime } from './execution-checkpoint';
import { ExecutionCheckpointPersistence, ExecutionCheckpointStore } from './execution-checkpoint-store';
import { ExecutionCheckpointController } from './execution-checkpoint-controller';
import { ExecutionChangeBudgetRuntime } from './execution-change-budget';
import { listRecoverableRuns, resumeRecoveredRun } from './agent/recovery-controller';
import { requireIdentifier, requireNonEmptyString, requireObject } from './core/input-validation';
import type { AIProviderConfig, AIStreamEvent } from './ai/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storage = new LocalStorage();
const providerManager = new ProviderManager(storage);
const chatManager = new ChatManager(storage);
const projectManager = new ProjectManager(storage);
const workspaceRuntime = new WorkspaceRuntime(() => projectManager.list());
const permissionRuntime = new PermissionRuntime();
const activityRuntime = new ActivityRuntime();
const approvalRuntime = new ApprovalRuntime();
const commandRuntime = new CommandRuntime(() => projectManager.list());
const diffRuntime = new DiffRuntime();
const gitRuntime = new GitRuntime(() => projectManager.list());
const gitService = new GitService(gitRuntime);
const terminalService = new TerminalService(storage, () => projectManager.list());
const computerContextRuntime = new ComputerContextRuntime();
const toolRuntime = new ToolRuntime(workspaceRuntime, permissionRuntime, activityRuntime, approvalRuntime, commandRuntime, diffRuntime, storage);
toolRuntime.configureGitRuntime(gitRuntime);
const providerRequestJournal = new ProviderRequestJournal(storage);
const chatRuntime = new ChatRuntime(providerManager.registry, undefined, undefined, activityRuntime, undefined, toolRuntime.listDefinitions(), providerRequestJournal);
const agentRuntime = new AgentRuntime(chatRuntime, toolRuntime, activityRuntime, storage);
const executionManager = new ExecutionManager();
const executionStateStore = new ExecutionStateStore(storage);
const executionStatePersistence = new ExecutionStatePersistence(executionStateStore);
const executionTimeline = new ExecutionTimeline();
const executionTimelineStore = new ExecutionTimelineStore(storage);
const executionTimelinePersistence = new ExecutionTimelinePersistence(executionTimelineStore);
const executionPlanner = new ExecutionPlanner();
const executionCoordinator = new ExecutionCoordinator(executionManager, executionPlanner);
const executionChangeBudgetRuntime = new ExecutionChangeBudgetRuntime();
toolRuntime.configureExecutionPlanner(executionPlanner);
toolRuntime.configureExecutionChangeBudget(executionChangeBudgetRuntime);
const executionPlanStore = new ExecutionPlanStore(storage);
const executionPlanPersistence = new ExecutionPlanPersistence(executionPlanStore);
const executionPlanHistory = new ExecutionPlanHistory();
const executionPlanHistoryStore = new ExecutionPlanHistoryStore(storage);
const executionPlanHistoryPersistence = new ExecutionPlanHistoryPersistence(executionPlanHistoryStore);
const executionReportBuilder = new ExecutionReportBuilder(executionManager, executionTimeline, executionPlanHistory);
const executionQualityGateRuntime = new ExecutionQualityGateRuntime();
const executionQualityGateStore = new ExecutionQualityGateStore(storage);
const executionQualityGatePersistence = new ExecutionQualityGatePersistence(executionQualityGateStore);
const executionTaskCapsuleRuntime = new ExecutionTaskCapsuleRuntime();
const executionTaskCapsuleStore = new ExecutionTaskCapsuleStore(storage);
const executionTaskCapsulePersistence = new ExecutionTaskCapsulePersistence(executionTaskCapsuleStore);
const executionCheckpointRuntime = new ExecutionCheckpointRuntime();
const executionCheckpointStore = new ExecutionCheckpointStore(storage);
const executionCheckpointPersistence = new ExecutionCheckpointPersistence(executionCheckpointStore);
let executionPersistenceEnabled = false;
let executionTimelinePersistenceEnabled = false;
let executionPlanPersistenceEnabled = false;
let executionPlanHistoryPersistenceEnabled = false;
let executionQualityGatePersistenceEnabled = false;
let executionTaskCapsulePersistenceEnabled = false;
let executionCheckpointPersistenceEnabled = false;
const executionCheckpointController = new ExecutionCheckpointController(
  executionCheckpointRuntime,
  workspaceRuntime,
  executionManager,
  (checkpoints) => {
    if (executionCheckpointPersistenceEnabled) executionCheckpointPersistence.schedule(checkpoints);
  },
);
toolRuntime.configureExecutionCheckpointRecorder((record) => {
  executionCheckpointRuntime.record(record);
  if (executionCheckpointPersistenceEnabled) executionCheckpointPersistence.schedule(executionCheckpointRuntime.list());
});
const activeStreamControllers = new Map<string, { runId: string; controller: AbortController }>();
const approvalRunLocks = new Set<string>();
let mainWindow: BrowserWindow | null = null;

function sendTerminalEvent(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:event', event);
}

function sendActivity(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:activity', event);
}

function sendStreamEvent(event: AIStreamEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:stream-event', event);
}

function sendExecutionChange(change: ExecutionChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('execution:event', change);
}

function sendExecutionPlanChange(change: ExecutionPlanChange): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('execution-plan:event', change);
}

executionPlanner.subscribe((change) => {
  sendExecutionPlanChange(change);
  const historyChanged = executionPlanHistory.record(change);
  if (executionPlanPersistenceEnabled) executionPlanPersistence.schedule(executionPlanner.list());
  if (executionPlanHistoryPersistenceEnabled && historyChanged) executionPlanHistoryPersistence.schedule(executionPlanHistory.list());
});

executionManager.subscribe((change) => {
  sendExecutionChange(change);
  const timelineEvents = executionTimeline.record(change);
  if (executionPersistenceEnabled) executionStatePersistence.schedule(executionManager.list());
  if (executionTimelinePersistenceEnabled && timelineEvents.length) executionTimelinePersistence.schedule(executionTimeline.list());
});

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function reconcileExecutionSlot(chatId: string): void {
  const current = executionManager.get(chatId);
  if (!current || (current.state !== 'running' && current.state !== 'waiting_approval')) return;
  const hasController = activeStreamControllers.has(chatId);
  const hasPending = agentRuntime.hasPendingForChat(chatId);
  if (!hasController && !hasPending) {
    executionCoordinator.interrupt(chatId, current.runId);
    executionManager.remove(chatId);
  }
}

function ensureApprovalExecution(chatId: string, runId: string): void {
  const current = executionManager.get(chatId);
  if (current?.runId === runId && (current.state === 'running' || current.state === 'waiting_approval')) {
    executionCoordinator.resumePlan(chatId, runId);
    return;
  }
  if (current) executionManager.remove(chatId);
  executionManager.start(chatId, Date.now(), runId);
  executionCoordinator.resumePlan(chatId, runId);
}

async function clearChatExecution(chatId: string): Promise<void> {
  const execution = executionManager.get(chatId);
  const active = activeStreamControllers.get(chatId);
  active?.controller.abort();
  activeStreamControllers.delete(chatId);
  approvalRuntime.remove({ chatId });
  await agentRuntime.cancelChat(chatId);
  if (execution) executionCoordinator.interrupt(chatId, execution.runId);
  else executionPlanner.remove(chatId);
  executionManager.remove(chatId);
}

async function withApprovalRunLock<T>(chatId: string, runId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (approvalRunLocks.has(runId)) throw new Error('Esta execução já está processando outra decisão de aprovação.');
  if (activeStreamControllers.has(chatId)) throw new Error('Esta execução já possui uma operação ativa.');
  approvalRunLocks.add(runId);
  const controller = new AbortController();
  activeStreamControllers.set(chatId, { runId, controller });
  try {
    return await runWithAbortSignal(controller.signal, () => operation(controller.signal));
  } finally {
    const current = activeStreamControllers.get(chatId);
    if (current?.controller === controller) activeStreamControllers.delete(chatId);
    approvalRunLocks.delete(runId);
  }
}

async function cancelledRunResult(chatId: string) {
  const chat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat não encontrado após o cancelamento.');
  return {
    chatId,
    response: { content: '', model: chat.model, providerId: chat.providerId },
    toolRounds: 0,
    pendingApprovalIds: [] as string[],
    messages: [...chat.messages],
  };
}

async function restorePersistedExecutionSnapshots(): Promise<void> {
  const snapshots = await executionStateStore.load();
  for (const snapshot of snapshots) {
    executionManager.remove(snapshot.chatId);
    executionManager.start(snapshot.chatId, snapshot.startedAt, snapshot.runId);
    executionManager.update(snapshot.chatId, {
      state: snapshot.state,
      currentTool: snapshot.currentTool,
      error: snapshot.error,
      runId: snapshot.runId,
    }, snapshot.updatedAt);
  }
}

function restoreExecutionSnapshots(): void {
  for (const run of agentRuntime.listPendingRuns()) {
    executionManager.remove(run.chatId);
    executionManager.start(run.chatId, Date.now(), run.runId);
    executionManager.update(run.chatId, { state: 'waiting_approval', runId: run.runId });
  }
  for (const run of listRecoverableRuns(agentRuntime)) {
    const current = executionManager.get(run.chatId);
    if (current?.runId === run.runId && current.state === 'interrupted') continue;
    executionManager.remove(run.chatId);
    executionManager.start(run.chatId, Date.now(), run.runId);
    executionManager.update(run.chatId, { state: 'interrupted', runId: run.runId });
  }
}

async function getChatContext(chatId: string): Promise<{ chat: Awaited<ReturnType<ChatManager['list']>>[number]; config: AIProviderConfig; projectContext?: string }> {
  const storedChat = (await chatManager.list()).find((item) => item.id === chatId);
  if (!storedChat) throw new Error('Chat não encontrado.');

  let chat = storedChat;
  let config: AIProviderConfig;

  if (chat.apiKeyId) {
    const keys = await providerManager.listKeys();
    const exactKey = keys.find((item) => item.id === chat.apiKeyId);
    if (exactKey) {
      config = providerManager.getConfigForKey(exactKey.id);
    } else {
      const legacyProviderReference = chat.apiKeyId === chat.providerId || keys.some((item) => item.providerId === chat.apiKeyId);
      if (!legacyProviderReference) throw new Error('A IA salva selecionada neste chat não está mais disponível. Abra “IAs salvas” e escolha outra credencial.');
      const replacement = keys.find((item) => item.providerId === chat.providerId && item.active) || keys.find((item) => item.providerId === chat.providerId);
      if (!replacement) throw new Error('A IA salva usada por este chat não existe mais. Abra “IAs salvas” e escolha outra credencial.');
      chat = await chatManager.updateSettings({ chatId: chat.id, providerId: chat.providerId, model: chat.model, apiKeyId: replacement.id, intelligence: chat.intelligence, permissionLevel: chat.permissionLevel });
      config = providerManager.getConfigForKey(replacement.id);
    }
  } else {
    config = providerManager.getConfig(chat.providerId);
  }

  if (config.id !== chat.providerId) throw new Error('A API key selecionada não pertence ao provider salvo neste chat.');
  const computerContext = computerContextRuntime.build();
  const projectContext = chat.projectId ? `${computerContext}\n\n${await projectManager.buildContext(chat.projectId)}` : computerContext;
  return { chat, config, projectContext };
}

function captureExecutionTaskCapsule(
  chat: Awaited<ReturnType<ChatManager['list']>>[number],
  runId: string,
  objective: string,
): void {
  executionTaskCapsuleRuntime.create({
    chatId: chat.id,
    runId,
    objective,
    projectId: chat.projectId,
    providerId: chat.providerId,
    model: chat.model,
    permissionLevel: chat.permissionLevel,
  });
  if (executionTaskCapsulePersistenceEnabled) executionTaskCapsulePersistence.schedule(executionTaskCapsuleRuntime.list());
}

ipcMain.handle('app:get-state', async () => ({ providers: await providerManager.list(), chats: await chatManager.list(), projects: await projectManager.list() }));
ipcMain.handle('providers:list-models', async (_event, identifier: string) => {
  const value = requireIdentifier(identifier, 'Provider');
  const key = (await providerManager.listKeys()).find((item) => item.id === value);
  return key ? providerManager.listModelsForKey(value) : providerManager.listModels(value);
});
ipcMain.handle('providers:list-models-for-key', async (_event, keyId: string) => providerManager.listModelsForKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:list-keys', async () => providerManager.listKeys());
ipcMain.handle('providers:save-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados da API key'); return providerManager.saveKey({ providerId: requireIdentifier(value.providerId, 'Provider'), name: requireNonEmptyString(value.name, 'Nome da API key'), apiKey: requireNonEmptyString(value.apiKey, 'API key'), model: value.model === undefined ? undefined : requireIdentifier(value.model, 'Modelo'), baseUrl: value.baseUrl === undefined ? undefined : requireNonEmptyString(value.baseUrl, 'URL base') }); });
ipcMain.handle('providers:rename-key', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome da API key'); return providerManager.renameKey(requireIdentifier(value.keyId, 'API key'), requireNonEmptyString(value.name, 'Nome da API key')); });
ipcMain.handle('providers:set-active-key', async (_event, keyId: string) => providerManager.setActiveKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:remove-key', async (_event, keyId: string) => providerManager.removeKey(requireIdentifier(keyId, 'API key')));
ipcMain.handle('providers:save', async (_event, input: unknown) => providerManager.save(requireObject(input, 'Dados do provider') as { providerId: string; apiKey: string; model?: string; baseUrl?: string }));
ipcMain.handle('providers:remove', async (_event, providerId: string) => providerManager.remove(requireIdentifier(providerId, 'Provider')));
ipcMain.handle('chat:create', async (_event, input: unknown) => chatManager.create(requireObject(input, 'Dados do chat') as { providerId?: string; model?: string; apiKeyId?: string; intelligence: string; permissionLevel: string; projectId?: string }));
ipcMain.handle('chat:delete', async (_event, chatId: string) => {
  const id = requireIdentifier(chatId, 'Chat');
  await clearChatExecution(id);
  if (executionPlanHistory.purgeChat(id) && executionPlanHistoryPersistenceEnabled) executionPlanHistoryPersistence.schedule(executionPlanHistory.list());
  if (executionQualityGateRuntime.removeChat(id) && executionQualityGatePersistenceEnabled) executionQualityGatePersistence.schedule(executionQualityGateRuntime.list());
  if (executionTaskCapsuleRuntime.removeChat(id) && executionTaskCapsulePersistenceEnabled) executionTaskCapsulePersistence.schedule(executionTaskCapsuleRuntime.list());
  if (executionCheckpointRuntime.removeChat(id) && executionCheckpointPersistenceEnabled) executionCheckpointPersistence.schedule(executionCheckpointRuntime.list());
  executionChangeBudgetRuntime.removeChat(id);
  return chatManager.remove(id);
});
ipcMain.handle('chat:rename', async (_event, input: unknown) => { const value = requireObject(input, 'Dados do nome do chat'); return chatManager.rename(requireIdentifier(value.chatId, 'Chat'), requireNonEmptyString(value.title, 'Nome do chat')); });
ipcMain.handle('chat:update-settings', async (_event, input: unknown) => {
  const value = requireObject(input, 'Configurações do chat');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const requestedProviderId = requireIdentifier(value.providerId, 'Provider');
  const explicitApiKeyId = value.apiKeyId === undefined ? undefined : requireIdentifier(value.apiKeyId, 'API key');
  const selectedKey = explicitApiKeyId ? (await providerManager.listKeys()).find((item) => item.id === explicitApiKeyId) : (await providerManager.listKeys()).find((item) => item.id === requestedProviderId);
  const apiKeyId = explicitApiKeyId || selectedKey?.id;
  const providerId = selectedKey?.providerId || requestedProviderId;
  if (apiKeyId) {
    const config = providerManager.getConfigForKey(apiKeyId);
    if (config.id !== providerId) throw new Error('A API key selecionada não pertence ao provider informado.');
  }
  return chatManager.updateSettings({ chatId, providerId, model: requireIdentifier(value.model, 'Modelo'), apiKeyId, intelligence: requireIdentifier(value.intelligence, 'Inteligência'), permissionLevel: requireIdentifier(value.permissionLevel, 'Permissão') });
});

async function executeChat(chatId: string, content: string): Promise<{ pendingApprovalIds: string[]; chat: Awaited<ReturnType<ChatManager['list']>>[number] | undefined }> {
  const { chat, config, projectContext } = await getChatContext(chatId);
  reconcileExecutionSlot(chatId);
  const execution = executionManager.start(chatId);
  const runId = execution.runId;
  captureExecutionTaskCapsule(chat, runId, content);
  try {
    await chatManager.addMessage(chat.id, { role: 'user', content, createdAt: Date.now() });
    const current = (await chatManager.list()).find((item) => item.id === chat.id);
    if (!current) throw new Error('Chat desapareceu durante a execução.');
    const result = await agentRuntime.run(config, current, projectContext, current.permissionLevel, runId);
    await chatManager.update({ ...current, messages: result.messages });
    if (result.pendingApprovalIds.length) executionCoordinator.waitingApproval(chatId, runId);
    else {
      const completion = executionCoordinator.complete(chatId, runId);
      if (completion.error) throw new Error(completion.error);
    }
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executionCoordinator.fail(chatId, runId, message);
    throw error;
  }
}

ipcMain.handle('chat:send', async (_event, input: { chatId: string; content: string }) => { const value = requireObject(input, 'Mensagem'); return executeChat(requireIdentifier(value.chatId, 'Chat'), requireNonEmptyString(value.content, 'Mensagem')); });
ipcMain.handle('chat:stop', async (_event, chatId: string) => {
  const id = requireIdentifier(chatId, 'Chat');
  const active = activeStreamControllers.get(id);
  if (active) {
    active.controller.abort();
    return { stopped: true };
  }
  if (agentRuntime.hasPendingForChat(id) || agentRuntime.hasRecoverableForChat(id)) {
    await clearChatExecution(id);
    sendStreamEvent({ type: 'cancelled', chatId: id });
    return { stopped: true };
  }
  reconcileExecutionSlot(id);
  return { stopped: false };
});
ipcMain.handle('chat:stream', async (_event, input: { chatId: string; content: string }) => {
  const value = requireObject(input, 'Mensagem');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const content = requireNonEmptyString(value.content, 'Mensagem');
  const { chat, config, projectContext } = await getChatContext(chatId);
  const lastMessage = chat.messages.at(-1);
  const isRetryOfPersistedUserMessage = lastMessage?.role === 'user' && lastMessage.content === content;
  const current = (await chatManager.list()).find((item) => item.id === chat.id);
  if (!current) throw new Error('Chat desapareceu durante a execução.');

  reconcileExecutionSlot(chatId);
  let execution;
  try {
    execution = executionManager.start(chatId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendStreamEvent({ type: 'error', chatId, error: message });
    return { pendingApprovalIds: [], chat: current, error: message };
  }

  const controller = new AbortController();
  activeStreamControllers.set(chatId, { runId: execution.runId, controller });
  const runId = execution.runId;
  captureExecutionTaskCapsule(chat, runId, content);

  const emit = (event: AIStreamEvent): void => {
    try {
      if (event.type === 'approval_required') executionManager.update(chatId, { state: 'waiting_approval', runId });
      else if (event.type === 'error') executionManager.update(chatId, { state: 'failed', error: event.error, runId });
      else if (event.type === 'tool_call') executionManager.update(chatId, { state: 'running', currentTool: event.toolCall?.name, runId });
    } catch {
      // Execution bookkeeping must never interrupt the provider stream.
    }
    sendStreamEvent({ ...event, chatId, runId });
  };

  emit({ type: 'start', chatId, runId });
  try {
    if (!isRetryOfPersistedUserMessage) await chatManager.addMessage(chat.id, { role: 'user', content, createdAt: Date.now() });
    const workingChat = (await chatManager.list()).find((item) => item.id === chat.id);
    if (!workingChat) throw new Error('Chat desapareceu durante a execução.');
    const result = await runWithAbortSignal(controller.signal, () => agentRuntime.runStreaming(config, workingChat, projectContext, workingChat.permissionLevel, emit, controller.signal, runId));
    await chatManager.update({ ...workingChat, messages: result.messages });
    if (result.pendingApprovalIds.length) executionCoordinator.waitingApproval(chatId, runId);
    else if (executionManager.get(chatId)?.state === 'running') {
      const completion = executionCoordinator.complete(chatId, runId);
      if (completion.error) sendStreamEvent({ type: 'error', chatId, runId, error: completion.error });
    }
    return { pendingApprovalIds: result.pendingApprovalIds, chat: (await chatManager.list()).find((item) => item.id === chat.id), error: undefined };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      await clearChatExecution(chatId);
      emit({ type: 'cancelled', chatId, runId });
      return { pendingApprovalIds: [], chat: (await chatManager.list()).find((item) => item.id === chat.id), error: undefined };
    }
    const message = error instanceof Error ? error.message : String(error);
    executionCoordinator.fail(chatId, runId, message);
    emit({ type: 'error', chatId, runId, error: message });
    return { pendingApprovalIds: [], chat: (await chatManager.list()).find((item) => item.id === chat.id), error: message };
  } finally {
    const active = activeStreamControllers.get(chatId);
    if (active?.runId === runId && active.controller === controller) activeStreamControllers.delete(chatId);
  }
});

ipcMain.handle('agent:list-tools', async () => toolRuntime.listDefinitions());
ipcMain.handle('agent:list-approvals', async (_event, filters?: { chatId?: string; runId?: string }) => {
  if (filters === undefined) return toolRuntime.listApprovals();
  const value = requireObject(filters, 'Filtro de aprovações');
  const chatId = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runId = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  return toolRuntime.listApprovals({ chatId, runId });
});
ipcMain.handle('agent:list-executions', async (_event, chatId?: string) => chatId === undefined ? executionManager.list() : executionManager.get(requireIdentifier(chatId, 'Chat')) ?? null);
ipcMain.handle('agent:list-execution-timeline', async (_event, filters?: { chatId?: string; runId?: string }) => {
  if (filters === undefined) return executionTimeline.list();
  const value = requireObject(filters, 'Filtro da timeline de execução');
  const chatId = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runId = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  return executionTimeline.list(chatId, runId);
});
ipcMain.handle('agent:list-execution-plans', async (_event, filters?: { chatId?: string; runId?: string }) => {
  if (filters === undefined) return executionPlanner.list();
  const value = requireObject(filters, 'Filtro dos planos de execução');
  const chatId = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runId = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  if (chatId !== undefined) {
    const plan = executionPlanner.get(chatId, runId);
    return plan ? [plan] : [];
  }
  return executionPlanner.list().filter((plan) => runId === undefined || plan.runId === runId);
});
ipcMain.handle('agent:list-execution-plan-history', async (_event, filters?: { chatId?: string; runId?: string }) => {
  if (filters === undefined) return executionPlanHistory.list();
  const value = requireObject(filters, 'Filtro do histórico de planos');
  const chatId = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runId = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  return executionPlanHistory.list({ chatId, runId });
});
ipcMain.handle('agent:get-execution-report', async (_event, input: unknown) => {
  const value = requireObject(input, 'Identificação do relatório de execução');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const runId = requireIdentifier(value.runId, 'Execução');
  return executionReportBuilder.build(chatId, runId) ?? null;
});
ipcMain.handle('agent:list-execution-reports', async (_event, chatId?: string) => executionReportBuilder.list(chatId === undefined ? undefined : requireIdentifier(chatId, 'Chat')));
ipcMain.handle('agent:configure-execution-quality-gate', async (_event, input: unknown) => {
  const value = requireObject(input, 'Configuração do quality gate');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const runId = requireIdentifier(value.runId, 'Execução');
  if (value.requireVerifiedCompletion !== undefined && typeof value.requireVerifiedCompletion !== 'boolean') throw new Error('requireVerifiedCompletion inválido.');
  if (value.requirements !== undefined && !Array.isArray(value.requirements)) throw new Error('Requisitos do quality gate inválidos.');
  const requirements = (value.requirements ?? []) as ExecutionQualityGateRequirement[];
  const gate = executionQualityGateRuntime.configure({ chatId, runId, requireVerifiedCompletion: value.requireVerifiedCompletion as boolean | undefined, requirements });
  if (executionQualityGatePersistenceEnabled) executionQualityGatePersistence.schedule(executionQualityGateRuntime.list());
  return gate;
});
ipcMain.handle('agent:get-execution-quality-gate', async (_event, input: unknown) => {
  const value = requireObject(input, 'Identificação do quality gate');
  return executionQualityGateRuntime.get(requireIdentifier(value.chatId, 'Chat'), requireIdentifier(value.runId, 'Execução')) ?? null;
});
ipcMain.handle('agent:evaluate-execution-quality-gate', async (_event, input: unknown) => {
  const value = requireObject(input, 'Identificação do quality gate');
  const chatId = requireIdentifier(value.chatId, 'Chat');
  const runId = requireIdentifier(value.runId, 'Execução');
  return executionQualityGateRuntime.evaluate(executionReportBuilder.build(chatId, runId)) ?? null;
});
ipcMain.handle('agent:list-execution-quality-gates', async (_event, chatId?: string) => executionQualityGateRuntime.list(chatId === undefined ? undefined : requireIdentifier(chatId, 'Chat')));
ipcMain.handle('agent:get-execution-task-capsule', async (_event, input: unknown) => {
  const value = requireObject(input, 'Identificação da Task Capsule');
  return executionTaskCapsuleRuntime.get(requireIdentifier(value.chatId, 'Chat'), requireIdentifier(value.runId, 'Execução')) ?? null;
});
ipcMain.handle('agent:list-execution-task-capsules', async (_event, chatId?: string) => executionTaskCapsuleRuntime.list(chatId === undefined ? undefined : requireIdentifier(chatId, 'Chat')));
ipcMain.handle('agent:list-execution-checkpoints', async (_event, filters?: { chatId?: string; runId?: string }) => {
  if (filters === undefined) return executionCheckpointController.list();
  const value = requireObject(filters, 'Filtro dos checkpoints de execução');
  const chatId = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runId = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  return executionCheckpointController.list(chatId, runId);
});
ipcMain.handle('agent:restore-execution-checkpoint', async (_event, input: unknown) => {
  const value = requireObject(input, 'Identificação do checkpoint');
  return executionCheckpointController.restore({
    checkpointId: requireIdentifier(value.checkpointId, 'Checkpoint'),
    chatId: requireIdentifier(value.chatId, 'Chat'),
    runId: requireIdentifier(value.runId, 'Execução'),
  });
});
ipcMain.handle('agent:list-recoverable-runs', async () => listRecoverableRuns(agentRuntime));
ipcMain.handle('agent:resume-recovered', async (_event, runId: string) => {
  const id = requireIdentifier(runId, 'Execução recuperável');
  const recoverable = listRecoverableRuns(agentRuntime).find((run) => run.runId === id);
  if (!recoverable) throw new Error('Execução recuperável não encontrada.');
  return withApprovalRunLock(recoverable.chatId, id, async (signal) => {
    sendStreamEvent({ type: 'start', chatId: recoverable.chatId, runId: id });
    try {
      executionCoordinator.resumePlan(recoverable.chatId, id);
      const { result } = await resumeRecoveredRun(agentRuntime, executionManager, recoverable, Date.now(), signal, true);
      const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
      if (chat) await chatManager.update({ ...chat, messages: result.messages });
      if (!result.pendingApprovalIds.length) {
        const completion = executionCoordinator.complete(recoverable.chatId, id);
        if (completion.error) sendStreamEvent({ type: 'error', chatId: recoverable.chatId, runId: id, error: completion.error });
      }
      return result;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        await clearChatExecution(recoverable.chatId);
        sendStreamEvent({ type: 'cancelled', chatId: recoverable.chatId, runId: id });
        return cancelledRunResult(recoverable.chatId);
      }
      const message = error instanceof Error ? error.message : String(error);
      executionCoordinator.fail(recoverable.chatId, id, message);
      throw error;
    }
  });
});
ipcMain.handle('agent:list-interrupted-provider-requests', async () => chatRuntime.listInterruptedProviderRequests());
ipcMain.handle('agent:approve', async (_event, input: unknown) => {
  const value = requireObject(input, 'Dados da aprovação');
  const id = requireIdentifier(value.approvalId, 'Aprovação');
  const chatIdFilter = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runIdFilter = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  const approval = toolRuntime.listApprovals({ chatId: chatIdFilter, runId: runIdFilter }).find((item) => item.id === id);
  if (!approval?.chatId || !approval.runId) throw new Error('Aprovação não pertence ao contexto informado.');
  const chatId = approval.chatId;
  const runId = agentRuntime.getPendingRunId(id);
  if (runId !== approval.runId) throw new Error('A aprovação não corresponde mais à execução que a criou.');

  return withApprovalRunLock(chatId, runId, async (signal) => {
    ensureApprovalExecution(chatId, runId);
    executionManager.update(chatId, { state: 'running', runId });
    try {
      const result = await agentRuntime.resume(id, signal);
      const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
      if (chat) await chatManager.update({ ...chat, messages: result.messages });
      if (result.pendingApprovalIds.length) executionCoordinator.waitingApproval(chatId, runId);
      else {
        const completion = executionCoordinator.complete(chatId, runId);
        if (completion.error) sendStreamEvent({ type: 'error', chatId, runId, error: completion.error });
      }
      return result;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        await clearChatExecution(chatId);
        sendStreamEvent({ type: 'cancelled', chatId, runId });
        return cancelledRunResult(chatId);
      }
      const message = error instanceof Error ? error.message : String(error);
      const stillPending = toolRuntime.listApprovals({ chatId, runId }).some((item) => item.id === id);
      if (stillPending) executionCoordinator.waitingApproval(chatId, runId);
      else executionCoordinator.fail(chatId, runId, message);
      throw error;
    }
  });
});
ipcMain.handle('agent:deny', async (_event, input: unknown) => {
  const value = requireObject(input, 'Dados da aprovação');
  const id = requireIdentifier(value.approvalId, 'Aprovação');
  const chatIdFilter = value.chatId === undefined ? undefined : requireIdentifier(value.chatId, 'Chat');
  const runIdFilter = value.runId === undefined ? undefined : requireIdentifier(value.runId, 'Execução');
  const approval = toolRuntime.listApprovals({ chatId: chatIdFilter, runId: runIdFilter }).find((item) => item.id === id);
  if (!approval?.chatId || !approval.runId) throw new Error('Aprovação não pertence ao contexto informado.');
  const chatId = approval.chatId;
  const runId = agentRuntime.getPendingRunId(id);
  if (runId !== approval.runId) throw new Error('A aprovação não corresponde mais à execução que a criou.');

  return withApprovalRunLock(chatId, runId, async (signal) => {
    ensureApprovalExecution(chatId, runId);
    executionManager.update(chatId, { state: 'running', runId });
    try {
      const result = await agentRuntime.reject(id, signal);
      const chat = (await chatManager.list()).find((item) => item.id === result.chatId);
      if (chat) await chatManager.update({ ...chat, messages: result.messages });
      if (result.pendingApprovalIds.length) executionCoordinator.waitingApproval(chatId, runId);
      else {
        const completion = executionCoordinator.complete(chatId, runId);
        if (completion.error) sendStreamEvent({ type: 'error', chatId, runId, error: completion.error });
      }
      return result;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        await clearChatExecution(chatId);
        sendStreamEvent({ type: 'cancelled', chatId, runId });
        return cancelledRunResult(chatId);
      }
      const message = error instanceof Error ? error.message : String(error);
      const stillPending = toolRuntime.listApprovals({ chatId, runId }).some((item) => item.id === id);
      if (stillPending) executionCoordinator.waitingApproval(chatId, runId);
      else executionCoordinator.fail(chatId, runId, message);
      throw error;
    }
  });
});

ipcMain.handle('terminal:start', async (_event, input: { projectId: string; command: string }) => { const value = requireObject(input, 'Dados do terminal'); return terminalService.start(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.command, 'Comando')); });
ipcMain.handle('terminal:write-input', async (_event, input: unknown) => {
  const value = requireObject(input, 'Entrada do terminal');
  const sessionId = requireIdentifier(value.sessionId, 'Sessão do terminal');
  if (typeof value.data !== 'string') throw new Error('Entrada do terminal inválida.');
  return terminalService.writeInput(sessionId, value.data);
});
ipcMain.handle('terminal:resize', async (_event, input: unknown) => {
  const value = requireObject(input, 'Tamanho do terminal');
  const sessionId = requireIdentifier(value.sessionId, 'Sessão do terminal');
  const cols = Number(value.cols);
  const rows = Number(value.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error('Tamanho do terminal inválido.');
  return terminalService.resize(sessionId, cols, rows);
});
ipcMain.handle('terminal:kill', async (_event, sessionId: string) => terminalService.kill(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-sessions', async () => terminalService.listSessions());
ipcMain.handle('terminal:get-output', async (_event, sessionId: string) => terminalService.getOutput(requireIdentifier(sessionId, 'Sessão do terminal')));
ipcMain.handle('terminal:list-history', async (_event, projectId?: string) => terminalService.listHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('terminal:clear-history', async (_event, projectId?: string) => terminalService.clearHistory(projectId === undefined ? undefined : requireIdentifier(projectId, 'Projeto')));

ipcMain.handle('git:status', async (_event, projectId: string) => gitService.status(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:branches', async (_event, projectId: string) => gitService.branches(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:diff', async (_event, projectId: string) => gitService.diff(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:log', async (_event, input: { projectId: string; limit?: number }) => { const value = requireObject(input, 'Dados do histórico Git'); const projectId = requireIdentifier(value.projectId, 'Projeto'); const limit = value.limit === undefined ? undefined : Number(value.limit); if (limit !== undefined && !Number.isFinite(limit)) throw new Error('Limite do histórico Git inválido.'); return gitService.log(projectId, limit); });
ipcMain.handle('git:create-branch', async (_event, input: { projectId: string; name: string }) => { const value = requireObject(input, 'Dados da branch'); return gitService.createBranch(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Nome da branch')); });
ipcMain.handle('git:checkout', async (_event, input: { projectId: string; name: string }) => { const value = requireObject(input, 'Dados do checkout'); return gitService.checkout(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.name, 'Nome da branch')); });
ipcMain.handle('git:stage', async (_event, input: { projectId: string; paths: string[] }) => { const value = requireObject(input, 'Dados do staging'); if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== 'string')) throw new Error('Arquivos do staging inválidos.'); return gitService.stage(requireIdentifier(value.projectId, 'Projeto'), value.paths.map((item) => requireNonEmptyString(item, 'Arquivo'))); });
ipcMain.handle('git:stage-all', async (_event, projectId: string) => gitService.stageAll(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('git:commit', async (_event, input: { projectId: string; message: string }) => { const value = requireObject(input, 'Dados do commit'); return gitService.commit(requireIdentifier(value.projectId, 'Projeto'), requireNonEmptyString(value.message, 'Mensagem')); });

ipcMain.handle('projects:create', async (_event, input: { name: string; rootPath: string }) => { const value = requireObject(input, 'Dados do projeto'); return projectManager.create(requireNonEmptyString(value.name, 'Nome do projeto'), requireNonEmptyString(value.rootPath, 'Pasta do projeto')); });
ipcMain.handle('projects:open-folder', async () => { if (!mainWindow || mainWindow.isDestroyed()) throw new Error('A janela principal não está disponível.'); const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] || null; });
ipcMain.handle('projects:list', async () => projectManager.list());
ipcMain.handle('projects:delete', async (_event, projectId: string) => projectManager.remove(requireIdentifier(projectId, 'Projeto')));
ipcMain.handle('projects:scan', async (_event, rootPath: string) => projectManager.scan(requireNonEmptyString(rootPath, 'Pasta do projeto')));
ipcMain.handle('projects:read-file', async (_event, filePath: string) => projectManager.readFile(requireNonEmptyString(filePath, 'Arquivo')));
ipcMain.handle('projects:write-file', async (_event, input: { filePath: string; content: string }) => { const value = requireObject(input, 'Dados do arquivo'); await projectManager.writeFile(requireNonEmptyString(value.filePath, 'Arquivo'), typeof value.content === 'string' ? value.content : (() => { throw new Error('Conteúdo de arquivo é inválido.'); })()); return { ok: true }; });
ipcMain.handle('app:open-external', async (_event, url: string) => shell.openExternal(requireNonEmptyString(url, 'URL externa')));

app.whenReady().then(async () => {
  await storage.init();
  await providerManager.init();
  await chatManager.init();
  await projectManager.init();
  await terminalService.init();
  await chatRuntime.init();
  await toolRuntime.init();
  await agentRuntime.init();
  executionTimeline.restore(await executionTimelineStore.load());
  executionPlanHistory.restore(await executionPlanHistoryStore.load());
  executionQualityGateRuntime.restore(await executionQualityGateStore.load());
  executionTaskCapsuleRuntime.restore(await executionTaskCapsuleStore.load());
  executionCheckpointRuntime.hydrate(await executionCheckpointStore.load());
  await restorePersistedExecutionSnapshots();
  executionPlanner.restore(await executionPlanStore.load());
  restoreExecutionSnapshots();
  for (const run of agentRuntime.listPendingRuns()) executionCoordinator.resumePlan(run.chatId, run.runId);
  for (const run of listRecoverableRuns(agentRuntime)) executionCoordinator.resumePlan(run.chatId, run.runId);
  executionPersistenceEnabled = true;
  executionTimelinePersistenceEnabled = true;
  executionPlanPersistenceEnabled = true;
  executionPlanHistoryPersistenceEnabled = true;
  executionQualityGatePersistenceEnabled = true;
  executionTaskCapsulePersistenceEnabled = true;
  executionCheckpointPersistenceEnabled = true;
  executionStatePersistence.schedule(executionManager.list());
  executionTimelinePersistence.schedule(executionTimeline.list());
  executionPlanPersistence.schedule(executionPlanner.list());
  executionPlanHistoryPersistence.schedule(executionPlanHistory.list());
  executionQualityGatePersistence.schedule(executionQualityGateRuntime.list());
  executionTaskCapsulePersistence.schedule(executionTaskCapsuleRuntime.list());
  executionCheckpointPersistence.schedule(executionCheckpointRuntime.list());
  activityRuntime.subscribe((event) => sendActivity(event));
  terminalService.subscribe((event: TerminalEvent) => sendTerminalEvent(event));
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
