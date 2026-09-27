import { spawn } from 'node:child_process';
import { app } from 'electron';
import { mcpBindingBrokerAddress, readMcpGatewayBindingFromBroker } from './binding-broker';
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
  const brokerAddress = mcpBindingBrokerAddress(app.getPath('appData'));
  let lastDiagnostic = '';
  const reportDiagnostic = (message: string): void => {
    if (message === lastDiagnostic) return;
    lastDiagnostic = message;
    process.stderr.write(`Auto CodeZ MCP bridge: ${message}\n`);
  };
  const bridge = new McpStdioBridgeRuntime(
    () => readMcpGatewayBindingFromBroker(brokerAddress),
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
