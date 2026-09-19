import type { AuthAdapter } from './auth-adapter';
import { UnavailableAuthAdapter } from './auth-adapter';
import { HttpAuthAdapter } from './http-auth-adapter';
import type { DeviceRegistryAdapter } from './device-registry-adapter';
import { UnavailableDeviceRegistryAdapter } from './device-registry-adapter';
import { HttpDeviceRegistryAdapter } from './http-device-registry-adapter';

export interface AccountAuthConfigurationSnapshot {
  configured: boolean;
  methods: Array<'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey'>;
  configurationError?: string;
}

export interface AccountAuthAdapterFactoryResult {
  adapter: AuthAdapter;
  deviceRegistry: DeviceRegistryAdapter;
  configuration: AccountAuthConfigurationSnapshot;
}

export function createAccountAuthAdapter(
  baseUrl: string | undefined,
): AccountAuthAdapterFactoryResult {
  const value = baseUrl?.trim();
  if (!value) {
    return {
      adapter: new UnavailableAuthAdapter(),
      deviceRegistry: new UnavailableDeviceRegistryAdapter(),
      configuration: {
        configured: false,
        methods: [],
      },
    };
  }

  try {
    return {
      adapter: new HttpAuthAdapter(value),
      deviceRegistry: new HttpDeviceRegistryAdapter(value),
      configuration: {
        configured: true,
        methods: ['magic_link', 'github', 'google', 'microsoft', 'passkey'],
      },
    };
  } catch (error) {
    return {
      adapter: new UnavailableAuthAdapter(),
      deviceRegistry: new UnavailableDeviceRegistryAdapter(),
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
