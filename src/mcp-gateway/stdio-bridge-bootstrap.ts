import { spawn } from 'node:child_process';
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

async function main(): Promise<void> {
  await app.whenReady();
  const storage = new LocalStorage();
  await storage.init();
  const bindings = new McpGatewayBindingStore(storage);
  const bridge = new McpStdioBridgeRuntime(
    () => bindings.read(),
    () => launchMainApplication(),
  );
  await bridge.run(process.stdin, process.stdout, clientIdFromArgs());
}

void main()
  .catch((error) => {
    process.stderr.write(`Auto CodeZ MCP bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
  });
