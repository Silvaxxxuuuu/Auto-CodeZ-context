const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const executable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
let stateRoot;
let appProcess;
let browser;
let page;
let server;
let exitState;
let stderr = '';

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      socket.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta CDP.'));
        else resolve(port);
      });
    });
  });
}

async function createStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-lm-studio-chat-'));
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
  delete env.LM_API_TOKEN;
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }
  return env;
}

async function startFakeLmStudio() {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      if (req.headers.authorization) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unexpected authorization header' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          {
            type: 'llm',
            key: 'granite-local',
            display_name: 'Granite Local',
            architecture: 'granite',
            quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
            size_bytes: Math.round(1.8 * 1024 ** 3),
            params_string: '3B',
            max_context_length: 32768,
            capabilities: { vision: false, trained_for_tool_use: true },
          },
          {
            type: 'embedding',
            key: 'embedding-local',
            display_name: 'Embedding Local',
            size_bytes: Math.round(0.3 * 1024 ** 3),
            max_context_length: 8192,
          },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(1234, '127.0.0.1', resolve);
  });
}

async function startElectron() {
  if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não foi definido.');
  const port = await reservePort();
  appProcess = spawn(executable, [
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

async function verifyLmStudioChatSelection() {
  const provider = await page.evaluate(async () => {
    const state = await window.autoCodez.getState();
    return state.providers.find((item) => item.id === 'lm-studio') || null;
  });
  if (!provider || provider.requiresApiKey !== false || provider.apiKeyConfigured !== false) {
    throw new Error(`LM Studio keyless não foi exposto corretamente: ${JSON.stringify(provider)}`);
  }

  const created = await page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'safe' }));
  if (!created?.id) throw new Error('Não foi possível criar um chat para testar LM Studio.');

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
  const option = aiSelect.locator('option[value="provider:lm-studio"]');
  if (await option.count() !== 1) throw new Error('LM Studio não apareceu em IAs disponíveis do chat.');
  await aiSelect.selectOption('provider:lm-studio');

  const modelSelect = page.locator('#chat-model');
  await modelSelect.locator('option[value="granite-local"]').waitFor({ state: 'attached', timeout: 15_000 });
  if (await modelSelect.locator('option[value="embedding-local"]').count()) {
    throw new Error('Embedding do LM Studio apareceu como modelo de chat.');
  }
  await modelSelect.selectOption('granite-local');
  await page.locator('#save-available-ai-settings').click();

  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(`.chat-item.selected[data-chat="${created.id}"]`).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction((chatId) => {
    const selected = document.querySelector(`.chat-item.selected[data-chat="${CSS.escape(chatId)}"]`);
    const header = document.querySelector('#chat-header');
    return Boolean(selected?.textContent?.includes('LM Studio') && header?.textContent?.includes('LM Studio') && header.textContent.includes('granite-local'));
  }, created.id, { timeout: 15_000 });

  const persisted = await page.evaluate(async (chatId) => {
    const state = await window.autoCodez.getState();
    return state.chats.find((chat) => chat.id === chatId) || null;
  }, created.id);
  if (!persisted || persisted.providerId !== 'lm-studio' || persisted.model !== 'granite-local' || persisted.apiKeyId) {
    throw new Error(`LM Studio não persistiu corretamente no chat: ${JSON.stringify(persisted)}`);
  }
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (server) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await startFakeLmStudio();
    await createStateRoot();
    await startElectron();
    page.on('pageerror', (error) => pageErrors.push(errorText(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
    await verifyLmStudioChatSelection();
    await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-lm-studio-chat.png'), animations: 'disabled', fullPage: true });
    if (pageErrors.length || consoleErrors.length) {
      throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
    }
    await fs.writeFile(path.join(outputDir, 'lm-studio-chat.json'), `${JSON.stringify({ status: 'passed', pageErrors, consoleErrors }, null, 2)}\n`, 'utf8');
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'falha-lm-studio-chat.png'), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'lm-studio-chat-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
