export type AccountApiEnvironment = {
  publicUrl: string;
  port: number;
  databaseUrl: string;
  betterAuthSecret: string;
  accessTokenSecret: string;
  descopeProjectId?: string;
  descopeBaseUrl?: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenantId: string };
  azureEmail?: { connectionString: string; sender: string };
  passkeyRpId: string;
  passkeyRpName: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function secret(name: string): string {
  const value = required(name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return value;
}

function pair(idName: string, secretName: string): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env[idName]?.trim();
  const clientSecret = process.env[secretName]?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) throw new Error(`${idName} and ${secretName} must be configured together.`);
  return { clientId, clientSecret };
}

export function loadEnvironment(): AccountApiEnvironment {
  const publicUrl = new URL(required('ACCOUNT_PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:') throw new Error('ACCOUNT_PUBLIC_URL must use HTTPS.');
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('ACCOUNT_PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment.');
  }

  const port = Number.parseInt(process.env.PORT?.trim() || '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.');

  const github = pair('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET');
  const google = pair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET');
  const microsoftPair = pair('MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET');
  const microsoft = microsoftPair
    ? { ...microsoftPair, tenantId: process.env.MICROSOFT_TENANT_ID?.trim() || 'common' }
    : undefined;

  const emailConnection = process.env.AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING?.trim();
  const emailSender = process.env.AZURE_EMAIL_SENDER?.trim();
  if (Boolean(emailConnection) !== Boolean(emailSender)) {
    throw new Error('AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING and AZURE_EMAIL_SENDER must be configured together.');
  }

  return {
    publicUrl: publicUrl.origin,
    port,
    databaseUrl: required('DATABASE_URL'),
    betterAuthSecret: secret('BETTER_AUTH_SECRET'),
    accessTokenSecret: secret('ACCOUNT_ACCESS_TOKEN_SECRET'),
    ...(process.env.DESCOPE_PROJECT_ID?.trim()
      ? { descopeProjectId: process.env.DESCOPE_PROJECT_ID.trim() }
      : {}),
    ...(process.env.DESCOPE_BASE_URL?.trim()
      ? { descopeBaseUrl: process.env.DESCOPE_BASE_URL.trim() }
      : {}),
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(emailConnection && emailSender ? {
      azureEmail: { connectionString: emailConnection, sender: emailSender },
    } : {}),
    passkeyRpId: process.env.PASSKEY_RP_ID?.trim() || publicUrl.hostname,
    passkeyRpName: process.env.PASSKEY_RP_NAME?.trim() || 'Auto CodeZ',
  };
}
