import fs from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { loadEnvironment } from './env.js';
import { Database } from './db.js';
import { MagicLinkEmailSender } from './email.js';
import { createBetterAuth } from './auth.js';

const environment = loadEnvironment();
const database = new Database(environment);
const email = new MagicLinkEmailSender(environment);
const auth = createBetterAuth(environment, database, email);

async function main(): Promise<void> {
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();

  const desktopSchemaUrl = new URL('../migrations/001_desktop_account.sql', import.meta.url);
  const desktopSchema = await fs.readFile(desktopSchemaUrl, 'utf8');
  await database.pool.query(desktopSchema);

  console.log('Auto CodeZ Account API migrations completed.');
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close().catch((): undefined => undefined);
  });
