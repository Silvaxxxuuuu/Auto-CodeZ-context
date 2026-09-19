import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import type { AccountApiEnvironment } from './env.js';
import { MagicLinkEmailSender } from './email.js';
import type { Database } from './db.js';

export function createBetterAuth(
  environment: AccountApiEnvironment,
  database: Database,
  email: MagicLinkEmailSender,
) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {};

  if (environment.github) socialProviders.github = environment.github;
  if (environment.google) socialProviders.google = environment.google;
  if (environment.microsoft) socialProviders.microsoft = environment.microsoft;

  return betterAuth({
    database: database.pool,
    baseURL: environment.publicUrl,
    secret: environment.betterAuthSecret,
    trustedOrigins: [environment.publicUrl, 'autocodez://'],
    emailAndPassword: {
      enabled: false,
    },
    socialProviders,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email: address, url }) => {
          await email.send({ email: address, url });
        },
      }),
      passkey({
        rpID: environment.passkeyRpId,
        rpName: environment.passkeyRpName,
        origin: environment.publicUrl,
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
