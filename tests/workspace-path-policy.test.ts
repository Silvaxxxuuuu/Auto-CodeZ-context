import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspacePathPolicy } from '../src/agent/workspace-path-policy';

const policy = new WorkspacePathPolicy();

test('arquivos comuns permanecem permitidos pela política de path', () => {
  const result = policy.evaluate('read_file', ['src/main.ts']);
  assert.equal(result.decision, 'allow');
  assert.equal(result.classification, 'normal');
  assert.deepEqual(result.reasons, []);
});

test('segredos conhecidos exigem aprovação para leitura', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.npmrc',
    '.pypirc',
    '.ssh/id_ed25519',
    '.aws/credentials',
    '.config/gcloud/application_default_credentials.json',
    'certs/private.pem',
    'keys/signing.key',
    'auth/service-account.prod.json',
    'config/credentials.json',
  ]) {
    const result = policy.evaluate('read_file', [path]);
    assert.equal(result.decision, 'ask', path);
    assert.equal(result.classification, 'sensitive', path);
    assert.ok(result.reasons.length > 0, path);
  }
});

test('mutações de segredos são bloqueadas inclusive em file tools e staging seletivo', () => {
  for (const tool of ['write_file', 'create_file', 'replace_text', 'delete_file', 'rename_file', 'git_stage'] as const) {
    const result = policy.evaluate(tool, ['.env']);
    assert.equal(result.decision, 'deny', tool);
    assert.equal(result.classification, 'sensitive', tool);
  }
});

test('modelos de env explicitamente destinados a exemplo não são tratados como segredo', () => {
  for (const path of ['.env.example', '.env.sample', '.env.template', '.env.production.example', '.env.local.template']) {
    const result = policy.evaluate('write_file', [path]);
    assert.equal(result.decision, 'allow', path);
    assert.equal(result.classification, 'normal', path);
  }
});

test('metadados Git podem ser lidos somente com aprovação e não podem ser modificados', () => {
  const read = policy.evaluate('read_file', ['.git/config']);
  assert.equal(read.decision, 'ask');
  assert.equal(read.classification, 'protected');

  for (const tool of ['write_file', 'create_file', 'replace_text', 'delete_file', 'rename_file', 'git_stage'] as const) {
    const result = policy.evaluate(tool, ['.git/config']);
    assert.equal(result.decision, 'deny', tool);
    assert.equal(result.classification, 'protected', tool);
  }
});

test('rename considera origem e destino e aplica a decisão mais forte', () => {
  const sensitiveDestination = policy.evaluate('rename_file', ['src/config.ts', '.env']);
  assert.equal(sensitiveDestination.decision, 'deny');
  assert.equal(sensitiveDestination.classification, 'sensitive');

  const protectedDestination = policy.evaluate('rename_file', ['src/config.ts', '.git/config']);
  assert.equal(protectedDestination.decision, 'deny');
  assert.equal(protectedDestination.classification, 'protected');
});

test('normaliza separadores Windows antes de classificar', () => {
  const result = policy.evaluate('read_file', ['.ssh\\id_rsa']);
  assert.equal(result.decision, 'ask');
  assert.equal(result.classification, 'sensitive');
});

test('múltiplos paths preservam a decisão mais restritiva e deduplicam razões', () => {
  const result = policy.evaluate('read_file', ['src/a.ts', '.env', 'nested/.env.production']);
  assert.equal(result.decision, 'ask');
  assert.equal(result.classification, 'sensitive');
  assert.deepEqual(result.reasons, ['arquivo de variáveis de ambiente']);
});
