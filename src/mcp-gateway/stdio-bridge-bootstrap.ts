import { spawn } from 'node:child_process';
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

async function main(): Promise<void> {
  await app.whenReady();
  const candidateRoots = [...new Set([
    path.join(app.getPath('userData'), 'data'),
    path.join(app.getPath('appData'), 'Auto CodeZ', 'data'),
    path.join(app.getPath('appData'), 'auto-codez', 'data'),
  ])];
  const bindingStores = candidateRoots.map((root) => new McpGatewayBindingStore(new LocalStorage(root)));
  await Promise.all(bindingStores.map(async (store, index) => {
    const storage = new LocalStorage(candidateRoots[index]);
    await storage.init();
    bindingStores[index] = new McpGatewayBindingStore(storage);
  }));
  const bridge = new McpStdioBridgeRuntime(
    async () => {
      for (const bindings of bindingStores) {
        const binding = await bindings.read();
        if (binding) return binding;
      }
      return undefined;
    },
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
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });
