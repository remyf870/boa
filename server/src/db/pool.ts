import pg from 'pg';
import type { Config } from '../config.js';

export type Db = pg.Pool;

export function createPool(config: Pick<Config, 'DATABASE_URL'>): Db {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    // All timestamps are stored and compared in UTC (A.8.17); rendering to
    // local time is the client's job.
    options: '-c timezone=UTC',
  });
  return pool;
}

/**
 * Run `fn` inside a transaction with the acting user set for Row-Level
 * Security (A.8.3). Every query that touches RLS-scoped tables must go
 * through this so `app.user_id` is present.
 */
export async function withUserContext<T>(
  db: Db,
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
