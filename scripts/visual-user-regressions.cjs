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
if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE é obrigatório.');

let installedOllamaModel = '';
let ollamaServer;
let stateRoot;
let appProcess;
let browser;
let page;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Porta CDP inválida.')));
    });
  });
}

async function prepareState() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-user-regressions-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function environment() {
  const env = { ...process.env, HOME: stateRoot, AUTO_CODEZ_VISUAL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
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
        const models = installedOllamaModel ? [{ name: installedOllamaModel, model: installedOllamaModel, size: 523 * 1024 ** 2, details: { parameter_size: '0.6B', quantization_level: 'Q4_K_M', family: 'qwen3' } }] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/pull') {
        const body = await readJson(req);
        if (body.model !== 'qwen3:0.6b') throw new Error(`Modelo inesperado: ${String(body.model)}`);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'downloading', total: 100, completed: 45 })}\n`);
        installedOllamaModel = body.model;
        res.end(`${JSON.stringify({ status: 'success', total: 100, completed: 100 })}\n`);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    ollamaServer.once('error', reject);
    ollamaServer.listen(11434, '127.0.0.1', resolve);
  });
}

async function startElectron() {
  const cdpPort = await reservePort();
  appProcess = spawn(executable, [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--no-first-run'], { cwd: root, env: environment(), windowsHide: true, stdio: 'ignore' });
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      page = context?.pages().find((candidate) => !candidate.url().startsWith('devtools://'));
      if (!page && context) page = await context.waitForEvent('page', { timeout: 5000 });
      if (page) return;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await delay(300);
    }
  }
  throw lastError || new Error('Renderer indisponível.');
}

async function verifyTerminalSessions() {
  await page.locator('.terminal-rail-button').click();
  await page.locator('.terminal-panel.open').waitFor({ state: 'visible' });
  await page.waitForFunction(async () => (await window.autoCodez.terminal.listSessions()).some((session) => session.shell === 'powershell'));
  const shellSelect = page.locator('#terminal-shell');
  await shellSelect.selectOption('cmd');
  await page.waitForFunction(async () => (await window.autoCodez.terminal.listSessions()).some((session) => session.shell === 'cmd'));
  const sessions = await page.evaluate(() => window.autoCodez.terminal.listSessions());
  const powershell = sessions.find((session) => session.shell === 'powershell');
  const cmd = sessions.find((session) => session.shell === 'cmd');
  if (!powershell || !cmd) throw new Error('As duas sessões não foram criadas.');

  for (let i = 0; i < 6; i += 1) {
    await shellSelect.selectOption(i % 2 === 0 ? 'powershell' : 'cmd');
  }
  const afterSelectorSwitches = await page.evaluate(() => window.autoCodez.terminal.listSessions());
  if (afterSelectorSwitches.length !== sessions.length) throw new Error(`Alternar CMD/PowerShell criou sessões duplicadas: ${sessions.length} -> ${afterSelectorSwitches.length}.`);

  await page.evaluate(async ({ powershellId, cmdId }) => {
    await window.autoCodez.terminal.writeInput({ sessionId: powershellId, data: 'git --version\r' });
    await window.autoCodez.terminal.writeInput({ sessionId: cmdId, data: 'git --version\r' });
  }, { powershellId: powershell.id, cmdId: cmd.id });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 8; i += 1) {
    await page.locator(`[data-terminal-session="${cmd.id}"]`).click();
    await page.locator(`[data-terminal-session="${powershell.id}"]`).click();
  }
  const activeHosts = await page.locator('.terminal-session-host.active').count();
  if (activeHosts !== 1) throw new Error(`Esperava uma superfície xterm ativa, recebeu ${activeHosts}.`);
  const cmdText = await page.locator(`[data-terminal-host="${cmd.id}"]`).innerText();
  const psText = await page.locator(`[data-terminal-host="${powershell.id}"]`).innerText();
  const occurrences = (value, needle) => value.split(needle).length - 1;
  if (occurrences(cmdText, 'git version') > 1 || occurrences(psText, 'git version') > 1) throw new Error('A troca de abas duplicou a saída do terminal.');

  const panel = page.locator('.terminal-panel');
  const before = await panel.boundingBox();
  const handle = page.locator('#terminal-resize-handle');
  const box = await handle.boundingBox();
  if (!before || !box) throw new Error('Não foi possível medir o redimensionamento do terminal.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 5 });
  await page.mouse.up();
  const after = await panel.boundingBox();
  if (!after || after.height < before.height + 50) throw new Error(`Terminal não respondeu ao resize: ${before.height} -> ${after?.height}.`);
  await page.screenshot({ path: path.join(outputDir, 'funcional-terminal-sessoes.png'), animations: 'disabled' });
}

async function verifyLocalChatInstallFlow() {
  await page.locator('#terminal-close').click().catch(() => {});
  await page.locator('[data-action="new-chat"]').click();
  const settings = page.locator('#chat-header [data-chat-settings]').first();
  await settings.waitFor({ state: 'visible', timeout: 15_000 });
  await settings.click();

  const ai = page.locator('#chat-available-ai');
  await ai.waitFor({ state: 'visible' });
  await ai.selectOption('provider:ollama');
  const model = page.locator('#chat-model');
  await model.locator('option[value="qwen3:0.6b"]').waitFor({ state: 'attached', timeout: 15_000 });
  await model.selectOption('qwen3:0.6b');
  const save = page.locator('#save-available-ai-settings');
  if (!(await save.isDisabled())) throw new Error('Salvar deveria permanecer bloqueado antes da instalação.');
  const install = page.locator('[data-local-model-install="ollama:qwen3:0.6b"]');
  await install.waitFor({ state: 'visible', timeout: 10_000 });
  await install.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('#save-available-ai-settings');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 20_000 });
  if (await page.locator('[data-local-model-install="ollama:qwen3:0.6b"]').count()) throw new Error('Botão de instalar permaneceu após instalação concluída.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-modelo-local-no-chat.png'), animations: 'disabled' });
}

async function verifyNoHistoricalGraphInjection() {
  if (await page.locator('.execution-graph-history-host').count()) throw new Error('Execution Graph histórico ainda foi injetado no fluxo do chat.');
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await prepareState();
  await startFakeOllama();
  await startElectron();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await verifyTerminalSessions();
  await verifyLocalChatInstallFlow();
  await verifyNoHistoricalGraphInjection();
  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${pageErrors.length}, console=${consoleErrors.length}.`);
  await fs.writeFile(path.join(outputDir, 'user-regressions.json'), `${JSON.stringify({ pageErrors, consoleErrors, installedOllamaModel }, null, 2)}\n`, 'utf8');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (page && !page.isClosed()) await page.close({ runBeforeUnload: true }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await delay(300);
  killTree(appProcess?.pid);
  if (ollamaServer) await new Promise((resolve) => ollamaServer.close(() => resolve()));
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
});
