import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

test('production code cannot create legacy Shadow Workspace state', async () => {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const files = await sourceFiles(sourceRoot);
  const callers: string[] = [];

  for (const file of files) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    const content = await fs.readFile(file, 'utf8');
    const matches = [...content.matchAll(/\bbeginLegacy\s*\(/g)];
    if (!matches.length) continue;

    if (relative === 'src/execution-shadow-workspace.ts') {
      const declarationCount = [...content.matchAll(/\bbeginLegacy\s*\(chatId:/g)].length;
      assert.equal(declarationCount, 1);
      assert.equal(matches.length, 1, 'execution-shadow-workspace.ts may only declare beginLegacy, never call it internally');
      continue;
    }

    callers.push(relative);
  }

  assert.deepEqual(
    callers,
    [],
    `Código de produção V2 não pode criar Shadow Workspace legado: ${callers.join(', ')}`,
  );
});

test('legacy Shadow Workspace creation API is explicit and workspace access cannot create state', async () => {
  const file = path.resolve(process.cwd(), 'src/execution-shadow-workspace.ts');
  const content = await fs.readFile(file, 'utf8');

  assert.match(content, /beginLegacy\(chatId: string, runId: string, projectId: string\)/);
  assert.doesNotMatch(content, /\bbegin\(chatId: string, runId: string, projectId: string\)/);

  const workspaceStart = content.indexOf('workspace(chatId: string, runId: string, projectId: string)');
  const getStart = content.indexOf('\n  get(chatId:', workspaceStart);
  assert.ok(workspaceStart >= 0 && getStart > workspaceStart);
  const workspaceBody = content.slice(workspaceStart, getStart);
  assert.match(workspaceBody, /transactions\.get\(/);
  assert.match(workspaceBody, /legado da execução não encontrado/);
  assert.doesNotMatch(workspaceBody, /beginLegacy\(/);
});


test('legacy Shadow Workspace dependencies stay frozen to the compatibility boundary', async () => {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const files = await sourceFiles(sourceRoot);
  const allowed = new Set([
    'src/agent/command-sandbox.ts',
    'src/agent/shadow-aware-command-runtime.ts',
    'src/agent/shadow-aware-git-runtime.ts',
    'src/agent/shadow-aware-tool-runtime.ts',
    'src/agent/shadow-aware-workspace-runtime.ts',
    'src/agent/shadow-git-read-runtime.ts',
    'src/execution-shadow-workspace-controller.ts',
    'src/execution-shadow-workspace.ts',
    'src/main.ts',
  ]);
  const dependencies: string[] = [];

  for (const file of files) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    const content = await fs.readFile(file, 'utf8');
    if (/ExecutionShadowWorkspaceRuntime|executionShadowWorkspaceRuntime/.test(content)) {
      dependencies.push(relative);
    }
  }

  assert.deepEqual(
    dependencies.sort(),
    [...allowed].sort(),
    'Dependências de Shadow Workspace em produção devem permanecer restritas à fronteira de compatibilidade conhecida.',
  );
});

test('legacy workspace overlay is only accessed through ShadowAwareWorkspaceRuntime', async () => {
  const sourceRoot = path.resolve(process.cwd(), 'src');
  const files = await sourceFiles(sourceRoot);
  const callers: string[] = [];

  for (const file of files) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    const content = await fs.readFile(file, 'utf8');
    if (/(?:shadowWorkspaces|executionShadowWorkspaceRuntime|shadows)\.workspace\s*\(/.test(content)) {
      callers.push(relative);
    }
  }

  assert.deepEqual(
    callers,
    ['src/agent/shadow-aware-workspace-runtime.ts'],
    'Acesso ao overlay legado deve passar somente pelo wrapper compatibility-only.',
  );
});
