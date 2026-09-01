import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function readProjectFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(root, relativePath), 'utf8');
}

test('renderer entry loads the visual refinement modules after the main renderer', async () => {
  const html = await readProjectFile('index.html');
  const rendererIndex = html.indexOf('/src/renderer.ts');
  const terminalIndex = html.indexOf('/src/terminal-ui.ts');
  const renameIndex = html.indexOf('/src/chat-rename-ui.ts');
  const apiKeyIndex = html.indexOf('/src/api-key-ui.ts');
  const routingIndex = html.indexOf('/src/api-settings-routing-ui.ts');
  const polishIndex = html.indexOf('/src/ui-polish.css');

  assert.notEqual(rendererIndex, -1, 'renderer entry must be present');
  assert.notEqual(terminalIndex, -1, 'terminal UI must be loaded');
  assert.notEqual(renameIndex, -1, 'chat rename UI must be loaded');
  assert.notEqual(apiKeyIndex, -1, 'API key UI must be loaded');
  assert.notEqual(routingIndex, -1, 'API settings routing UI must be loaded');
  assert.notEqual(polishIndex, -1, 'final UI polish stylesheet must be loaded');
  assert.ok(rendererIndex < terminalIndex, 'terminal UI must run after the renderer creates the rail');
  assert.ok(terminalIndex < apiKeyIndex, 'API key UI must run after the terminal creates its rail button');
  assert.ok(apiKeyIndex < routingIndex, 'API settings routing must run after the API key button exists');
  assert.match(html, /\/src\/ui-overrides\.css/);
});

test('UI overrides contain the core interaction refinements', async () => {
  const css = await readProjectFile('src/ui-overrides.css');

  assert.match(css, /\.message\.user\s*\{/);
  assert.match(css, /margin-left:\s*auto/);
  assert.match(css, /\.chat-delete::before/);
  assert.match(css, /\.chat-settings::before/);
  assert.match(css, /\.intelligence-brain/);
  assert.match(css, /typing-dots/);
  assert.match(css, /\.topbar\s*\{\s*display:\s*none/);
});

test('rail polish provides dedicated key and terminal iconography', async () => {
  const css = await readProjectFile('src/ui-polish.css');

  assert.match(css, /\.rail-button\.api-key-rail-button::before/);
  assert.match(css, /\.rail-button\.terminal-rail-button::before/);
  assert.match(css, /mask-image:/);
  assert.match(css, /viewBox='0 0 24 24'/);
});

test('API key and chat rename modules target their intended existing controls', async () => {
  const apiKeyUi = await readProjectFile('src/api-key-ui.ts');
  const renameUi = await readProjectFile('src/chat-rename-ui.ts');

  assert.match(apiKeyUi, /\.terminal-rail-button/);
  assert.match(apiKeyUi, /api-key-rail-button/);
  assert.match(apiKeyUi, /listApiKeys/);
  assert.match(apiKeyUi, /renameApiKey/);
  assert.match(apiKeyUi, /removeApiKey/);
  assert.match(renameUi, /\[data-chat-settings\]/);
  assert.match(renameUi, /renameChat/);
});

test('legacy AI settings entry points are routed to the dedicated API key manager', async () => {
  const routingUi = await readProjectFile('src/api-settings-routing-ui.ts');

  assert.match(routingUi, /data-action="ai-settings"/);
  assert.match(routingUi, /api-key-rail-button/);
  assert.match(routingUi, /stopImmediatePropagation/);
  assert.match(routingUi, /apiKeyButton\.click\(\)/);
});
