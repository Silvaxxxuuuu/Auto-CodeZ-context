import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandSafetyPolicy } from '../src/agent/command-safety-policy';

const policy = new CommandSafetyPolicy();

test('comandos comuns exigem aprovação enquanto o shell não possui confinamento completo do sistema operacional', () => {
  for (const command of ['npm test', 'npm run build', 'node scripts/check.mjs', 'git status', 'git diff']) {
    const result = policy.evaluate(command);
    assert.equal(result.decision, 'ask', command);
    assert.deepEqual(result.matchedPaths, [], command);
    assert.match(result.reasons.join(' '), /confinamento completo do sistema operacional/i, command);
  }
});

test('leituras literais de segredo exigem aprovação', () => {
  for (const command of ['cat .env', 'type .env.local', 'Get-Content .ssh/id_rsa', 'cat certs/private.pem']) {
    const result = policy.evaluate(command);
    assert.equal(result.decision, 'ask', command);
    assert.ok(result.matchedPaths.length > 0, command);
  }
});

test('mutações diretas de segredo são bloqueadas', () => {
  for (const command of [
    'echo TOKEN=x > .env',
    'Set-Content -Path .env -Value TOKEN=x',
    'rm .ssh/id_rsa',
    'cp source.pem certs/private.pem',
    'cmd /c "echo x>.env.local"',
  ]) {
    const result = policy.evaluate(command);
    assert.equal(result.decision, 'deny', command);
  }
});

test('mutação direta de metadados Git é bloqueada', () => {
  for (const command of ['echo x > .git/config', 'Set-Content .git/config x', 'rm .git/index']) {
    const result = policy.evaluate(command);
    assert.equal(result.decision, 'deny', command);
  }
});

test('mutações Git via shell sempre exigem aprovação adicional', () => {
  for (const command of [
    'git add src/main.ts',
    'git commit -m test',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git checkout other-branch',
    'git switch feature/x',
    'git config user.name test',
  ]) {
    const result = policy.evaluate(command);
    assert.equal(result.decision, 'ask', command);
    assert.match(result.reasons.join(' '), /mutação Git direta/i);
  }
});

test('templates de env não são confundidos com segredo', () => {
  const result = policy.evaluate('type .env.production.example');
  assert.equal(result.decision, 'ask');
  assert.deepEqual(result.matchedPaths, []);
  assert.match(result.reasons.join(' '), /confinamento completo do sistema operacional/i);
});

test('detecta segredo embutido em redirecionamento e atribuição simples', () => {
  assert.equal(policy.evaluate('echo x>.env').decision, 'deny');
  assert.equal(policy.evaluate("$p='.env'; Get-Content $p").decision, 'ask');
});

test('comando vazio falha fechado', () => {
  const result = policy.evaluate('   ');
  assert.equal(result.decision, 'deny');
});
