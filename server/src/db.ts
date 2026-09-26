import pg from 'pg';

// Return BIGINT/COUNT(*) as JS numbers (all our counts are far below 2^53)
// and NUMERIC as floats (only used for percentages).
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;
export type Queryable = Pick<pg.PoolClient, 'query'>;

export function createPool(url: string, max: number, ssl: false | { rejectUnauthorized: boolean; ca?: string }): Db {
  // When TLS is configured explicitly, drop sslmode & co. from the URL: the driver would
  // otherwise let them override (and weaken) the explicit certificate settings.
  if (ssl) {
    try {
      const u = new URL(url);
      for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(k);
      url = u.toString();
    } catch {
      /* not a URL-style connection string; use as is */
    }
  }
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ssl: ssl || undefined,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: 'attendly-api',
  });
  // An idle client erroring (e.g. DB restart) must never crash the process.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * Runs `fn` inside a transaction. Serialization failures and deadlocks are
 * retried (bounded), everything else is rolled back and rethrown.
 */
export async function withTx<T>(pool: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < 4) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
