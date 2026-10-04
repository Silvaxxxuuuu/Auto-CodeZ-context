import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountPersonalizationRuntime, ACCOUNT_PERSONALIZATION_MAX_CHARS } from '../src/account-personalization-runtime';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? structuredClone(this.values.get(name)) as T : fallback;
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

test('account personalization stays isolated by account and survives runtime reconstruction', async () => {
  const storage = new MemoryStorage();
  let accountId: string | undefined = 'account-a';
  const runtime = new AccountPersonalizationRuntime(storage as never, () => accountId, () => 1000);
  await runtime.init();

  assert.equal(runtime.get(), '');
  assert.equal(await runtime.set('Seja objetivo e use respostas curtas.'), 'Seja objetivo e use respostas curtas.');
  assert.match(runtime.context() ?? '', /Seja objetivo e use respostas curtas/);

  accountId = 'account-b';
  assert.equal(runtime.get(), '');
  await runtime.set('Explique com mais detalhes.');

  accountId = 'account-a';
  assert.equal(runtime.get(), 'Seja objetivo e use respostas curtas.');

  const restored = new AccountPersonalizationRuntime(storage as never, () => accountId);
  await restored.init();
  assert.equal(restored.get(), 'Seja objetivo e use respostas curtas.');

  accountId = 'account-b';
  assert.equal(restored.get(), 'Explique com mais detalhes.');
});

test('account personalization validates authentication, size and clearing', async () => {
  const storage = new MemoryStorage();
  const account = { id: undefined as string | undefined };
  const runtime = new AccountPersonalizationRuntime(storage as never, () => account.id);
  await runtime.init();

  assert.throws(() => runtime.get(), /Entre em uma conta/i);
  await assert.rejects(runtime.set('x'), /Entre em uma conta/i);

  account.id = 'account-a';
  await assert.rejects(runtime.set('x'.repeat(ACCOUNT_PERSONALIZATION_MAX_CHARS + 1)), /1000 caracteres/i);
  await runtime.set('Tom direto.');
  assert.equal(runtime.get(), 'Tom direto.');
  await runtime.set('   ');
  assert.equal(runtime.get(), '');
  assert.equal(runtime.context(), undefined);
});
