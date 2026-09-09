const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const electronExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const manifestPath = path.join(outputDir, 'manifest.json');
const testName = 'funcional-ia-local-ollama';
let stateRoot;
let appProcess;
let browser;
let page;
let exitState;
let stderr = '';
let ollamaServer;
const installedModels = new Set(['qwen3:8b', 'llava:latest']);

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar porta CDP.'));
        else resolve(port);
      });
    });
  });
}

async function createStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-local-ai-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function environment() {
  const env = {
    ...process.env,
    AUTO_CODEZ_VISUAL_TEST: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    HOME: stateRoot,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }
  return env;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function fakeModel(model) {
  if (model === 'qwen3:8b') return { name: model, model, size: Math.round(5.2 * 1024 ** 3), details: { family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' } };
  if (model === 'qwen3:1.7b') return { name: model, model, size: Math.round(1.4 * 1024 ** 3), details: { family: 'qwen3', parameter_size: '1.7B', quantization_level: 'Q4_K_M' } };
  return { name: model, model, size: Math.round(4.5 * 1024 ** 3), details: { family: 'llava', parameter_size: '7B', quantization_level: 'Q4_0' } };
}

async function startFakeOllama() {
  ollamaServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [...installedModels].map(fakeModel) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/show') {
        const body = await readJson(req);
        const model = String(body.model || '');
        const capabilities = model.startsWith('qwen3:')
          ? ['completion', 'tools', 'thinking']
          : model === 'llava:latest'
            ? ['completion', 'vision']
            : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities, model_info: {} }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/pull') {
        const body = await readJson(req);
        const model = String(body.model || '');
        if (model !== 'qwen3:1.7b') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'model not available in visual fixture' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'downloading', completed: 350, total: 1400, digest: 'sha256:test' })}\n`);
        setTimeout(() => {
          res.write(`${JSON.stringify({ status: 'downloading', completed: 1400, total: 1400, digest: 'sha256:test' })}\n`);
          installedModels.add(model);
          res.end(`${JSON.stringify({ status: 'success' })}\n`);
        }, 120);
        return;
      }
      if (req.method === 'DELETE' && req.url === '/api/delete') {
        const body = await readJson(req);
        const model = String(body.model || '');
        if (!installedModels.has(model)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'model is not installed in visual fixture' }));
          return;
        }
        installedModels.delete(model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorText(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    ollamaServer.once('error', reject);
    ollamaServer.listen(11434, '127.0.0.1', resolve);
  });
}

async function startElectron() {
  if (!electronExecutable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não foi definido.');
  const port = await reservePort();
  appProcess = spawn(electronExecutable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
  ], {
    cwd: root,
    env: environment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  appProcess.stderr?.setEncoding('utf8');
  appProcess.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-256 * 1024); });
  appProcess.once('exit', (code, signal) => { exitState = { code, signal }; });

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (exitState) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(exitState)}\n${stderr}`);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Contexto Chromium indisponível.');
      page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.waitForEvent('page', { timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error(`CDP não ficou disponível: ${errorText(lastError)}`);
}

async function updateManifest(result) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.results = Array.isArray(manifest.results) ? manifest.results.filter((item) => item?.name !== testName) : [];
  manifest.results.push(result);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function verifyRecommendationMatchesSnapshot() {
  const snapshot = await page.evaluate(() => window.autoCodezLocalAi.snapshot());
  const bodyText = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
  if (snapshot.recommendation) {
    if (!bodyText.includes('Recomendado para este computador')) throw new Error(`Recomendação automática não foi exibida: ${bodyText}`);
    const recommended = snapshot.catalog.find((model) => model.runtimeId === snapshot.recommendation.runtimeId && model.id === snapshot.recommendation.modelId);
    if (!recommended || !bodyText.includes(recommended.name)) throw new Error(`Modelo recomendado não corresponde ao snapshot: ${JSON.stringify(snapshot.recommendation)}`);
  } else if (!bodyText.includes('Sem opção segura')) {
    throw new Error(`Ausência de recomendação não foi explicada na interface: ${bodyText}`);
  }
}

async function verifyInstallAndRemoval() {
  const install = page.locator('[data-local-ai-action="install"][data-model-id="qwen3:1.7b"]');
  await install.waitFor({ state: 'visible', timeout: 10_000 });
  if (await install.isDisabled()) throw new Error('Qwen 3 1.7B foi bloqueado inesperadamente no runner visual.');
  await install.click();

  const catalogRow = page.locator('[data-local-ai-model="ollama:qwen3:1.7b"]');
  await catalogRow.getByText('Instalado', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  const installedRow = page.locator('[data-local-ai-installed-model="ollama:qwen3:1.7b"]');
  await installedRow.waitFor({ state: 'visible', timeout: 15_000 });

  await installedRow.locator('[data-local-ai-action="remove"]').click();
  const confirmedRow = page.locator('[data-local-ai-installed-model="ollama:qwen3:1.7b"]');
  await confirmedRow.getByText('Confirmar remoção', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await confirmedRow.locator('[data-local-ai-action="confirm-remove"]').click();
  await installedRow.waitFor({ state: 'detached', timeout: 15_000 });

  const installAgain = page.locator('[data-local-ai-action="install"][data-model-id="qwen3:1.7b"]');
  await installAgain.waitFor({ state: 'visible', timeout: 15_000 });
  if (!installedModels.has('qwen3:8b') || installedModels.has('qwen3:1.7b')) throw new Error(`Fixture não refletiu remoção corretamente: ${JSON.stringify([...installedModels])}`);
}

async function verifyLocalAiPanel() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  const localAiButton = page.locator('[data-local-ai-settings]');
  await localAiButton.waitFor({ state: 'visible', timeout: 10_000 });
  await localAiButton.click();
  await page.getByText('Seu computador', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });

  const provider = await page.evaluate(async () => {
    const state = await window.autoCodez.getState();
    return state.providers.find((item) => item.id === 'ollama') || null;
  });
  if (!provider || provider.requiresApiKey !== false) throw new Error(`Ollama keyless não foi exposto corretamente: ${JSON.stringify(provider)}`);

  const bodyText = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
  if (!bodyText.includes('Conectado')) throw new Error(`Status conectado ausente: ${bodyText}`);
  if (!bodyText.includes('qwen3:8b') || !bodyText.includes('llava:latest')) throw new Error(`Inventário local não foi exibido: ${bodyText}`);
  if (!bodyText.includes('Qwen 3 1.7B') || !bodyText.includes('Catálogo local')) throw new Error(`Catálogo local não foi exibido: ${bodyText}`);
  if (!bodyText.includes('Memória RAM') || !bodyText.includes('Armazenamento livre')) throw new Error(`Diagnóstico de hardware incompleto: ${bodyText}`);

  await verifyRecommendationMatchesSnapshot();
  await verifyInstallAndRemoval();
  await page.locator('[data-settings-close]').click();
}

async function verifyChatCanSelectOllama() {
  const created = await page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'safe' }));
  if (!created?.id) throw new Error('Não foi possível criar um chat para testar Ollama.');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const chatItem = page.locator(`[data-chat="${created.id}"]`).first();
  await chatItem.waitFor({ state: 'visible', timeout: 15_000 });
  await chatItem.click();

  const settingsButton = page.locator(`[data-chat-settings="${created.id}"]`).first();
  await settingsButton.waitFor({ state: 'attached', timeout: 10_000 });
  await settingsButton.click({ force: true });

  const aiSelect = page.locator('#chat-available-ai');
  await aiSelect.waitFor({ state: 'visible', timeout: 10_000 });
  const ollamaOption = aiSelect.locator('option[value="provider:ollama"]');
  if (await ollamaOption.count() !== 1) throw new Error('Ollama não apareceu em IAs disponíveis do chat.');
  await aiSelect.selectOption('provider:ollama');

  const modelSelect = page.locator('#chat-model');
  await modelSelect.locator('option[value="qwen3:8b"]').waitFor({ state: 'attached', timeout: 15_000 });
  await modelSelect.selectOption('qwen3:8b');
  await page.locator('#save-available-ai-settings').click();

  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const restoredChat = page.locator(`.chat-item.selected[data-chat="${created.id}"]`).first();
  await restoredChat.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction((chatId) => {
    const selected = document.querySelector(`.chat-item.selected[data-chat="${CSS.escape(chatId)}"]`);
    const header = document.querySelector('#chat-header');
    return Boolean(selected?.textContent?.includes('Ollama') && header?.textContent?.includes('Ollama') && header.textContent.includes('qwen3:8b'));
  }, created.id, { timeout: 15_000 });

  const persisted = await page.evaluate(async (chatId) => {
    const state = await window.autoCodez.getState();
    return state.chats.find((chat) => chat.id === chatId) || null;
  }, created.id);
  if (!persisted || persisted.providerId !== 'ollama' || persisted.model !== 'qwen3:8b' || persisted.apiKeyId) {
    throw new Error(`Ollama não persistiu corretamente no chat: ${JSON.stringify(persisted)}`);
  }
}

async function runTest() {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await verifyLocalAiPanel();
  await verifyChatCanSelectOllama();
  await page.screenshot({ path: path.join(outputDir, `${testName}.png`), animations: 'disabled', fullPage: true });
  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
  }
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (ollamaServer) await new Promise((resolve) => ollamaServer.close(() => resolve())).catch(() => {});
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  try {
    await startFakeOllama();
    await createStateRoot();
    await startElectron();
    await runTest();
    await updateManifest({ name: testName, status: 'passed' });
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'local-ai-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
