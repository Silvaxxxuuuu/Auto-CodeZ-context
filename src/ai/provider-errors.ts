export type ProviderErrorKind = 'authentication' | 'quota' | 'rate_limit' | 'billing' | 'invalid_request' | 'server' | 'network' | 'unknown';

export class ProviderRequestError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly operation: string;

  constructor(message: string, status: number, provider = 'AI provider', kind?: ProviderErrorKind, operation = 'request') {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.provider = provider;
    this.kind = kind || classifyProviderError(status, message);
    this.operation = operation;
  }
}

export function classifyProviderError(status: number, message: string): ProviderErrorKind {
  const normalized = message.toLowerCase();
  if (status === 401 || status === 403 || /invalid\s+(?:api\s*)?key|api\s*key.*(?:invalid|incorrect|not\s+valid)|invalid\s+authentication|unauthorized|authentication.*failed|permission\s+denied|forbidden/.test(normalized)) return 'authentication';
  if (status === 402 || /billing|payment required|no credits|credits remaining|insufficient funds|billing hard limit/.test(normalized)) return 'billing';
  if (status === 429 || /quota|rate limit|rate_limit|too many requests|resource exhausted|free tier/.test(normalized)) return /quota|free tier|resource exhausted/.test(normalized) ? 'quota' : 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 400 || status === 404 || /invalid request|invalid argument|unsupported|malformed/.test(normalized)) return 'invalid_request';
  return 'unknown';
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof ProviderRequestError ? error.kind === 'authentication' : false;
}

export function providerErrorStatus(error: unknown): number | undefined {
  return error instanceof ProviderRequestError ? error.status : undefined;
}

export function providerErrorKind(error: unknown): ProviderErrorKind | undefined {
  return error instanceof ProviderRequestError ? error.kind : undefined;
}

export function formatProviderError(error: unknown): string {
  if (!(error instanceof ProviderRequestError)) return error instanceof Error ? error.message : String(error);
  const prefix = `${error.provider}:`;
  switch (error.kind) {
    case 'authentication': return `${prefix} a API key foi recusada. Verifique a chave nas configurações de IA.`;
    case 'billing': return `${prefix} a conta não possui créditos ou faturamento disponível para esta solicitação. A API key continua salva.`;
    case 'quota': return `${prefix} a cota disponível para este modelo foi atingida. A API key continua salva.`;
    case 'rate_limit': return `${prefix} o limite de requisições foi atingido. Aguarde e tente novamente.`;
    case 'server': return `${prefix} o serviço do provider apresentou um erro temporário. Tente novamente.`;
    case 'invalid_request': return `${prefix} a solicitação foi recusada. ${error.message}`;
    default: return `${prefix} ${error.message}`;
  }
}

export function createProviderRequestError(provider: string, operation: string, status: number, message: string): ProviderRequestError {
  return new ProviderRequestError(message, status, provider, undefined, operation);
}
