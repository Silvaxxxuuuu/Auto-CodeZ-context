import path from 'node:path';
import { createRequire } from 'node:module';

const target = process.argv.includes('--mcp-stdio-bridge')
  ? 'mcp-bridge-main.js'
  : 'app-main.js';

createRequire(__filename)(path.join(__dirname, target));
