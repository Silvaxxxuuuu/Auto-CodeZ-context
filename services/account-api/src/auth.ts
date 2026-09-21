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
  const socialProviders: Record<string, {
    clientId: string;
    clientSecret: string;
    tenantId?: string;
    redirectURI: string;
  }> = {};

  if (environment.github) {
    socialProviders.github = {
      ...environment.github,
      redirectURI: new URL('/api/auth/callback/github', environment.publicUrl).toString(),
    };
  }
  if (environment.google) {
    socialProviders.google = {
      ...environment.google,
      redirectURI: new URL('/api/auth/callback/google', environment.publicUrl).toString(),
    };
  }
  if (environment.microsoft) {
    socialProviders.microsoft = {
      ...environment.microsoft,
      redirectURI: new URL('/api/auth/callback/microsoft', environment.publicUrl).toString(),
    };
  }

  return betterAuth({
    database: database.pool,
    baseURL: environment.publicUrl,
    secret: environment.betterAuthSecret,
    trustedOrigins: [environment.publicUrl, 'autocodez://'],
    emailAndPassword: {
      enabled: false,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
        updateUserInfoOnLink: false,
      },
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
