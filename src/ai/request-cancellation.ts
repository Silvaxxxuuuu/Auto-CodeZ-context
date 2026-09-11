import { AsyncLocalStorage } from 'node:async_hooks';

const abortSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithAbortSignal<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (!signal) return operation();
  return abortSignalStorage.run(signal, operation);
}

export function currentAbortSignal(): AbortSignal | undefined {
  return abortSignalStorage.getStore();
}
