const stdioBridgeMode = process.argv.includes('--mcp-stdio-bridge');

if (stdioBridgeMode) {
  await import('../mcp-gateway/stdio-bridge-bootstrap');
} else {
  await import('../ai/local-ai-main-bootstrap');
  await import('../plugins/plugin-main-bootstrap');
  await import('../main');
}
