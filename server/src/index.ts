import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { listMigrationFiles } from './db/migrate.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config);

// A.8.3: RLS is bypassed by table owners. In production the app must connect
// as a member of massy_app that does NOT own the tables (migration 0005's
// deployment model) — refuse to start otherwise, so the defence-in-depth
// layer can never be silently inert.
if (config.NODE_ENV === 'production') {
  const owner = await db.query<{ tableowner: string; current_user: string }>(
    "SELECT tableowner, current_user FROM pg_tables WHERE schemaname = 'public' AND tablename = 'requisitions'",
  );
  const row = owner.rows[0];
  if (!row) {
    console.error('startup check failed: requisitions table not found — run migrations first');
    process.exit(1);
  }
  if (row.tableowner === row.current_user) {
    console.error(
      `startup check failed (A.8.3): the app is connected as "${row.current_user}", which OWNS the tables and bypasses row-level security. ` +
        'Connect as a non-owner service account granted the massy_app role (see migrations/0005_db_roles_grants.sql).',
    );
    process.exit(1);
  }

  // A.8.32: code must not run against a database that is behind or has
  // drifted from the on-disk migration history — a pre-0014 schema boots
  // cleanly and then 500s on every authenticated request (adversarial-review
  // finding: migrations are a separate manual step and nothing verified
  // currency). Ledger rows with no on-disk file are tolerated (code rolled
  // back after an additive migration); missing or drifted ones are fatal.
  let ledger: { name: string; sha256: string }[];
  try {
    ledger = (await db.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations')).rows;
  } catch (err) {
    console.error(
      'startup check failed: cannot read schema_migrations — run "npm run migrate" first. ' +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    process.exit(1);
  }
  const ledgerByName = new Map(ledger.map((r) => [r.name, r.sha256]));
  const onDisk = await listMigrationFiles();
  const missing = onDisk.filter((m) => !ledgerByName.has(m.name)).map((m) => m.name);
  const drifted = onDisk
    .filter((m) => ledgerByName.has(m.name) && ledgerByName.get(m.name) !== m.sha256)
    .map((m) => m.name);
  if (missing.length > 0) {
    console.error(
      `startup check failed: the database is behind the code — unapplied migration(s): ${missing.join(', ')}. Run "npm run migrate" first.`,
    );
    process.exit(1);
  }
  if (drifted.length > 0) {
    console.error(
      `startup check failed (A.8.32): applied migration(s) differ from the files on disk: ${drifted.join(', ')}. ` +
        'Applied migrations are immutable — investigate before starting.',
    );
    process.exit(1);
  }
}

const app = await buildApp(config, db);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => db.end()).then(() => process.exit(0));
  });
}
