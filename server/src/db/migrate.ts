// Versioned, immutable SQL migrations (A.8.32). Files in /migrations run in
// filename order; each application is recorded with a SHA-256 of the file.
// A previously applied file whose hash has changed aborts the run — applied
// migrations are history, and history does not get edited.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(databaseUrl: string, log: (msg: string) => void = () => undefined): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // One migrator at a time — lock BEFORE creating the ledger table
    // (CREATE TABLE IF NOT EXISTS is not race-safe across two starters)
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['massy_migrations']);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        sha256      char(64) NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows: done } = await client.query<{ name: string; sha256: string }>(
      'SELECT name, sha256 FROM schema_migrations',
    );
    const doneByName = new Map(done.map((r) => [r.name, r.sha256]));

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Hash over LF-normalised content so Windows (CRLF) and Linux (LF)
      // checkouts of the same commit agree on the fingerprint
      const hash = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const existing = doneByName.get(file);
      if (existing) {
        if (existing !== hash) {
          throw new Error(
            `Migration ${file} was modified after being applied (recorded ${existing.slice(0, 12)}…, on disk ${hash.slice(0, 12)}…). ` +
              'Applied migrations are immutable (A.8.32) — add a new migration instead.',
          );
        }
        skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file, hash]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return { applied, skipped };
}

// CLI entry: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const result = await runMigrations(cfg.DATABASE_URL, (m) => console.log(m));
  console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already current`);
}
