const stdioBridgeMode = process.argv.includes('--mcp-stdio-bridge');

async function start(): Promise<void> {
  if (stdioBridgeMode) {
    await import('../mcp-gateway/stdio-bridge-bootstrap');
    return;
  }
  await import('../ai/local-ai-main-bootstrap');
  await import('../plugins/plugin-main-bootstrap');
  await import('../main');
}

void start();
