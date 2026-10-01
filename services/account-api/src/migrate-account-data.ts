import fs from 'node:fs/promises';
import { loadAccountDataEnvironment } from './account-data-env.js';
import { Database } from './db.js';

const environment = loadAccountDataEnvironment();
const database = new Database(environment);

async function main(): Promise<void> {
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const migrations = (await fs.readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));

  if (!migrations.length) throw new Error('No Account Data migrations were found.');

  for (const name of migrations) {
    const sql = await fs.readFile(new URL(name, migrationsUrl), 'utf8');
    await database.pool.query(sql);
  }

  console.log('Auto CodeZ Account Data migrations completed.');
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close().catch((): undefined => undefined);
  });
