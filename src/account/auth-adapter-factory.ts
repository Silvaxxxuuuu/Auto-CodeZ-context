import type { AuthAdapter } from './auth-adapter';
import { UnavailableAuthAdapter } from './auth-adapter';
import { HttpAuthAdapter } from './http-auth-adapter';

export interface AccountAuthConfigurationSnapshot {
  configured: boolean;
  methods: Array<'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey'>;
  configurationError?: string;
}

export interface AccountAuthAdapterFactoryResult {
  adapter: AuthAdapter;
  configuration: AccountAuthConfigurationSnapshot;
}

export function createAccountAuthAdapter(
  baseUrl: string | undefined,
): AccountAuthAdapterFactoryResult {
  const value = baseUrl?.trim();
  if (!value) {
    return {
      adapter: new UnavailableAuthAdapter(),
      configuration: {
        configured: false,
        methods: [],
      },
    };
  }

  try {
    return {
      adapter: new HttpAuthAdapter(value),
      configuration: {
        configured: true,
        methods: ['magic_link', 'github', 'google', 'microsoft', 'passkey'],
      },
    };
  } catch (error) {
    return {
      adapter: new UnavailableAuthAdapter(),
      configuration: {
        configured: false,
        methods: [],
        configurationError: error instanceof Error
          ? error.message
          : 'Configuração do serviço de autenticação inválida.',
      },
    };
  }
}
