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
  publicOrigin?: string;
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
    const adapter = new HttpAuthAdapter(value);
    const deviceRegistry = new HttpDeviceRegistryAdapter(value);
    return {
      adapter,
      deviceRegistry,
      publicOrigin: new URL(value).origin,
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


export async function resolveAccountAuthConfiguration(
  result: AccountAuthAdapterFactoryResult,
  allowConfiguredFallback = false,
): Promise<AccountAuthConfigurationSnapshot> {
  if (!result.configuration.configured || allowConfiguredFallback) {
    return {
      ...result.configuration,
      methods: [...result.configuration.methods],
    };
  }

  try {
    const discovered = await result.adapter.configuration();
    return {
      configured: true,
      methods: [...discovered.methods],
    };
  } catch (error) {
    return {
      configured: true,
      methods: [],
      configurationError: error instanceof Error
        ? error.message
        : 'Serviço de autenticação indisponível.',
    };
  }
}
