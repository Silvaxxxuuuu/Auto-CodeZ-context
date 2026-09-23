export type AccountAuthCallback =
  | {
      type: 'oauth';
      flowId: string;
      code: string;
      state: string;
    }
  | {
      type: 'magic_link';
      flowId: string;
      token: string;
      state: string;
    }
  | {
      type: 'passkey';
      code: string;
      state: string;
    }
  | {
      type: 'hosted';
      code: string;
      state: string;
    }
  | {
      type: 'hosted_error';
      error: string;
      errorDescription?: string;
      state?: string;
    };

function requiredParam(url: URL, name: string, max = 16_384): string {
  const value = url.searchParams.get(name)?.trim() ?? '';
  if (!value || value.length > max) throw new Error(`Parâmetro de autenticação inválido: ${name}.`);
  return value;
}

export function parseAccountAuthCallback(rawUrl: string): AccountAuthCallback {
  const value = rawUrl.trim();
  if (!value || value.length > 32_768) throw new Error('Callback de autenticação inválido.');

  const url = new URL(value);
  if (url.protocol !== 'autocodez:' || url.hostname !== 'auth') {
    throw new Error('Callback de autenticação não reconhecido.');
  }

  if (url.pathname === '/oauth') {
    return {
      type: 'oauth',
      flowId: requiredParam(url, 'flowId', 256),
      code: requiredParam(url, 'code'),
      state: requiredParam(url, 'state', 512),
    };
  }

  if (url.pathname === '/magic-link') {
    const token = url.searchParams.get('t')?.trim() || url.searchParams.get('token')?.trim() || '';
    if (!token || token.length > 16_384) {
      throw new Error('Parâmetro de autenticação inválido: token.');
    }
    return {
      type: 'magic_link',
      flowId: requiredParam(url, 'flowId', 256),
      token,
      state: requiredParam(url, 'state', 512),
    };
  }

  if (url.pathname === '/passkey') {
    return {
      type: 'passkey',
      code: requiredParam(url, 'code'),
      state: requiredParam(url, 'state', 512),
    };
  }

  if (url.pathname === '/hosted') {
    const error = url.searchParams.get('error')?.trim() ?? '';
    if (error) {
      if (error.length > 256) throw new Error('Parâmetro de autenticação inválido: error.');
      const description = url.searchParams.get('error_description')?.trim() ?? '';
      const state = url.searchParams.get('state')?.trim() ?? '';
      if (description.length > 2_048) throw new Error('Parâmetro de autenticação inválido: error_description.');
      if (state.length > 512) throw new Error('Parâmetro de autenticação inválido: state.');
      return {
        type: 'hosted_error',
        error,
        ...(description ? { errorDescription: description } : {}),
        ...(state ? { state } : {}),
      };
    }
    return {
      type: 'hosted',
      code: requiredParam(url, 'code'),
      state: requiredParam(url, 'state', 512),
    };
  }

  throw new Error('Tipo de callback de autenticação não reconhecido.');
}

export function findAccountAuthCallback(argv: readonly string[]): string | undefined {
  return argv.find((value) => value.trim().toLowerCase().startsWith('autocodez://auth/'));
}
