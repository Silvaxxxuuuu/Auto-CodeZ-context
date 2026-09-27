const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, process.env.AUTO_CODEZ_VISUAL_DIR || 'artifacts/visual');
const electronExecutable = process.env.AUTO_CODEZ_ELECTRON_EXECUTABLE?.trim();
const manifestPath = path.join(outputDir, 'manifest.json');
const testName = 'funcional-plugin-platform';
let stateRoot, tunnelFixtureBin, bridgeServer, bridgePort, appProcess, browser, page, exitState;
let stderr = '';
function errorText(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
async function reservePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.unref(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = address && typeof address === 'object' ? address.port : 0; server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error('Não foi possível reservar uma porta.'))); }); }); }
async function startBridgeServer() { bridgeServer = http.createServer((request, response) => { if (request.method === 'GET' && request.url === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, source: 'visual-plugin-bridge' })); return; } response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'not found' })); }); await new Promise((resolve, reject) => { bridgeServer.once('error', reject); bridgeServer.listen(0, '127.0.0.1', () => { const address = bridgeServer.address(); bridgePort = address && typeof address === 'object' ? address.port : 0; if (!bridgePort || bridgePort < 1024) reject(new Error('Bridge visual recebeu porta inválida.')); else resolve(); }); }); }
function pluginSource() { return `autoCodez.register({async activate(api){const bridge=await api.bridge.request({url:'http://127.0.0.1:${bridgePort}/health'});if(!bridge||bridge.status!==200||!String(bridge.body||'').includes('visual-plugin-bridge'))throw new Error('Bridge local não respondeu corretamente.');await api.settings.set('visual-mode','verified');const stored=await api.settings.get('visual-mode');if(stored!=='verified')throw new Error('Settings do plugin não persistiram.');await api.tools.register([{id:'external_action',description:'Execute a bounded action in the connected visual test application.',risk:'write',parameters:{type:'object',properties:{target:{type:'string'}},required:['target'],additionalProperties:false}}]);const job=await api.jobs.begin('Validando Plugin Platform');await api.jobs.update(job.id,{progress:.5,activity:'Sandbox e bridge validados'});await api.jobs.complete(job.id,'Runtime concluído');await api.activity.publish('Sandbox, settings, jobs, tools e bridge validados.','completed');},async deactivate(api){await api.activity.clear();},async invoke(method,payload){if(method!=='external_action')throw new Error('Método de plugin desconhecido.');return{ok:true,target:payload&&payload.input?payload.input.target:null,chatId:payload&&payload.context?payload.context.chatId:null};}});\n`; }
async function createPluginPackage(base) { const pluginRoot = path.join(base, 'plugins', 'visual.plugin'); await fs.mkdir(pluginRoot, { recursive: true }); await fs.writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({ apiVersion: 1, id: 'visual.plugin', name: 'Visual Sandbox Plugin', version: '1.0.0', description: 'Fixture real para validar lifecycle, grants, sandbox e capabilities.', publisher: 'Auto CodeZ CI', main: 'index.js', contributions: ['tool'], permissions: ['network:localhost', 'background:run', 'ai:tool'] }, null, 2)}\n`, 'utf8'); await fs.writeFile(path.join(pluginRoot, 'index.js'), pluginSource(), 'utf8'); }
async function prepareStateRoot() { stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-plugin-platform-')); tunnelFixtureBin = path.join(stateRoot, 'tunnel-bin'); await fs.mkdir(tunnelFixtureBin, { recursive: true }); if (process.platform === 'win32') { const sourcePath = path.join(tunnelFixtureBin, 'TunnelClientFixture.cs'); const executablePath = path.join(tunnelFixtureBin, 'tunnel-client.exe'); const source = `using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
public static class TunnelClientFixture {
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--version") {
      Console.WriteLine("tunnel-client v0.0.14");
      return 0;
    }
    if (args.Length > 0 && args[0] == "doctor") {
      Console.WriteLine("synthetic tunnel doctor ready");
      return 0;
    }
    if (args.Length > 0 && args[0] == "run") {
      string healthFile = null;
      for (int i = 1; i + 1 < args.Length; i++) {
        if (args[i] == "--health.url-file") {
          healthFile = args[i + 1];
          break;
        }
      }
      if (String.IsNullOrWhiteSpace(healthFile)) {
        Console.Error.WriteLine("missing health url file");
        return 3;
      }
      TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
      listener.Start();
      int port = ((IPEndPoint)listener.LocalEndpoint).Port;
      File.WriteAllText(healthFile, "http://127.0.0.1:" + port + "/");
      Console.WriteLine("synthetic tunnel ready");
      Console.Out.Flush();
      while (true) {
        TcpClient client = listener.AcceptTcpClient();
        try {
          NetworkStream stream = client.GetStream();
          byte[] request = new byte[4096];
          stream.Read(request, 0, request.Length);
          byte[] body = Encoding.UTF8.GetBytes("{\\\"ok\\\":true}");
          string header = "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + body.Length + "\\r\\nConnection: close\\r\\n\\r\\n";
          byte[] head = Encoding.ASCII.GetBytes(header);
          stream.Write(head, 0, head.Length);
          stream.Write(body, 0, body.Length);
          stream.Flush();
        } finally {
          client.Close();
        }
      }
    }
    Console.Error.WriteLine("unsupported synthetic tunnel command");
    return 2;
  }
}`; await fs.writeFile(sourcePath, source, 'utf8'); const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'); const compiled = spawnSync(csc, ['/nologo', '/target:exe', `/out:${executablePath}`, sourcePath], { windowsHide: true, encoding: 'utf8' }); if (compiled.status !== 0) throw new Error(`Não foi possível compilar tunnel-client.exe fixture: ${compiled.stderr || compiled.stdout || compiled.error || 'erro desconhecido'}`); const roaming = path.join(stateRoot, 'AppData', 'Roaming'); const local = path.join(stateRoot, 'AppData', 'Local'); await Promise.all([fs.mkdir(roaming, { recursive: true }), fs.mkdir(local, { recursive: true })]); await Promise.all([createPluginPackage(path.join(roaming, 'Auto CodeZ')), createPluginPackage(path.join(roaming, 'auto-codez'))]); } else { const script = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tunnel-client v0.0.14"; exit 0; fi\nif [ "$1" = "doctor" ]; then echo "synthetic tunnel doctor ready"; exit 0; fi\necho "unsupported synthetic tunnel command" >&2\nexit 2\n'; const executable = path.join(tunnelFixtureBin, 'tunnel-client'); await fs.writeFile(executable, script, { encoding: 'utf8', mode: 0o755 }); const config = path.join(stateRoot, '.config'); const cache = path.join(stateRoot, '.cache'); await Promise.all([fs.mkdir(config, { recursive: true }), fs.mkdir(cache, { recursive: true })]); await Promise.all([createPluginPackage(path.join(config, 'Auto CodeZ')), createPluginPackage(path.join(config, 'auto-codez'))]); } }
function environment() { const env = { ...process.env, AUTO_CODEZ_VISUAL_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', CONTROL_PLANE_API_KEY: 'sk-visual-tunnel-connection-key-1234567890', HOME: stateRoot, PATH: [tunnelFixtureBin, process.env.PATH || process.env.Path || ''].filter(Boolean).join(path.delimiter) }; if (process.platform === 'win32') { env.USERPROFILE = stateRoot; env.APPDATA = path.join(stateRoot, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(stateRoot, 'AppData', 'Local'); } else { env.XDG_CONFIG_HOME = path.join(stateRoot, '.config'); env.XDG_CACHE_HOME = path.join(stateRoot, '.cache'); } return env; }
async function startElectron() { if (!electronExecutable) throw new Error('AUTO_CODEZ_ELECTRON_EXECUTABLE não foi definido.'); const port = await reservePort(); appProcess = spawn(electronExecutable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run'], { cwd: root, env: environment(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); appProcess.stderr?.setEncoding('utf8'); appProcess.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-256 * 1024); }); appProcess.once('exit', (code, signal) => { exitState = { code, signal }; }); const endpoint = `http://127.0.0.1:${port}`; const deadline = Date.now() + 60000; while (Date.now() < deadline) { if (exitState) throw new Error(`Electron encerrou antes do CDP: ${JSON.stringify(exitState)}\n${stderr}`); try { browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 }); const context = browser.contexts()[0]; if (!context) throw new Error('Contexto Chromium indisponível.'); page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://')) || await context.waitForEvent('page', { timeout: 5000 }); return; } catch { if (browser) await browser.close().catch(() => {}); browser = undefined; await new Promise((resolve) => setTimeout(resolve, 350)); } } throw new Error('CDP não ficou disponível.'); }
async function restartElectron() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appProcess?.pid && !exitState) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else appProcess.kill('SIGKILL');
  }
  appProcess = undefined;
  browser = undefined;
  page = undefined;
  exitState = undefined;
  stderr = '';
  await startElectron();
}
async function updateManifest(result) { let manifest = { results: [], pageErrors: [], consoleErrors: [] }; try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {} manifest.results = Array.isArray(manifest.results) ? manifest.results.filter((item) => item?.name !== testName) : []; manifest.results.push(result); await fs.mkdir(outputDir, { recursive: true }); await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); }
async function verifyPackagedMcpStdioBridge() {
  if (!electronExecutable) throw new Error('Executável empacotado ausente para validar MCP stdio bridge.');
  if (process.platform !== 'win32') return;
  const appDataRoot = environment().APPDATA;
  if (!appDataRoot) throw new Error('APPDATA ausente no ambiente do teste MCP.');
  const digest = crypto.createHash('sha256').update(path.resolve(appDataRoot)).digest('hex').slice(0, 24);
  const brokerAddress = `\\\\.\\pipe\\auto-codez-mcp-${digest}`;
  const bridgeScript = path.join(path.dirname(electronExecutable), 'resources', 'mcp-bridge.ps1');
  await fs.access(bridgeScript);

  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', bridgeScript,
      '-BrokerAddress', brokerAddress,
      '-AppPath', electronExecutable,
      '-ClientId', 'codex',
    ], { cwd: root, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', childStderr = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      if (child.pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.unref();
        } catch {}
      }
      finish(new Error(`MCP stdio bridge empacotado excedeu o tempo limite. stdout=${stdout} stderr=${childStderr}`));
    }, 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { childStderr = `${childStderr}${chunk}`.slice(-65536); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`MCP stdio bridge empacotado encerrou com code=${code} signal=${signal}. stderr=${childStderr}`)); return; }
      const messages = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const response = messages.find((message) => message.id === 'packaged-bridge-tools');
      if (!response || !Array.isArray(response.result?.tools) || response.result.tools.length < 6) {
        finish(new Error(`MCP stdio bridge empacotado não retornou catálogo válido: stdout=${stdout} stderr=${childStderr}`));
        return;
      }
      finish();
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 'packaged-bridge-tools', method: 'tools/list', params: {} }) + '\n');
  });
}
async function runTest() {
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(errorText(error))); page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30000 });
  const failures = page.locator('#auto-codez-module-failures'); if (await failures.count()) throw new Error((await failures.first().innerText()).trim());
  await page.locator('.rail-button[data-panel="plugins"]').click(); await page.locator('[data-plugin-platform-owned]').waitFor({ state: 'visible', timeout: 15000 });
  const robloxItem = page.locator('[data-plugin-open="autocodez.roblox-studio-manager"]'); await robloxItem.waitFor({ state: 'visible', timeout: 15000 }); const robloxText = await robloxItem.innerText(); if (!robloxText.includes('Roblox Studio Manager')) throw new Error('Plugin Roblox built-in não foi descoberto no app empacotado.'); const builtIn = await page.evaluate(async () => { const current = await window.autoCodezPlugins?.snapshot(); return current?.plugins?.find((item) => item.id === 'autocodez.roblox-studio-manager') || null; }); if (!builtIn || builtIn.builtIn !== true || builtIn.hasMain !== true) throw new Error(`Identidade built-in do Roblox Studio Manager inválida: ${JSON.stringify(builtIn)}`); await robloxItem.click(); const robloxDetail = page.locator('[data-plugin-detail="autocodez.roblox-studio-manager"]'); await robloxDetail.waitFor({ state: 'visible', timeout: 10000 }); await robloxDetail.getByText('PLUGIN INTEGRADO', { exact: true }).waitFor({ state: 'visible' }); if (await robloxDetail.locator('[data-plugin-uninstall="autocodez.roblox-studio-manager"]').count()) throw new Error('Plugin Roblox built-in expôs ação de desinstalação.'); await robloxDetail.getByRole('button', { name: 'Voltar para a lista de plugins' }).click(); await robloxDetail.waitFor({ state: 'detached', timeout: 10000 });
  const listItem = page.locator('[data-plugin-open="visual.plugin"]'); await listItem.waitFor({ state: 'visible', timeout: 15000 });
  const listText = await listItem.innerText(); if (!listText.includes('Visual Sandbox Plugin')) throw new Error('Plugin fixture não foi descoberto na lista.'); if (!listText.includes('Fixture real para validar lifecycle, grants, sandbox e capabilities.')) throw new Error('Descrição compacta não foi exibida.');
  if (await page.locator('[data-plugin-id="visual.plugin"] [data-plugin-permissions],[data-plugin-id="visual.plugin"] [data-plugin-uninstall],[data-plugin-id="visual.plugin"] [data-plugin-enable]').count()) throw new Error('Lista compacta expôs ações que pertencem aos detalhes.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform-lista.png'), animations: 'disabled' });
  await listItem.click(); let detail = page.locator('[data-plugin-detail="visual.plugin"]'); await detail.waitFor({ state: 'visible', timeout: 10000 }); if (!await detail.evaluate((element) => element.classList.contains('plugin-detail-overlay'))) throw new Error('Detalhes do plugin não abriram na superfície principal.'); if (!await page.locator('#nav-panel [data-plugin-open="visual.plugin"]').count()) throw new Error('Lista compacta deixou de existir ao abrir os detalhes.'); await detail.getByText('Visual Sandbox Plugin', { exact: true }).waitFor({ state: 'visible' }); await detail.getByText('Sobre este plugin', { exact: true }).waitFor({ state: 'visible' }); await detail.getByText('Estado e diagnóstico', { exact: true }).waitFor({ state: 'visible' }); await detail.getByText('Acesso solicitado', { exact: true }).waitFor({ state: 'visible' }); await detail.getByText('Integrações declaradas', { exact: true }).waitFor({ state: 'visible' }); await detail.getByText('Auto CodeZ CI', { exact: true }).first().waitFor({ state: 'visible' }); await detail.getByText('visual.plugin', { exact: true }).first().waitFor({ state: 'visible' }); await detail.locator('[data-plugin-permissions="visual.plugin"]').waitFor({ state: 'visible' }); await detail.locator('[data-plugin-uninstall="visual.plugin"]').waitFor({ state: 'visible' });
  if (await detail.locator('[data-plugin-enable="visual.plugin"]').count()) throw new Error('Plugin não deve ativar antes das permissões obrigatórias.');
  await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform-detalhes.png'), animations: 'disabled' });
  await detail.locator('[data-plugin-permissions="visual.plugin"]').click(); const modal = page.locator('.plugin-permission-modal'); await modal.waitFor({ state: 'visible', timeout: 10000 }); const modalLayerCheck = await modal.evaluate((element) => { const detailOverlay = document.querySelector('.plugin-detail-overlay'); const modalRoot = element.closest('#modal-root'); if (!detailOverlay || !modalRoot) return false; return Number.parseInt(getComputedStyle(modalRoot).zIndex || '0', 10) > Number.parseInt(getComputedStyle(detailOverlay).zIndex || '0', 10); }); if (!modalLayerCheck) throw new Error('Modal de configuração não está acima da página de detalhes do plugin.'); const permissions = modal.locator('[data-plugin-permission-value]'); if (await permissions.count() !== 3) throw new Error('Configuração não exibiu as três capabilities solicitadas.');
  for (let index = 0; index < await permissions.count(); index += 1) await permissions.nth(index).check(); const checked = await permissions.evaluateAll((inputs) => inputs.filter((input) => input.checked).map((input) => input.getAttribute('data-plugin-permission-value'))); if (checked.length !== 3) throw new Error(`Checkboxes não permaneceram marcados: ${JSON.stringify(checked)}`);
  await modal.locator('[data-plugin-save-permissions="visual.plugin"]').click(); await modal.waitFor({ state: 'detached', timeout: 10000 });
  const diagnostic = await page.evaluate(async () => { const current = await window.autoCodezPlugins?.snapshot(); const plugin = current?.plugins?.find((item) => item.id === 'visual.plugin'); return { requestedPermissions: plugin?.requestedPermissions || [], grantedPermissions: plugin?.grantedPermissions || [], missingPermissions: plugin?.missingPermissions || [], state: plugin?.state || null, detailText: document.querySelector('[data-plugin-detail="visual.plugin"]')?.textContent || '' }; });
  if (diagnostic.grantedPermissions.length !== 3 || diagnostic.missingPermissions.length !== 0) throw new Error(`Grants não persistiram: ${JSON.stringify(diagnostic)}; console=${JSON.stringify(consoleErrors)}`); if (!diagnostic.detailText.includes('3/3 autorizadas')) throw new Error(`Detalhes não refletiram grants: ${JSON.stringify(diagnostic)}`);
  detail = page.locator('[data-plugin-detail="visual.plugin"]'); await detail.locator('[data-plugin-enable="visual.plugin"]').waitFor({ state: 'visible', timeout: 10000 }); await detail.locator('[data-plugin-enable="visual.plugin"]').click();
  await page.locator('[data-plugin-detail="visual.plugin"] .plugin-platform-status.healthy').waitFor({ state: 'visible', timeout: 20000 }); await page.locator('[data-plugin-detail="visual.plugin"]').getByText('Sandbox, settings, jobs, tools e bridge validados.', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const sandbox = await page.evaluate(() => { const frames = [...document.querySelectorAll('iframe[aria-hidden="true"]')]; const frame = frames.find((item) => item.getAttribute('sandbox')?.includes('allow-scripts')); return frame ? { count: frames.length, sandbox: frame.getAttribute('sandbox'), hidden: frame.hidden } : null; }); if (!sandbox || sandbox.hidden !== true || sandbox.sandbox !== 'allow-scripts') throw new Error(`Sandbox visual não está restrito a allow-scripts: ${JSON.stringify(sandbox)}`);
  await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform.png'), animations: 'disabled' });
  await page.locator('[data-plugin-detail="visual.plugin"] [data-plugin-disable="visual.plugin"]').click(); await page.locator('[data-plugin-detail="visual.plugin"] .plugin-platform-status.disabled').getByText('Desativado', { exact: true }).waitFor({ state: 'visible', timeout: 10000 }); await page.waitForFunction(() => ![...document.querySelectorAll('iframe[aria-hidden="true"]')].some((frame) => frame.getAttribute('sandbox')?.includes('allow-scripts'))); await page.screenshot({ path: path.join(outputDir, 'funcional-plugin-platform-desativado.png'), animations: 'disabled' });
  await page.locator('[data-plugin-detail="visual.plugin"] [data-plugin-enable="visual.plugin"]').waitFor({ state: 'visible', timeout: 10000 }); await page.locator('[data-plugin-detail="visual.plugin"] [data-plugin-enable="visual.plugin"]').click(); await page.locator('[data-plugin-detail="visual.plugin"] .plugin-platform-status.healthy').waitFor({ state: 'visible', timeout: 20000 });
  await page.getByRole('button', { name: 'Voltar para a lista de plugins' }).click(); await page.locator('[data-plugin-detail="visual.plugin"]').waitFor({ state: 'detached', timeout: 10000 }); await page.locator('#nav-panel [data-plugin-open="visual.plugin"]').waitFor({ state: 'visible', timeout: 10000 });
  const mcpButton = page.locator('[data-mcp-mode]'); await mcpButton.waitFor({ state: 'visible', timeout: 10000 }); await mcpButton.click();
  const mcpMode = page.locator('#mcp-mode-root'); await mcpMode.waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Prepare o MCP Mode.', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-onboarding-ativacao.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Preparar MCP Mode' }).click();
  await mcpMode.getByText('Escolha suas primeiras conexões.', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  await mcpMode.locator('[data-mcp-client="codex"]').click();
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-onboarding-clientes.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Avançar' }).click();
  await mcpMode.getByText('Conclua suas conexões', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  const instructionLayout = await mcpMode.evaluate(() => {
    const codex = [...document.querySelectorAll('.mcp-guide-card')].find((card) => card.textContent?.includes('ChatGPT Codex'));
    const title = codex?.querySelector('.mcp-guide-head strong');
    const subtitle = codex?.querySelector('.mcp-guide-head small');
    const action = codex?.querySelector('[data-mcp-install-client-config="codex"]');
    if (!codex || !title || !subtitle || !(action instanceof HTMLElement)) return null;
    const titleRect = title.getBoundingClientRect();
    const subtitleRect = subtitle.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    const style = getComputedStyle(action);
    return {
      headingGap: subtitleRect.top - titleRect.bottom,
      actionRadius: style.borderRadius,
      actionBackground: style.backgroundColor,
      actionDisplay: style.display,
      actionHeight: actionRect.height,
    };
  });
  if (!instructionLayout || instructionLayout.headingGap < 3) throw new Error('Título e subtítulo do ChatGPT Codex continuam visualmente colados: ' + JSON.stringify(instructionLayout));
  const brandIconCheck = await mcpMode.evaluate(() => {
    const cards = [...document.querySelectorAll('.mcp-guide-card')];
    const icons = cards.map((card) => {
      const image = card.querySelector('.mcp-client-mark img');
      return { text: card.querySelector('.mcp-client-mark')?.textContent?.trim() || '', src: image?.getAttribute('src') || '', loaded: image instanceof HTMLImageElement ? image.complete && image.naturalWidth > 0 : false };
    });
    return { count: icons.length, icons };
  });
  if (brandIconCheck.count < 2 || brandIconCheck.icons.some((icon) => !icon.loaded || (!icon.src.endsWith('.svg') && !icon.src.startsWith('data:image/svg+xml')) || icon.text)) throw new Error('Ícones SVG locais dos clientes MCP não renderizaram corretamente: ' + JSON.stringify(brandIconCheck));

  if (instructionLayout.actionDisplay === 'none' || instructionLayout.actionRadius === '0px' || instructionLayout.actionBackground === 'rgba(0, 0, 0, 0)' || instructionLayout.actionHeight < 28) throw new Error('Ação de configuração automática do Codex não recebeu o tratamento visual esperado: ' + JSON.stringify(instructionLayout));
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-onboarding-instrucoes.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Finalizar' }).click();
  await mcpMode.getByText('MCP pronto', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Suas conexões', { exact: true }).waitFor({ state: 'visible' });
  const persistedMcpConnections = await page.evaluate(() => window.autoCodez.listMcpConnections());
  const persistedMcpClientIds = persistedMcpConnections.map((connection) => connection.clientId).sort();
  if (JSON.stringify(persistedMcpClientIds) !== JSON.stringify(['chatgpt', 'codex'])) throw new Error('Onboarding MCP não persistiu as conexões selecionadas no processo principal: ' + JSON.stringify(persistedMcpConnections));
  const hubConnectionSemantics = await mcpMode.evaluate(() => ({
    count: document.querySelector('.mcp-health-count')?.textContent?.trim() || '',
    availablePrimaryActions: document.querySelectorAll('.mcp-connection-card.available .mcp-primary-action').length,
    availableActions: [...document.querySelectorAll('.mcp-connection-card.available [data-mcp-connect-client]')].map((item) => item.textContent?.trim() || ''),
    configuredActions: [...document.querySelectorAll('.mcp-connection-card.configured [data-mcp-open-connection]')].map((item) => item.textContent?.trim() || ''),
  }));
  if (hubConnectionSemantics.count !== '2 conexões adicionadas') throw new Error('Resumo do hub continua tratando conexões adicionadas como conexões ativas: ' + JSON.stringify(hubConnectionSemantics));
  if (hubConnectionSemantics.availablePrimaryActions !== 0 || hubConnectionSemantics.availableActions.some((label) => !label.startsWith('Adicionar '))) throw new Error('Conexões disponíveis continuam competindo com a ação principal ou usando verbo impreciso: ' + JSON.stringify(hubConnectionSemantics));
  if (hubConnectionSemantics.configuredActions.some((label) => label !== 'Concluir conexão')) throw new Error('Ação das conexões ainda não conectadas não orienta o próximo passo: ' + JSON.stringify(hubConnectionSemantics));
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-hub.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Conectar ferramenta' }).click();
  await mcpMode.getByRole('dialog', { name: 'Conectar ferramenta' }).waitFor({ state: 'visible' });
  const discoveryGap = await mcpMode.locator('.mcp-connect-discovery').evaluate((element) => {
    const title = element.querySelector('strong');
    const detail = element.querySelector('small');
    if (!title || !detail) return -1;
    return detail.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
  });
  if (discoveryGap < 3) throw new Error('Título e descrição do painel Conectar ferramenta continuam encostados: gap=' + discoveryGap);
  await mcpMode.getByText('Conexões compatíveis', { exact: true }).waitFor({ state: 'visible' });
  const connectPanelActions = await mcpMode.locator('.mcp-connect-option em').allTextContents();
  if (!connectPanelActions.length || connectPanelActions.some((label) => label.trim() !== 'Adicionar')) throw new Error('Painel Conectar ferramenta ainda sugere conexão imediata antes da configuração: ' + JSON.stringify(connectPanelActions));
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-conectar-ferramenta.png'), animations: 'disabled' });
  await mcpMode.getByRole('dialog', { name: 'Conectar ferramenta' }).locator('[data-mcp-connect-client="cursor"]').click();
  await mcpMode.locator('[data-mcp-connection-detail="cursor"]').waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Conectar ao Cursor', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao Cursor', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const cursorConfigStatus = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('cursor'));
  if (cursorConfigStatus.state !== 'configured') throw new Error('Cursor não ficou configurado automaticamente: ' + JSON.stringify(cursorConfigStatus));
  const cursorConfig = JSON.parse(await fs.readFile(cursorConfigStatus.configPath, 'utf8'));
  const cursorServer = cursorConfig?.mcpServers?.['auto-codez'];
  if (!cursorServer || cursorServer.command !== 'powershell.exe' || !Array.isArray(cursorServer.args)) throw new Error('Configuração MCP do Cursor não contém servidor Auto CodeZ gerenciado: ' + JSON.stringify(cursorConfig));
  if (!cursorServer.args.includes('-File') || !cursorServer.args.includes('-BrokerAddress') || !cursorServer.args.includes('-AppPath') || !cursorServer.args.includes('-ClientId') || !cursorServer.args.includes('cursor')) throw new Error('Configuração MCP do Cursor não aponta para o bridge universal completo: ' + JSON.stringify(cursorServer));
  if (JSON.stringify(cursorServer).includes('Bearer ') || JSON.stringify(cursorServer).includes('bearerToken')) throw new Error('Configuração MCP do Cursor vazou credencial efêmera: ' + JSON.stringify(cursorServer));
  const bridgeArgumentIndex = cursorServer.args.indexOf('-File') + 1;
  if (bridgeArgumentIndex <= 0 || !cursorServer.args[bridgeArgumentIndex]) throw new Error('Configuração MCP do Cursor não contém caminho do helper empacotado.');
  await fs.access(cursorServer.args[bridgeArgumentIndex]);
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-cursor-configurado.png'), animations: 'disabled' });

  await mcpMode.getByRole('button', { name: 'Remover configuração' }).click();
  await mcpMode.getByText('Conectar ao Cursor', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  const cursorRemovedStatus = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('cursor'));
  if (cursorRemovedStatus.state !== 'not-configured') throw new Error('Cursor permaneceu configurado após remover configuração gerenciada: ' + JSON.stringify(cursorRemovedStatus));
  const cursorRegistryAfterRemove = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'cursor');
  if (!cursorRegistryAfterRemove || cursorRegistryAfterRemove.setupState !== 'added' || cursorRegistryAfterRemove.configuredAt || cursorRegistryAfterRemove.lastConnectedAt) {
    throw new Error('Registro MCP do Cursor ficou inconsistente após remoção: ' + JSON.stringify(cursorRegistryAfterRemove));
  }
  const cursorConfigAfterRemove = JSON.parse(await fs.readFile(cursorRemovedStatus.configPath, 'utf8'));
  if (cursorConfigAfterRemove?.mcpServers?.['auto-codez']) throw new Error('Entrada auto-codez permaneceu no Cursor após remoção.');
  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao Cursor', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const cursorRegistryAfterReinstall = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'cursor');
  if (!cursorRegistryAfterReinstall || cursorRegistryAfterReinstall.setupState !== 'configured' || !cursorRegistryAfterReinstall.configuredAt) {
    throw new Error('Registro MCP do Cursor não voltou a configured após reinstalação: ' + JSON.stringify(cursorRegistryAfterReinstall));
  }

  const cursorExternalConfig = JSON.parse(await fs.readFile(cursorConfigStatus.configPath, 'utf8'));
  delete cursorExternalConfig.mcpServers?.['auto-codez'];
  await fs.writeFile(cursorConfigStatus.configPath, JSON.stringify(cursorExternalConfig, null, 2) + '\n', 'utf8');
  const cursorStatusAfterExternalRemoval = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('cursor'));
  if (cursorStatusAfterExternalRemoval.state !== 'not-configured') {
    throw new Error('Status do Cursor não detectou remoção externa: ' + JSON.stringify(cursorStatusAfterExternalRemoval));
  }
  const cursorRegistryAfterExternalRemoval = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'cursor');
  if (!cursorRegistryAfterExternalRemoval || cursorRegistryAfterExternalRemoval.setupState !== 'added' || cursorRegistryAfterExternalRemoval.configuredAt) {
    throw new Error('Registro MCP do Cursor não reconciliou remoção externa: ' + JSON.stringify(cursorRegistryAfterExternalRemoval));
  }

  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao Cursor', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const cursorRegistryAfterDriftRepair = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'cursor');
  if (!cursorRegistryAfterDriftRepair || cursorRegistryAfterDriftRepair.setupState !== 'configured' || !cursorRegistryAfterDriftRepair.configuredAt) {
    throw new Error('Registro MCP do Cursor não recuperou configured após reparar drift externo: ' + JSON.stringify(cursorRegistryAfterDriftRepair));
  }

  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-cursor-ciclo-configuracao.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Voltar para MCP Mode' }).click();

  await mcpMode.locator('[data-mcp-open-connection="codex"]').click();
  await mcpMode.locator('[data-mcp-connection-detail="codex"]').waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Conectar ao ChatGPT Codex', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao ChatGPT Codex', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const codexConfigStatus = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('codex'));
  if (codexConfigStatus.state !== 'configured') throw new Error('Codex não ficou configurado automaticamente: ' + JSON.stringify(codexConfigStatus));
  const codexConfig = await fs.readFile(codexConfigStatus.configPath, 'utf8');
  if (!codexConfig.includes('# >>> Auto CodeZ MCP: auto-codez') || !codexConfig.includes('[mcp_servers.auto-codez]') || !codexConfig.includes('command = "powershell.exe"')) {
    throw new Error('Configuração MCP do Codex não contém bloco Auto CodeZ gerenciado: ' + codexConfig);
  }
  for (const required of ['-File', 'mcp-bridge.ps1', '-BrokerAddress', '-AppPath', '-ClientId', '"codex"']) {
    if (!codexConfig.includes(required)) throw new Error('Configuração MCP do Codex não contém ' + required + ': ' + codexConfig);
  }
  if (codexConfig.includes('Bearer ') || codexConfig.includes('bearerToken')) throw new Error('Configuração MCP do Codex vazou credencial efêmera: ' + codexConfig);
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-codex-configurado.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Voltar para MCP Mode' }).click();

  await mcpMode.locator('.mcp-connection-card.available [data-mcp-connect-client="claude-code"]').click();
  await mcpMode.locator('[data-mcp-connection-detail="claude-code"]').waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Conectar ao Claude Code', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao Claude Code', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const claudeCodeConfigStatus = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('claude-code'));
  if (claudeCodeConfigStatus.state !== 'configured') throw new Error('Claude Code não ficou configurado automaticamente: ' + JSON.stringify(claudeCodeConfigStatus));
  const claudeCodeConfig = JSON.parse(await fs.readFile(claudeCodeConfigStatus.configPath, 'utf8'));
  const claudeCodeServer = claudeCodeConfig?.mcpServers?.['auto-codez'];
  if (!claudeCodeServer || claudeCodeServer.type !== 'stdio' || claudeCodeServer.command !== 'powershell.exe' || !Array.isArray(claudeCodeServer.args)) {
    throw new Error('Configuração MCP do Claude Code não contém servidor Auto CodeZ stdio gerenciado: ' + JSON.stringify(claudeCodeConfig));
  }
  if (!claudeCodeServer.args.includes('-File') || !claudeCodeServer.args.includes('-BrokerAddress') || !claudeCodeServer.args.includes('-AppPath') || !claudeCodeServer.args.includes('-ClientId') || !claudeCodeServer.args.includes('claude-code')) {
    throw new Error('Configuração MCP do Claude Code não aponta para o bridge universal completo: ' + JSON.stringify(claudeCodeServer));
  }
  if (JSON.stringify(claudeCodeServer).includes('Bearer ') || JSON.stringify(claudeCodeServer).includes('bearerToken')) {
    throw new Error('Configuração MCP do Claude Code vazou credencial efêmera: ' + JSON.stringify(claudeCodeServer));
  }
  const claudeBridgeArgumentIndex = claudeCodeServer.args.indexOf('-File') + 1;
  if (claudeBridgeArgumentIndex <= 0 || !claudeCodeServer.args[claudeBridgeArgumentIndex]) throw new Error('Configuração MCP do Claude Code não contém caminho do helper empacotado.');
  await fs.access(claudeCodeServer.args[claudeBridgeArgumentIndex]);
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-claude-code-configurado.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Voltar para MCP Mode' }).click();

  await mcpMode.locator('.mcp-connection-card.available [data-mcp-connect-client="claude-desktop"]').click();
  await mcpMode.locator('[data-mcp-connection-detail="claude-desktop"]').waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByText('Conectar ao Claude Desktop', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await mcpMode.getByRole('button', { name: 'Configurar automaticamente' }).click();
  await mcpMode.getByText('Auto CodeZ adicionado ao Claude Desktop', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  const claudeDesktopConfigStatus = await page.evaluate(() => window.autoCodez.mcpClientConfigStatus('claude-desktop'));
  if (claudeDesktopConfigStatus.state !== 'configured') throw new Error('Claude Desktop não ficou configurado automaticamente: ' + JSON.stringify(claudeDesktopConfigStatus));
  const claudeDesktopConfig = JSON.parse(await fs.readFile(claudeDesktopConfigStatus.configPath, 'utf8'));
  const claudeDesktopServer = claudeDesktopConfig?.mcpServers?.['auto-codez'];
  if (!claudeDesktopServer || claudeDesktopServer.command !== 'powershell.exe' || !Array.isArray(claudeDesktopServer.args)) {
    throw new Error('Configuração MCP do Claude Desktop não contém servidor Auto CodeZ gerenciado: ' + JSON.stringify(claudeDesktopConfig));
  }
  if (!claudeDesktopServer.args.includes('-File') || !claudeDesktopServer.args.includes('-BrokerAddress') || !claudeDesktopServer.args.includes('-AppPath') || !claudeDesktopServer.args.includes('-ClientId') || !claudeDesktopServer.args.includes('claude-desktop')) {
    throw new Error('Configuração MCP do Claude Desktop não aponta para o bridge universal completo: ' + JSON.stringify(claudeDesktopServer));
  }
  if (JSON.stringify(claudeDesktopServer).includes('Bearer ') || JSON.stringify(claudeDesktopServer).includes('bearerToken')) {
    throw new Error('Configuração MCP do Claude Desktop vazou credencial efêmera: ' + JSON.stringify(claudeDesktopServer));
  }
  const claudeDesktopBridgeArgumentIndex = claudeDesktopServer.args.indexOf('-File') + 1;
  if (claudeDesktopBridgeArgumentIndex <= 0 || !claudeDesktopServer.args[claudeDesktopBridgeArgumentIndex]) throw new Error('Configuração MCP do Claude Desktop não contém caminho do helper empacotado.');
  await fs.access(claudeDesktopServer.args[claudeDesktopBridgeArgumentIndex]);
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-claude-desktop-configurado.png'), animations: 'disabled' });
  await mcpMode.getByRole('button', { name: 'Voltar para MCP Mode' }).click();

  await mcpMode.locator('[data-mcp-open-connection="chatgpt"]').click();
  await mcpMode.locator('[data-mcp-connection-detail="chatgpt"]').waitFor({ state: 'visible' });
  await mcpMode.getByText('Concluir no ChatGPT', { exact: true }).waitFor({ state: 'visible' });
  await mcpMode.getByText('No ChatGPT, crie a conexão Auto CodeZ, escolha Túnel e cole abaixo o Tunnel ID mostrado pela sua conta. O Auto CodeZ prepara e valida todo o restante.', { exact: true }).waitFor({ state: 'visible' });
  const visualTunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
  await mcpMode.locator('[data-mcp-tunnel-id]').fill(visualTunnelId);
  const visualTunnelKey = mcpMode.locator('[data-mcp-tunnel-key]');
  if (await visualTunnelKey.count()) await visualTunnelKey.fill('sk-visual-tunnel-connection-key-1234567890');
  await mcpMode.getByRole('button', { name: 'Validar e conectar' }).click();
  await mcpMode.getByText('ChatGPT conectado ao Auto CodeZ', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  const tunnelReadyStatus = await page.evaluate(() => window.autoCodez.mcpTunnelStatus());
  if (!tunnelReadyStatus.running || !tunnelReadyStatus.ready || tunnelReadyStatus.tunnelId !== visualTunnelId) {
    throw new Error('Secure MCP Tunnel não ficou pronto pelo fluxo principal: ' + JSON.stringify(tunnelReadyStatus));
  }
  const connectedRegistry = await page.evaluate(() => window.autoCodez.listMcpConnections());
  const chatgptRegistry = connectedRegistry.find((connection) => connection.clientId === 'chatgpt');
  if (!chatgptRegistry || chatgptRegistry.setupState !== 'configured' || chatgptRegistry.metadata?.tunnelId !== visualTunnelId || chatgptRegistry.metadata?.autoReconnect !== true || !chatgptRegistry.lastConnectedAt) {
    throw new Error('Registro do ChatGPT não refletiu a conexão real: ' + JSON.stringify(chatgptRegistry));
  }
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-chatgpt-conectado.png'), animations: 'disabled' });

  await restartElectron();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30000 });
  const reconnectDeadline = Date.now() + 30000;
  let restoredTunnelStatus;
  while (Date.now() < reconnectDeadline) {
    restoredTunnelStatus = await page.evaluate(() => window.autoCodez.mcpTunnelStatus());
    if (restoredTunnelStatus.running && restoredTunnelStatus.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!restoredTunnelStatus?.running || !restoredTunnelStatus?.ready || restoredTunnelStatus.tunnelId !== visualTunnelId) {
    throw new Error('Secure MCP Tunnel não foi restaurado automaticamente após restart: ' + JSON.stringify(restoredTunnelStatus));
  }
  const registryAfterRestart = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'chatgpt');
  if (!registryAfterRestart || registryAfterRestart.metadata?.autoReconnect !== true || registryAfterRestart.metadata?.tunnelId !== visualTunnelId || !registryAfterRestart.lastConnectedAt) {
    throw new Error('Registro do ChatGPT perdeu intenção de reconexão após restart: ' + JSON.stringify(registryAfterRestart));
  }

  const restartedMcpButton = page.locator('[data-mcp-mode]');
  await restartedMcpButton.waitFor({ state: 'visible', timeout: 10000 });
  await restartedMcpButton.click();
  const restartedMcpMode = page.locator('#mcp-mode-root');
  await restartedMcpMode.waitFor({ state: 'visible', timeout: 10000 });
  await restartedMcpMode.locator('[data-mcp-open-connection="chatgpt"]').click();
  await restartedMcpMode.getByText('ChatGPT conectado ao Auto CodeZ', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-chatgpt-reconectado-restart.png'), animations: 'disabled' });

  await restartedMcpMode.getByRole('button', { name: 'Ver configuração avançada' }).click();
  await restartedMcpMode.getByText('Secure MCP Tunnel · diagnóstico', { exact: true }).waitFor({ state: 'visible' });
  const gatewayStatus = await page.evaluate(() => window.autoCodez.mcpGatewayStatus());
  if (!gatewayStatus.running) throw new Error('Gateway MCP não permaneceu ativo após restart.');
  await verifyPackagedMcpStdioBridge();
  const gatewayText = await restartedMcpMode.locator('.mcp-gateway-card').innerText();
  if (!gatewayText.includes('127.0.0.1') || !gatewayText.includes('Bearer ')) throw new Error('Configuração avançada não preservou endpoint/token efêmero do gateway.');
  if (await restartedMcpMode.locator('textarea,#prompt,.composer').count()) throw new Error('MCP Mode expôs composer próprio.');

  await restartedMcpMode.getByRole('button', { name: 'Desconectar ChatGPT' }).click();
  await restartedMcpMode.getByText('Concluir no ChatGPT', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  const disconnectedTunnelStatus = await page.evaluate(() => window.autoCodez.mcpTunnelStatus());
  if (disconnectedTunnelStatus.running || disconnectedTunnelStatus.ready) throw new Error('Secure MCP Tunnel permaneceu ativo após desconexão manual: ' + JSON.stringify(disconnectedTunnelStatus));
  const registryAfterManualStop = (await page.evaluate(() => window.autoCodez.listMcpConnections())).find((connection) => connection.clientId === 'chatgpt');
  if (!registryAfterManualStop || registryAfterManualStop.setupState !== 'configured' || registryAfterManualStop.metadata?.autoReconnect !== false || registryAfterManualStop.metadata?.tunnelId !== visualTunnelId) {
    throw new Error('Desconexão manual não desativou autoReconnect sem perder configuração: ' + JSON.stringify(registryAfterManualStop));
  }
  await page.screenshot({ path: path.join(outputDir, 'funcional-mcp-chatgpt-desconectado.png'), animations: 'disabled' });
  if (pageErrors.length || consoleErrors.length) throw new Error(`Erros no renderer: page=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleErrors)}`);
}
async function cleanup() { if (page && !page.isClosed()) await page.close().catch(() => {}); if (browser) await browser.close().catch(() => {}); if (appProcess?.pid && !exitState) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else appProcess.kill('SIGKILL'); } if (bridgeServer) await new Promise((resolve) => bridgeServer.close(resolve)).catch(() => {}); if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {}); }
(async () => { try { await fs.mkdir(outputDir, { recursive: true }); await startBridgeServer(); await prepareStateRoot(); await startElectron(); await runTest(); await updateManifest({ name: testName, status: 'passed' }); } catch (error) { const message = errorText(error); if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, `falha-${testName}.png`), animations: 'disabled', fullPage: true }).catch(() => {}); await fs.writeFile(path.join(outputDir, 'plugin-platform-error.txt'), `${message}\n${stderr}\n`, 'utf8').catch(() => {}); await updateManifest({ name: testName, status: 'failed', error: message }).catch(() => {}); console.error(error); process.exitCode = 1; } finally { await cleanup(); } })();
