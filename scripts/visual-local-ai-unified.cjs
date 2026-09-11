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
const testName = 'funcional-ia-local-unificada';
let stateRoot;
let appProcess;
let browser;
let page;
let exitState;
let stderr = '';
let ollamaServer;
let lmStudioServer;

function errorText(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Não foi possível reservar porta CDP.')));
    });
  });
}

async function createStateRoot() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-local-unified-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function environment() {
  const env = { ...process.env, AUTO_CODEZ_VISUAL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', HOME: stateRoot };
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
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{
        name: 'qwen3:8b', model: 'qwen3:8b', size: Math.round(5.2 * 1024 ** 3),
        details: { family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' },
      }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      await readJson(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], model_info: {} }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    ollamaServer.once('error', reject);
    ollamaServer.listen(11434, '127.0.0.1', resolve);
  });
}

async function startFakeLmStudio() {
  lmStudioServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{
        type: 'llm', key: 'granite-local', display_name: 'Granite Local', architecture: 'granite',
        quantization: { name: 'Q4_K_M' }, size_bytes: Math.round(1.8 * 1024 ** 3), params_string: '3B',
        max_context_length: 32768, capabilities: { vision: false, trained_for_tool_use: true },
      }] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    lmStudioServer.once('error', reject);
    lmStudioServer.listen(1234, '127.0.0.1', resolve);
  });
}

async function startElectron() {
  if (!electronExecutable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não foi definido.');
  const port = await reservePort();
  appProcess = spawn(electronExecutable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run'], {
    cwd: root, env: environment(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  appProcess.stderr?.setEncoding('utf8');
  appProcess.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-256 * 1024); });
  appProcess.once('exit', (code, signal) => { exitState = { code, signal }; });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exitState) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(exitState)}\n${stderr}`);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.waitForEvent('page', { timeout: 5000 });
      return;
    } catch {
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error('CDP não ficou disponível.');
}

async function updateManifest(result) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.results = Array.isArray(manifest.results) ? manifest.results.filter((item) => item?.name !== testName) : [];
  manifest.results.push(result);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function verifyDiagnostics() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  await page.locator('[data-local-ai-settings]').click();
  await page.getByText('Seu computador', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  const text = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
  for (const expected of ['Diagnóstico', 'Runtimes locais', 'Ollama', 'LM Studio', 'Modelos no computador']) {
    if (!text.toLowerCase().includes(expected.toLowerCase())) throw new Error(`Diagnóstico local não exibiu ${expected}.`);
  }
  await page.locator('[data-settings-close]').click();
}

async function verifyUnifiedChat() {
  const created = await page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'safe' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const chatItem = page.locator(`[data-chat="${created.id}"]`).first();
  await chatItem.waitFor({ state: 'visible', timeout: 15_000 });
  await chatItem.click();
  await page.locator(`[data-chat-settings="${created.id}"]`).first().click({ force: true });

  const ai = page.locator('#chat-available-ai');
  await ai.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#chat-available-ai option[value="local:unified"]')));
  if (await ai.locator('option[value="provider:ollama"]').count()) throw new Error('Ollama ainda aparece como IA separada.');
  if (await ai.locator('option[value="provider:lm-studio"]').count()) throw new Error('LM Studio ainda aparece como IA separada.');
  const first = await ai.locator('option').first().getAttribute('value');
  if (first !== 'local:unified') throw new Error(`IA local não ficou no topo: ${first}`);
  if (!((await ai.locator('option[value="local:unified"]').textContent()) || '').includes('Usar IA local')) throw new Error('Rótulo unificado incorreto.');

  await ai.selectOption('local:unified');
  const model = page.locator('#chat-model');
  await page.waitForFunction(() => [...document.querySelectorAll('#chat-model option')].some((option) => option.textContent?.includes('Qwen 3 8B')));
  const qwen8 = model.locator('option').filter({ hasText: 'Qwen 3 8B' });
  if (await qwen8.count() !== 1) throw new Error(`Qwen 3 8B deveria aparecer uma única vez, apareceu ${await qwen8.count()}.`);
  if (await model.locator('option').filter({ hasText: 'Granite Local' }).count() !== 1) throw new Error('Modelo instalado do LM Studio não entrou na lista unificada.');

  await model.selectOption('qwen3:8b');
  const save = page.locator('#save-available-ai-settings');
  await page.waitForFunction(() => !document.querySelector('#save-available-ai-settings')?.hasAttribute('disabled'));
  await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-unificada.png'), animations: 'disabled' });
  await save.click();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const persisted = await page.evaluate(async (chatId) => (await window.autoCodez.getState()).chats.find((chat) => chat.id === chatId) || null, created.id);
  if (!persisted || persisted.providerId !== 'ollama' || persisted.model !== 'qwen3:8b') throw new Error(`Backend local não foi persistido corretamente: ${JSON.stringify(persisted)}`);
}

async function runTest() {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await verifyDiagnostics();
  await verifyUnifiedChat();
  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (ollamaServer) await new Promise((resolve) => ollamaServer.close(resolve)).catch(() => {});
  if (lmStudioServer) await new Promise((resolve) => lmStudioServer.close(resolve)).catch(() => {});
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  try {
    await startFakeOllama();
    await startFakeLmStudio();
    await createStateRoot();
    await startElectron();
    await runTest();
    await updateManifest({ name: testName, status: 'passed' });
  } catch (error) {
    const message = errorText(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'local-ai-unified-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
