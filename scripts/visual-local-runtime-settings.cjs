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
const testToken = 'visual-local-token';
let stateRoot;
let appProcess;
let browser;
let page;
let server;
let exitState;
let stderr = '';
let authenticatedRequestSeen = false;

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
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-local-runtime-settings-'));
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
    if (req.headers.authorization === `Bearer ${testToken}`) authenticatedRequestSeen = true;
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [{
          type: 'llm',
          key: 'runtime-settings-model',
          display_name: 'Runtime Settings Model',
          architecture: 'test',
          size_bytes: Math.round(1.2 * 1024 ** 3),
          params_string: '2B',
          max_context_length: 16384,
          capabilities: { vision: false, trained_for_tool_use: true },
        }],
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

async function openLocalAiSettings() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 15_000 });
  const button = page.locator('[data-local-ai-settings]');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  await page.locator('[data-local-runtime-settings-card]').waitFor({ state: 'visible', timeout: 15_000 });
}

async function assertSummaryDoesNotExposeSecret(expectedConfigured) {
  const result = await page.evaluate(async () => {
    const settings = await window.autoCodezLocalAi.listSettings();
    const lmStudio = settings.find((item) => item.runtimeId === 'lm-studio') || null;
    return { lmStudio, serialized: JSON.stringify(settings) };
  });
  if (!result.lmStudio || result.lmStudio.tokenConfigured !== expectedConfigured) {
    throw new Error(`Resumo do LM Studio não refletiu tokenConfigured=${expectedConfigured}: ${JSON.stringify(result.lmStudio)}`);
  }
  if (result.serialized.includes(testToken) || Object.prototype.hasOwnProperty.call(result.lmStudio, 'apiToken')) {
    throw new Error(`Token local vazou pelo preload: ${result.serialized}`);
  }
}

async function verifyRuntimeSettings() {
  await assertSummaryDoesNotExposeSecret(false);
  const lmRow = page.locator('[data-runtime-settings-row="lm-studio"]');
  await lmRow.waitFor({ state: 'visible', timeout: 10_000 });
  const endpoint = lmRow.locator('[data-runtime-endpoint="lm-studio"]');
  const token = lmRow.locator('[data-runtime-token="lm-studio"]');
  if (await endpoint.inputValue() !== 'http://127.0.0.1:1234') throw new Error(`Endpoint padrão inesperado: ${await endpoint.inputValue()}`);
  if (await token.count() !== 1) throw new Error('Campo de token opcional do LM Studio não foi exibido.');
  if (await page.locator('[data-runtime-token="ollama"]').count()) throw new Error('A UI inventou token para Ollama.');

  await token.fill(testToken);
  await lmRow.locator('[data-runtime-settings-save="lm-studio"]').click();
  await page.getByText('Token protegido configurado.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  await assertSummaryDoesNotExposeSecret(true);
  if (!authenticatedRequestSeen) throw new Error('O runtime LM Studio não passou a usar o token salvo após o refresh.');

  const pageText = await page.locator('.settings-overlay').innerText();
  if (pageText.includes(testToken)) throw new Error('Token local apareceu como texto na interface.');
  const visibleTokenInput = page.locator('[data-runtime-token="lm-studio"]');
  if (await visibleTokenInput.inputValue()) throw new Error('Campo de token foi reidratado com o segredo salvo.');

  await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-runtime-settings.png'), animations: 'disabled', fullPage: true });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await openLocalAiSettings();
  await page.getByText('Token protegido configurado.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  await assertSummaryDoesNotExposeSecret(true);
  if (await page.locator('[data-runtime-token="lm-studio"]').inputValue()) throw new Error('Token salvo reapareceu no input após reload.');
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
    await openLocalAiSettings();
    await verifyRuntimeSettings();
    if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
    await fs.writeFile(path.join(outputDir, 'local-runtime-settings.json'), `${JSON.stringify({ status: 'passed', authenticatedRequestSeen, pageErrors, consoleErrors }, null, 2)}\n`, 'utf8');
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'falha-local-runtime-settings.png'), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'local-runtime-settings-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
