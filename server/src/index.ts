import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
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
