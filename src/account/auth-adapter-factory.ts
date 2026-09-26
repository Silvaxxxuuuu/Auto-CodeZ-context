import type { AuthAdapter } from './auth-adapter';
import { UnavailableAuthAdapter } from './auth-adapter';
import { HttpAuthAdapter } from './http-auth-adapter';
import { DescopeAuthAdapter } from './descope-auth-adapter';
import type { DeviceRegistryAdapter, DeviceRequestProofSigner } from './device-registry-adapter';
import { UnavailableDeviceRegistryAdapter } from './device-registry-adapter';
import { HttpDeviceRegistryAdapter } from './http-device-registry-adapter';

export interface AccountAuthConfigurationSnapshot {
  configured: boolean;
  methods: Array<'magic_link' | 'github' | 'google' | 'microsoft' | 'passkey'>;
  hosted?: boolean;
  passkeyEnrollmentSupported?: boolean;
  configurationError?: string;
}

export interface AccountAuthAdapterFactoryResult {
  adapter: AuthAdapter;
  deviceRegistry: DeviceRegistryAdapter;
  publicOrigin?: string;
  configuration: AccountAuthConfigurationSnapshot;
}

export interface AccountAuthFactoryOptions {
  descopeProjectId?: string;
  descopeBaseUrl?: string;
  descopePasskeyOidcFlowEnabled?: boolean;
  accountDataBaseUrl?: string;
  legacyBaseUrl?: string;
  deviceProofSigner?: DeviceRequestProofSigner;
}

export function createAccountAuthAdapter(
  input: string | undefined | AccountAuthFactoryOptions,
): AccountAuthAdapterFactoryResult {
  let options: AccountAuthFactoryOptions;
  if (typeof input === 'string') options = { legacyBaseUrl: input };
  else if (input === undefined) options = {};
  else options = input;
  const descopeProjectId = options.descopeProjectId?.trim();
  if (descopeProjectId) {
    try {
      const adapter = new DescopeAuthAdapter(descopeProjectId, {
        baseUrl: options.descopeBaseUrl,
        passkeyOidcFlowEnabled: options.descopePasskeyOidcFlowEnabled === true,
      });
      const deviceRegistry = options.accountDataBaseUrl?.trim()
        ? new HttpDeviceRegistryAdapter(options.accountDataBaseUrl, { proofSigner: options.deviceProofSigner })
        : new UnavailableDeviceRegistryAdapter();
      return {
        adapter,
        deviceRegistry,
        ...(options.accountDataBaseUrl?.trim()
          ? { publicOrigin: new URL(options.accountDataBaseUrl).origin }
          : {}),
        configuration: {
          configured: true,
          methods: [
            'magic_link',
            'github',
            'google',
            'microsoft',
            ...(options.descopePasskeyOidcFlowEnabled === true ? ['passkey' as const] : []),
          ],
          passkeyEnrollmentSupported: false,
        },
      };
    } catch (error) {
      return {
        adapter: new UnavailableAuthAdapter(),
        deviceRegistry: new UnavailableDeviceRegistryAdapter(),
        configuration: {
          configured: false,
          methods: [],
          configurationError: error instanceof Error ? error.message : 'Configuração de identidade inválida.',
        },
      };
    }
  }

  const value = options.legacyBaseUrl?.trim();
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
    const deviceRegistry = new HttpDeviceRegistryAdapter(value, { proofSigner: options.deviceProofSigner });
    return {
      adapter,
      deviceRegistry,
      publicOrigin: new URL(value).origin,
      configuration: {
        configured: true,
        methods: ['magic_link', 'github', 'google', 'microsoft', 'passkey'],
        passkeyEnrollmentSupported: true,
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
      ...(result.configuration.hosted ? { hosted: true } : {}),
      ...(result.configuration.passkeyEnrollmentSupported !== undefined
        ? { passkeyEnrollmentSupported: result.configuration.passkeyEnrollmentSupported }
        : {}),
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
