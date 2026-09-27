import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { LocalStorage } from '../core/storage';
import { McpGatewayBindingStore } from './binding-store';
import { McpStdioBridgeRuntime } from './stdio-bridge-runtime';

function clientIdFromArgs(): string {
  const argument = process.argv.find((value) => value.startsWith('--mcp-client='));
  return argument?.slice('--mcp-client='.length).trim() || 'other';
}

function launchMainApplication(): void {
  const args = process.defaultApp && process.argv[1]
    ? [process.argv[1]]
    : [];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

async function bindingProfile(): Promise<string> {
  const appData = app.getPath('appData');
  const candidates = [...new Set([
    app.getPath('userData'),
    path.join(appData, 'Auto CodeZ'),
    path.join(appData, 'auto-codez'),
  ])];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, 'data', 'mcp-gateway-binding.json'));
      return candidate;
    } catch {
    }
  }
  return app.getPath('userData');
}

async function main(): Promise<void> {
  const userData = await bindingProfile();
  if (app.getPath('userData') !== userData) app.setPath('userData', userData);
  await app.whenReady();
  const storage = new LocalStorage(path.join(userData, 'data'));
  await storage.init();
  const bindingStore = new McpGatewayBindingStore(storage);
  let lastDiagnostic = '';
  const reportDiagnostic = (message: string): void => {
    if (message === lastDiagnostic) return;
    lastDiagnostic = message;
    process.stderr.write(`Auto CodeZ MCP bridge: ${message}\n`);
  };
  const bridge = new McpStdioBridgeRuntime(
    () => bindingStore.read(),
    () => launchMainApplication(),
    fetch,
    (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    15_000,
    reportDiagnostic,
  );
  await bridge.run(process.stdin, process.stdout, clientIdFromArgs());
}

void main()
  .catch((error) => {
    process.stderr.write(`Auto CodeZ MCP bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });
