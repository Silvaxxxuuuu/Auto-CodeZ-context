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

  const desktopMigrationsUrl = new URL('../migrations/', import.meta.url);
  const desktopMigrations = (await fs.readdir(desktopMigrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (!desktopMigrations.length) throw new Error('No desktop account migrations were found.');
  for (const name of desktopMigrations) {
    const sql = await fs.readFile(new URL(name, desktopMigrationsUrl), 'utf8');
    await database.pool.query(sql);
  }

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
