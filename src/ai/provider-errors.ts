export class ProviderRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

export function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof ProviderRequestError)) return false;
  return error.status === 401 || error.status === 403;
}

export function providerErrorStatus(error: unknown): number | undefined {
  return error instanceof ProviderRequestError ? error.status : undefined;
}
