const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_LOCAL_ATTACHMENT_DIR || 'artifacts/local-attachment-chat');
const executable = (process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE || '').trim();
const llamaServerExe = (process.env.AUTO_CODEZ_LOCAL_TEXT_SERVER_EXE || '').trim();
const textModelPath = (process.env.AUTO_CODEZ_LOCAL_TEXT_MODEL || '').trim();
const modelId = 'qwen2.5-1.5b-real';
const sourceUrl = 'https://en.wikipedia.org/wiki/Electron_(software_framework)';

let stateRoot, appProcess, browser, page, proxyServer, textProcess;
let textPort = 0;
let lastInferenceRequest;
let lastInferenceRawResponse = '';
let appStderr = '';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Porta local inválida.')));
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function waitHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('Runtime local encerrou antes de ficar pronto: ' + child.exitCode);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await delay(350);
  }
  throw new Error('Runtime local não ficou pronto: ' + (lastError instanceof Error ? lastError.message : String(lastError)));
}

async function startTextModel() {
  if (!llamaServerExe || !textModelPath) throw new Error('Modelo textual local não configurado.');
  textPort = await reservePort();
  const stdout = await fs.open(path.join(outputDir, 'text-model.stdout.log'), 'w');
  const stderr = await fs.open(path.join(outputDir, 'text-model.stderr.log'), 'w');
  textProcess = spawn(llamaServerExe, [
    '--model', textModelPath,
    '--alias', modelId,
    '--host', '127.0.0.1',
    '--port', String(textPort),
    '--ctx-size', '8192',
    '--jinja',
    '--threads', '4'
  ], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', stdout.fd, stderr.fd]
  });
  textProcess.once('exit', () => {
    void stdout.close().catch(() => {});
    void stderr.close().catch(() => {});
  });
  await waitHealth('http://127.0.0.1:' + textPort + '/health', textProcess, 90000);
  const warmup = await fetch('http://127.0.0.1:' + textPort + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      stream: false,
      temperature: 0,
      max_tokens: 96,
      messages: [{ role: 'user', content: 'Explique em uma frase o que é um framework de software.' }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  const warmupData = await warmup.json().catch(() => ({}));
  const warmupText = warmupData?.choices?.[0]?.message?.content;
  if (!warmup.ok || typeof warmupText !== 'string' || warmupText.trim().length < 10) {
    throw new Error('Modelo textual local não respondeu ao warm-up: ' + JSON.stringify(warmupData));
  }
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function startLmStudioProxy() {
  proxyServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/api/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [{
            type: 'llm',
            key: modelId,
            display_name: 'Qwen2.5 1.5B · inferência real',
            architecture: 'qwen2',
            quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
            size_bytes: 1120000000,
            params_string: '1.5B',
            max_context_length: 8192,
            capabilities: { vision: false, trained_for_tool_use: false }
          }]
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const raw = await readBody(req);
        lastInferenceRequest = JSON.parse(raw || '{}');
        const boundedRequest = {
          ...lastInferenceRequest,
          max_tokens: 768,
          temperature: 0.2,
        };
        const upstream = await fetch('http://127.0.0.1:' + textPort + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(boundedRequest),
          signal: AbortSignal.timeout(180000)
        });
        const headers = {};
        const type = upstream.headers.get('content-type');
        if (type) headers['Content-Type'] = type;
        res.writeHead(upstream.status, headers);
        if (!upstream.body) { res.end(); return; }
        const readable = Readable.fromWeb(upstream.body);
        readable.on('data', (chunk) => {
          lastInferenceRawResponse = (lastInferenceRawResponse + chunk.toString('utf8')).slice(-262144);
        });
        readable.pipe(res);
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
    proxyServer.once('error', reject);
    proxyServer.listen(1234, '127.0.0.1', resolve);
  });
}

async function captureSource() {
  const imagePath = path.join(outputDir, 'fonte-web-electron-wikipedia.png');
  let webBrowser;
  try {
    webBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    webBrowser = await chromium.launch({ channel: 'msedge', headless: true });
  }
  try {
    const webPage = await webBrowser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
    await webPage.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await webPage.locator('#firstHeading').waitFor({ state: 'visible', timeout: 20000 });
    await webPage.evaluate(() => {
      document.querySelectorAll('.vector-sticky-header, .vector-page-toolbar-container, .mw-footer-container').forEach((node) => node.remove());
      window.scrollTo(0, 0);
    });
    await webPage.screenshot({ path: imagePath, animations: 'disabled' });
  } finally {
    await webBrowser.close();
  }
  return imagePath;
}

function putImageOnClipboard(imagePath) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [System.Drawing.Image]::FromFile($env:AUTO_CODEZ_E2E_CLIPBOARD_IMAGE)',
    'try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }'
  ];
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-STA', '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { AUTO_CODEZ_E2E_CLIPBOARD_IMAGE: imagePath })
  });
  if (result.status !== 0) throw new Error('Falha ao colocar imagem no clipboard: ' + (result.stderr || result.stdout));
}

async function createState() {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-real-attachment-chat-'));
  if (process.platform === 'win32') {
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Roaming'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'AppData', 'Local'), { recursive: true });
  }
}

function electronEnvironment() {
  const env = Object.assign({}, process.env, {
    AUTO_CODEZ_VISUAL_TEST: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    HOME: stateRoot
  });
  delete env.AUTO_CODEZ_VISUAL_ATTACHMENT_FIXTURE;
  delete env.LM_API_TOKEN;
  if (process.platform === 'win32') {
    env.USERPROFILE = stateRoot;
    env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local');
  }
  return env;
}

async function startElectron() {
  if (!executable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não definido.');
  const port = await reservePort();
  appProcess = spawn(executable, [
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run'
  ], {
    cwd: root,
    env: electronEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  appProcess.stderr.setEncoding('utf8');
  appProcess.stderr.on('data', (chunk) => { appStderr = (appStderr + String(chunk)).slice(-262144); });

  const endpoint = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 60000;
  let lastError;
  while (Date.now() < deadline) {
    if (appProcess.exitCode !== null) throw new Error('Electron encerrou: ' + appProcess.exitCode + '\n' + appStderr);
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
      const context = browser.contexts()[0];
      if (!context) throw new Error('Contexto Electron indisponível.');
      page = context.pages().find((item) => !item.url().startsWith('devtools://'));
      if (!page) page = await context.waitForEvent('page', { timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      browser = undefined;
      await delay(300);
    }
  }
  throw lastError || new Error('Renderer Electron indisponível.');
}

async function selectModel() {
  const created = await page.evaluate(() => window.autoCodez.createChat({ intelligence: 'normal', permissionLevel: 'read-only' }));
  if (!created || !created.id) throw new Error('Não foi possível criar o chat E2E.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('[data-chat="' + created.id + '"]').first().click();

  const settings = page.locator('[data-chat-settings="' + created.id + '"]').first();
  await settings.waitFor({ state: 'attached', timeout: 10000 });
  await settings.click({ force: true });
  const ai = page.locator('#chat-available-ai');
  await ai.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#chat-available-ai option[value="local:unified"]')));
  await ai.selectOption('local:unified');
  await page.waitForFunction(() => document.querySelector('#chat-local-model-state')?.dataset.localUnifiedReady === 'true', undefined, { timeout: 20000 });

  const model = page.locator('#chat-model');
  const option = model.locator('option').filter({ hasText: 'Qwen2.5 1.5B' });
  await option.waitFor({ state: 'attached', timeout: 15000 });
  const value = await option.getAttribute('value');
  if (!value) throw new Error('Modelo local real ficou sem ID.');
  await model.selectOption(value);
  await page.waitForFunction(() => !document.querySelector('#save-available-ai-settings')?.hasAttribute('disabled'));
  await page.locator('#save-available-ai-settings').click();
  await page.waitForFunction(() => !document.querySelector('#modal-root')?.firstElementChild, undefined, { timeout: 15000 });
  await page.waitForFunction(async (chatId) => {
    const chat = (await window.autoCodez.getState()).chats.find((item) => item.id === chatId);
    return chat?.providerId === 'lm-studio' && chat.model === 'qwen2.5-1.5b-real';
  }, created.id, { timeout: 30000 });
  return created.id;
}

function hitsFor(answer) {
  const text = answer.toLowerCase();
  return ['electron', 'wikipedia', 'framework', 'javascript', 'chromium', 'node.js', 'node', 'desktop', 'github', 'cross-platform']
    .filter((term) => text.includes(term));
}

async function testPasteAndAnswer(chatId, sourcePath) {
  putImageOnClipboard(sourcePath);
  const prompt = page.locator('#prompt');
  await prompt.click();
  await page.keyboard.press('Control+V');

  const tray = page.locator('#attachment-tray');
  await tray.waitFor({ state: 'visible', timeout: 20000 });
  await tray.locator('.composer-attachment-preview').first().waitFor({ state: 'visible', timeout: 10000 });
  const cardText = await tray.locator('.composer-attachment').first().innerText();
  if (!/clipboard-\d+\.png/i.test(cardText)) throw new Error('Ctrl+V não criou anexo: ' + cardText);
  await page.screenshot({ path: path.join(outputDir, 'funcional-ctrl-v-imagem-web.png'), animations: 'disabled' });

  const question = 'Sobre o que é essa imagem? Qual o conteúdo dela?';
  await prompt.fill(question);
  await page.keyboard.press('Enter');

  const analysisActivity = page.locator('.activity-line').filter({ hasText: 'Analisando imagem anexada' }).last();
  await analysisActivity.waitFor({ state: 'visible', timeout: 30_000 });
  const activityText = await page.locator('.activity-card').innerText();
  if (/OCR|llama\.cpp|visão local|indexando|clipboard|SmolVLM/i.test(activityText)) {
    throw new Error('Timeline de imagem expôs detalhes técnicos internos: ' + activityText);
  }
  await page.screenshot({ path: path.join(outputDir, 'funcional-atividade-imagem-unificada.png'), animations: 'disabled', fullPage: true });

  const sentPreview = page.locator('#messages .message.user .message-attachment-preview').last();
  await sentPreview.waitFor({ state: 'visible', timeout: 30_000 });
  const sentPreviewSrc = await sentPreview.getAttribute('src');
  if (!sentPreviewSrc?.startsWith('data:image/')) throw new Error('Mensagem enviada não renderizou a miniatura persistida da imagem.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-imagem-enviada-no-historico.png'), animations: 'disabled', fullPage: true });

  const providerDeadline = Date.now() + 8 * 60_000;
  while (!lastInferenceRequest && Date.now() < providerDeadline) {
    await delay(500);
  }
  if (!lastInferenceRequest) {
    throw new Error('O pipeline não alcançou o modelo textual local dentro de 8 minutos.');
  }

  let chat;
  let answer = '';
  const answerDeadline = Date.now() + 2 * 60_000;
  while (Date.now() < answerDeadline) {
    chat = await page.evaluate(async (id) => (await window.autoCodez.getState()).chats.find((item) => item.id === id), chatId);
    answer = [...(chat?.messages || [])].reverse().find((message) => message.role === 'assistant')?.content?.trim() || '';
    if (answer.length >= 80) break;
    await delay(400);
  }
  if (!answer) throw new Error('O modelo local recebeu a requisição, mas nenhuma resposta foi persistida no chat.');
  const hits = hitsFor(answer);
  if (hits.length < 3) throw new Error('Resposta local pouco relacionada à imagem. hits=' + JSON.stringify(hits) + ' answer=' + answer);

  const requestText = JSON.stringify(lastInferenceRequest || {});
  await fs.writeFile(path.join(outputDir, 'request-real-local.json'), JSON.stringify(lastInferenceRequest || {}, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'response-sse-real-local.txt'), lastInferenceRawResponse || '[sem SSE capturada]', 'utf8');
  if (/image_url|data:image\//i.test(requestText)) throw new Error('Modelo text-only recebeu imagem nativa.');
  if (!/Electron/i.test(requestText)) throw new Error('Conteúdo derivado da imagem não chegou ao modelo local.');
  if (!/(Texto reconhecido na imagem|Descrição visual)/i.test(requestText)) throw new Error('OCR/descrição visual não chegou ao request local.');

  await page.locator('#messages .message.assistant').last().waitFor({ state: 'visible', timeout: 20000 });
  await page.screenshot({ path: path.join(outputDir, 'funcional-ia-local-entendendo-imagem-web.png'), animations: 'disabled', fullPage: true });
  await fs.writeFile(path.join(outputDir, 'resposta-ia-local.txt'), answer, 'utf8');
  await fs.writeFile(path.join(outputDir, 'diagnostico.json'), JSON.stringify({
    sourceUrl,
    question,
    answer,
    semanticHits: hits,
    requestContainedNativeImage: /image_url|data:image\//i.test(requestText),
    requestContainedDerivedContext: /(Texto reconhecido na imagem|Descrição visual)/i.test(requestText)
  }, null, 2), 'utf8');
}

async function cleanup() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  killTree(appProcess?.pid);
  if (proxyServer) await new Promise((resolve) => proxyServer.close(() => resolve())).catch(() => {});
  killTree(textProcess?.pid);
  if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await startTextModel();
    await startLmStudioProxy();
    const sourcePath = await captureSource();
    await createState();
    await startElectron();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30000 });
    const chatId = await selectModel();
    await testPasteAndAnswer(chatId, sourcePath);
    if (pageErrors.length || consoleErrors.length) throw new Error('Erros no renderer: ' + JSON.stringify({ pageErrors, consoleErrors }));
  } catch (error) {
    const message = error instanceof Error ? error.name + ': ' + error.message : String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'falha-real-local-attachment-chat.png'), animations: 'disabled', fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(outputDir, 'erro.txt'), message + '\n\n' + appStderr, 'utf8').catch(() => {});
    await fs.writeFile(path.join(outputDir, 'debug-request.json'), JSON.stringify(lastInferenceRequest || {}, null, 2), 'utf8').catch(() => {});
    await fs.writeFile(path.join(outputDir, 'debug-response.txt'), lastInferenceRawResponse || '[sem resposta SSE capturada]', 'utf8').catch(() => {});
    console.error('Última resposta SSE:', lastInferenceRawResponse.slice(-12000));
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
