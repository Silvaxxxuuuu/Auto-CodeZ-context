import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { AccountApiEnvironment } from './env.js';

export class Database {
  readonly pool: Pool;

  constructor(environment: AccountApiEnvironment) {
    this.pool = new Pool({
      connectionString: environment.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, values);
    return result.rows;
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
