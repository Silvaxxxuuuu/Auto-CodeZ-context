import './renderer';

type Enhancement = {
  name: string;
  load: () => Promise<unknown>;
};

const enhancements: Enhancement[] = [
  { name: 'ui-polish', load: () => import('./ui-polish') },
  { name: 'settings-ui', load: () => import('./settings-ui') },
  { name: 'stop-control', load: () => import('./stop-control') },
  { name: 'composer-resilience', load: () => import('./composer-resilience') },
  { name: 'thinking-ui', load: () => import('./thinking-ui') },
  { name: 'chat-execution-ui', load: () => import('./chat-execution-ui') },
  { name: 'approval-ui', load: () => import('./approval-ui') },
  { name: 'terminal-ui', load: () => import('./terminal-ui') },
  { name: 'activity-ui', load: () => import('./activity-ui') },
  { name: 'diff-ui', load: () => import('./diff-ui') },
  { name: 'git-ui', load: () => import('./git-ui') },
  { name: 'git-actions-ui', load: () => import('./git-actions-ui') },
  { name: 'chat-rename-ui', load: () => import('./chat-rename-ui') },
  { name: 'api-settings-routing-ui', load: () => import('./api-settings-routing-ui') },
  { name: 'initial-chat-ui', load: () => import('./initial-chat-ui') },
  { name: 'profile-ui', load: () => import('./profile-ui') },
  { name: 'chat-api-key-settings-ui', load: () => import('./chat-api-key-settings-ui') },
  { name: 'api-key-ui', load: () => import('./api-key-ui') },
  { name: 'error-recovery-ui', load: () => import('./error-recovery-ui') },
  { name: 'api-key-flow-polish', load: () => import('./api-key-flow-polish') },
  { name: 'execution-visibility', load: () => import('./execution-visibility') },
  { name: 'stream-performance', load: () => import('./stream-performance') },
];

const failures = new Map<string, unknown>();

function renderFailures(): void {
  const existing = document.querySelector<HTMLElement>('#auto-codez-module-failures');
  if (!failures.size) {
    existing?.remove();
    return;
  }

  const marker = existing ?? document.createElement('div');
  marker.id = 'auto-codez-module-failures';
  marker.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:520px;padding:10px 12px;background:#351414;color:#ffd4d4;border:1px solid #8d3f3f;border-radius:8px;font:12px/1.45 Consolas,monospace;white-space:pre-wrap;box-shadow:0 8px 28px #0008';
  marker.textContent = `Falha em ${failures.size} módulo(s):\n${Array.from(failures.keys()).join('\n')}`;
  if (!existing) document.body.appendChild(marker);
}

for (const enhancement of enhancements) {
  void enhancement.load().catch((error: unknown) => {
    failures.set(enhancement.name, error);
    console.error(`Falha ao inicializar ${enhancement.name}.`, error);
    renderFailures();
  });
}
