const modules = [
  './renderer',
  './settings-ui',
  './stream-performance',
  './stop-control',
  './composer-resilience',
  './thinking-ui',
  './chat-execution-ui',
  './approval-ui',
  './terminal-ui',
  './activity-ui',
  './diff-ui',
  './git-ui',
  './git-actions-ui',
  './chat-rename-ui',
  './api-settings-routing-ui',
  './initial-chat-ui',
  './profile-ui',
  './chat-api-key-settings-ui',
] as const;

async function bootstrap(): Promise<void> {
  for (const modulePath of modules) await import(modulePath);
}

void bootstrap().catch((error: unknown) => {
  console.error('Falha ao inicializar a interface do Auto CodeZ.', error);
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app) {
    app.innerHTML = '<div style="height:100%;display:grid;place-items:center;padding:32px;background:#080a0e;color:#edf0f5;font-family:system-ui,sans-serif"><div><strong>Falha ao iniciar a interface.</strong><p style="color:#9aa3af">Verifique o console do aplicativo para obter os detalhes.</p></div></div>';
  }
});
