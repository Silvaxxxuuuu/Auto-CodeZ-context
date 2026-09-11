import { AsyncLocalStorage } from 'node:async_hooks';

const providerRecoveryStorage = new AsyncLocalStorage<boolean>();

export function runWithExplicitProviderRecovery<T>(operation: () => Promise<T>): Promise<T> {
  return providerRecoveryStorage.run(true, operation);
}

export function isExplicitProviderRecovery(): boolean {
  return providerRecoveryStorage.getStore() === true;
}
