// Local development database (A.8.33: synthetic data only).
//
// Windows dev machines usually have neither PostgreSQL nor Docker installed,
// so this boots the bundled PostgreSQL binaries on port 5433 and keeps the
// data directory between runs. Leave it running in its own terminal.
//
// This is DEVELOPMENT TOOLING ONLY. Production runs on-prem PostgreSQL 16
// provisioned by Massy IT per plan section 2 — never this.
import path from 'node:path';
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5433;
const DATA_DIR = path.resolve(import.meta.dirname, '../../.pgdata-dev');

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'massy_dev',
  password: 'massy_dev',
  port: PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--no-locale'],
});

const firstRun = !existsSync(DATA_DIR);
if (firstRun) {
  console.log('initialising a new development database...');
  await pg.initialise();
}
await pg.start();
if (firstRun) {
  await pg.createDatabase('massy_purchasing');
}

console.log(`
development database ready
  postgres://massy_dev:massy_dev@localhost:${PORT}/massy_purchasing

Leave this running. In a second terminal:
  npm run migrate
  npm run seed
  npm run dev

Press Ctrl+C to stop.
`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void pg.stop().then(() => process.exit(0));
  });
}
