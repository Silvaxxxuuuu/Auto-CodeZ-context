const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const requiredTests = [
  'agent-core-v2-acceptance-matrix.test.js',
  'agent-core-process-instance-acceptance.test.js',
  'agent-core-shadow-parity-acceptance.test.js',
  'agent-core-shadow-retirement-architecture.test.js',
  'agent-core-shadow-retirement-bootstrap-acceptance.test.js',
  'agent-core-progress-watchdog.test.js',
  'execution-recovery-determinism.test.js',
  'response-retry.test.js',
  'tool-runtime-cancellation.test.js',
  'execution-report.test.js',
  'mcp-gateway-execution-runtime.test.js',
];

const testsRoot = path.resolve(process.cwd(), '.test-dist', 'tests');
const resolved = requiredTests.map((file) => path.join(testsRoot, file));
const missing = resolved.filter((file) => !fs.existsSync(file));

if (missing.length) {
  console.error('Agent Core V2 acceptance gate cannot run because compiled evidence is missing:');
  for (const file of missing) console.error(`- ${path.relative(process.cwd(), file)}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', ...resolved],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
