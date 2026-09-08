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

async function startFakeOllama() {
  ollamaServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'qwen3:8b', model: 'qwen3:8b' },
            { name: 'llava:latest', model: 'llava:latest' },
          ],
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/show') {
        const body = await readJson(req);
        const model = String(body.model || '');
        const capabilities = model === 'qwen3:8b'
          ? ['completion', 'tools', 'thinking']
          : model === 'llava:latest'
            ? ['completion', 'vision']
            : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities, model_info: {} }));
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

async function verifyLocalAiPanel() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  const localAiButton = page.locator('[data-local-ai-settings]');
  await localAiButton.waitFor({ state: 'visible', timeout: 10_000 });
  await localAiButton.click();
  const connected = page.locator('[data-local-ai-status="connected"]');
  await connected.waitFor({ state: 'visible', timeout: 15_000 });

  const provider = await page.evaluate(async () => {
    const state = await window.autoCodez.getState();
    return state.providers.find((item) => item.id === 'ollama') || null;
  });
  if (!provider || provider.requiresApiKey !== false) throw new Error(`Ollama keyless não foi exposto corretamente: ${JSON.stringify(provider)}`);

  const text = (await connected.innerText()).replace(/\s+/g, ' ');
  if (!text.includes('Conectado')) throw new Error(`Status conectado ausente: ${text}`);
  if (!text.includes('qwen3:8b') || !text.includes('llava:latest')) throw new Error(`Modelos locais não foram exibidos: ${text}`);
  const capabilityMatches = text.match(/1\/2/g) || [];
  if (capabilityMatches.length < 3) throw new Error(`Capacidades tools/reasoning/vision não foram refletidas: ${text}`);
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

  const headerText = (await page.locator('#chat-header').innerText()).replace(/\s+/g, ' ');
  const chatText = (await restoredChat.innerText()).replace(/\s+/g, ' ');
  if (!headerText.includes('Ollama') || !headerText.includes('qwen3:8b')) throw new Error(`Header não foi reidratado com Ollama: ${headerText}`);
  if (!chatText.includes('Ollama')) throw new Error(`Lista de chats não foi reidratada com Ollama: ${chatText}`);

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
  await page.screenshot({ path: path.join(outputDir, `${testName}.png`), animations: 'disabled' });
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
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled' }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'local-ai-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
