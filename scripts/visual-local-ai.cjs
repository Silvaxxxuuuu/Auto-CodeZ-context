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
let lmStudioServer;
const installedModels = new Set(['qwen3:8b', 'llava:latest']);

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
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-local-ai-'));
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

function fakeModel(model) {
  if (model === 'qwen3:8b') return { name: model, model, size: Math.round(5.2 * 1024 ** 3), details: { family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' } };
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
        const capabilities = model.startsWith('qwen3:') ? ['completion', 'tools', 'thinking'] : model === 'llava:latest' ? ['completion', 'vision'] : [];
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

async function startFakeLmStudio() {
  lmStudioServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [
        { type: 'llm', key: 'granite-local', display_name: 'Granite Local', architecture: 'granite', quantization: { name: 'Q4_K_M', bits_per_weight: 4 }, size_bytes: Math.round(1.8 * 1024 ** 3), params_string: '3B', max_context_length: 32768, capabilities: { vision: false, trained_for_tool_use: true } },
        { type: 'embedding', key: 'embedding-local', display_name: 'Embedding Local', size_bytes: Math.round(0.3 * 1024 ** 3), max_context_length: 8192 },
      ] }));
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

async function verifyLocalAiDiagnostics() {
  await page.locator('#ac-app-settings').click();
  await page.locator('.settings-overlay').waitFor({ state: 'visible' });
  const localAiButton = page.locator('[data-local-ai-settings]');
  await localAiButton.waitFor({ state: 'visible', timeout: 10_000 });
  await localAiButton.click();
  await page.getByText('Seu computador', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });

  const snapshot = await page.evaluate(() => window.autoCodezLocalAi.snapshot());
  const ollama = snapshot.runtimes.find((item) => item.id === 'ollama');
  const lmStudio = snapshot.runtimes.find((item) => item.id === 'lm-studio');
  if (!ollama?.available || !lmStudio?.available) throw new Error(`Runtimes locais não conectaram: ${JSON.stringify(snapshot.runtimes)}`);
  if (lmStudio.operations.install !== true || lmStudio.operations.cancelInstall !== false || lmStudio.operations.remove !== false) throw new Error(`Capacidades LM Studio incorretas: ${JSON.stringify(lmStudio.operations)}`);

  const bodyText = (await page.locator('.settings-body').innerText()).replace(/\s+/g, ' ');
  for (const expected of ['Diagnóstico', 'Runtimes locais', 'Ollama', 'LM Studio', 'Modelos no computador', 'qwen3:8b', 'llava:latest', 'Granite Local', 'Memória RAM', 'Armazenamento livre', 'configurações de um chat']) {
    if (!bodyText.toLowerCase().includes(expected.toLowerCase())) throw new Error(`IA Local não exibiu ${expected}: ${bodyText}`);
  }
  if (bodyText.includes('Catálogo local') || page.locator('[data-local-ai-action="install"]').count() && await page.locator('[data-local-ai-action="install"]').count()) {
    throw new Error('Settings voltou a ser o fluxo principal de instalação de modelos locais.');
  }
  if (bodyText.includes('Embedding Local')) throw new Error('Embedding do LM Studio vazou para o inventário de LLMs.');

  const lmInstalled = page.locator('[data-local-ai-installed-model="lm-studio:granite-local"]');
  await lmInstalled.waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await lmInstalled.innerText()).includes('Remoção externa')) throw new Error('Limite de remoção do LM Studio não ficou explícito.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-runtimes.png'), animations: 'disabled', fullPage: true });
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
  await page.locator(`[data-chat-settings="${created.id}"]`).first().click({ force: true });

  const aiSelect = page.locator('#chat-available-ai');
  await aiSelect.waitFor({ state: 'visible', timeout: 10_000 });
  if (await aiSelect.locator('option[value="provider:ollama"]').count() !== 1) throw new Error('Ollama não apareceu nas IAs do chat.');
  await aiSelect.selectOption('provider:ollama');
  const modelSelect = page.locator('#chat-model');
  await modelSelect.locator('option[value="qwen3:8b"]').waitFor({ state: 'attached', timeout: 15_000 });
  const snapshot = await page.evaluate(() => window.autoCodezLocalAi.snapshot());
  if (snapshot.recommendation?.runtimeId === 'ollama') {
    const recommendedOption = modelSelect.locator(`option[value="${snapshot.recommendation.modelId}"]`);
    if (await recommendedOption.count() !== 1 || !(await recommendedOption.textContent())?.toLowerCase().includes('recomendado')) {
      throw new Error(`Recomendação não apareceu no seletor para ${snapshot.recommendation.modelId}.`);
    }
  }

  await modelSelect.selectOption('qwen3:8b');
  const save = page.locator('#save-available-ai-settings');
  if (await save.isDisabled()) throw new Error('Modelo Ollama já instalado deveria liberar Salvar.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-no-chat.png'), animations: 'disabled' });
  await save.click();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction((chatId) => {
    const selected = document.querySelector(`.chat-item.selected[data-chat="${CSS.escape(chatId)}"]`);
    const header = document.querySelector('#chat-header');
    return Boolean(selected?.textContent?.includes('Ollama') && header?.textContent?.includes('Ollama') && header.textContent.includes('qwen3:8b'));
  }, created.id, { timeout: 15_000 });
  const persisted = await page.evaluate(async (chatId) => (await window.autoCodez.getState()).chats.find((chat) => chat.id === chatId) || null, created.id);
  if (!persisted || persisted.providerId !== 'ollama' || persisted.model !== 'qwen3:8b' || persisted.apiKeyId) throw new Error(`Ollama não persistiu no chat: ${JSON.stringify(persisted)}`);
}

async function runTest() {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await verifyLocalAiDiagnostics();
  await verifyChatCanSelectOllama();
  await page.screenshot({ path: path.join(outputDir, `${testName}.png`), animations: 'disabled', fullPage: true });
  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  if (ollamaServer) await new Promise((resolve) => ollamaServer.close(() => resolve())).catch(() => {});
  if (lmStudioServer) await new Promise((resolve) => lmStudioServer.close(() => resolve())).catch(() => {});
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
    await fs.writeFile(path.join(outputDir, 'local-ai-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {});
    await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();