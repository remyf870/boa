// Vitest global setup: use the provided DATABASE_URL (CI supplies a disposable
// PostgreSQL 16 service container), or boot an embedded PostgreSQL locally so
// the integration suite always runs. Synthetic data only, either way (A.8.33).
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const PORT = 5439;
const DATA_DIR = path.resolve(import.meta.dirname, '../.pgdata-test');

export default async function setup({ provide }: TestProject): Promise<(() => Promise<void>) | void> {
  const provided = process.env.DATABASE_URL;
  if (provided) {
    provide('databaseUrl', provided);
    return;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  await rm(DATA_DIR, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'massy_test',
    password: 'massy_test',
    port: PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('massy_test');
  provide('databaseUrl', `postgres://massy_test:massy_test@localhost:${PORT}/massy_test`);

  return async () => {
    await pg.stop();
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  };
}
