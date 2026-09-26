import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './db';

const MIGRATION_LOCK = 7_413_001;

export function migrationsDir(): string {
  return path.resolve(process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'migrations'));
}

/** Applies pending *.sql migrations in lexical order, each in its own transaction. Safe to run concurrently. */
export async function migrate(pool: Db, dir = migrationsDir(), log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3,}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}
