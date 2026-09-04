const modules = [
  () => import('./renderer'),
  () => import('./settings-ui'),
  () => import('./stop-control'),
  () => import('./composer-resilience'),
  () => import('./thinking-ui'),
  () => import('./chat-execution-ui'),
  () => import('./approval-ui'),
  () => import('./terminal-ui'),
  () => import('./activity-ui'),
  () => import('./chat-rename-ui'),
  () => import('./api-settings-routing-ui'),
  () => import('./initial-chat-ui'),
  () => import('./profile-ui'),
  () => import('./chat-api-key-settings-ui'),
] as const;

export async function bootstrap(): Promise<void> {
  for (const loadModule of modules) await loadModule();
}
