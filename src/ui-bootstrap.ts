const modules = [
  () => import('./renderer'),
  () => import('./settings-ui'),
  () => import('./stream-performance'),
  () => import('./stop-control'),
  () => import('./composer-resilience'),
  () => import('./thinking-ui'),
  () => import('./chat-execution-ui'),
  () => import('./approval-ui'),
  () => import('./terminal-ui'),
  () => import('./activity-ui'),
  () => import('./diff-ui'),
  () => import('./git-ui'),
  () => import('./git-actions-ui'),
  () => import('./chat-rename-ui'),
  () => import('./api-settings-routing-ui'),
  () => import('./initial-chat-ui'),
  () => import('./profile-ui'),
  () => import('./chat-api-key-settings-ui'),
] as const;

async function bootstrap(): Promise<void> {
  for (const loadModule of modules) await loadModule();
}

void bootstrap().catch((error: unknown) => {
  console.error('Falha ao inicializar a interface do Auto CodeZ.', error);
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app) {
    app.innerHTML = '<div style="height:100%;display:grid;place-items:center;padding:32px;background:#080a0e;color:#edf0f5;font-family:system-ui,sans-serif"><div><strong>Falha ao iniciar a interface.</strong><p style="color:#9aa3af">Verifique o console do aplicativo para obter os detalhes.</p></div></div>';
  }
});
