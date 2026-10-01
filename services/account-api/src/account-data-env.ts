export type AccountDataEnvironment = {
  port: number;
  databaseUrl: string;
  descopeProjectId: string;
  descopeBaseUrl?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function loadAccountDataEnvironment(): AccountDataEnvironment {
  const port = Number.parseInt(process.env.PORT?.trim() || '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.');

  const descopeProjectId = required('DESCOPE_PROJECT_ID');
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(descopeProjectId)) {
    throw new Error('DESCOPE_PROJECT_ID is invalid.');
  }

  const descopeBaseUrl = process.env.DESCOPE_BASE_URL?.trim();
  if (descopeBaseUrl) {
    const parsed = new URL(descopeBaseUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('DESCOPE_BASE_URL is invalid.');
    }
  }

  return {
    port,
    databaseUrl: required('DATABASE_URL'),
    descopeProjectId,
    ...(descopeBaseUrl ? { descopeBaseUrl } : {}),
  };
}
