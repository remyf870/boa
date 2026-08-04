import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';

export const TEST_DATABASE_URL: string | undefined = inject('databaseUrl') || undefined;

/** Deterministic fake secrets — test-only values, never used anywhere real. */
const FAKE_HEX_64 = 'a'.repeat(64);

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '3999',
    APP_BASE_URL: 'http://localhost:3001',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://unused',
    SESSION_SECRET: FAKE_HEX_64,
    BREAK_GLASS_KEY: FAKE_HEX_64,
    AUTH_MODE: 'dev',
    LOG_LEVEL: 'error',
    ...overrides,
  });
}

export function testPool(): pg.Pool {
  if (!TEST_DATABASE_URL) throw new Error('DATABASE_URL not set');
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

/** Unique per-run marker so tests never collide with earlier runs (records are undeletable by design). */
export const RUN = randomUUID().slice(0, 8);

export interface TestActors {
  ccLea: string;
  ccAdm: string;
  category: string;
  requester: string; // requester in LEA
  otherRequester: string; // requester in ADM
  approver: string; // approver in LEA
  sysadmin: string;
  auditor: string;
  leaRequisition: string;
  admRequisition: string;
}

/** Creates an isolated cast of synthetic users/cost centres/requisitions for one test file. */
export async function createActors(db: pg.Pool): Promise<TestActors> {
  const u = async (slug: string, name: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [`dev-${slug}-${RUN}`, `${slug}-${RUN}@example.test`, name],
      )
    ).rows[0]!.id;
  const requester = await u('req', 'Test Requester');
  const otherRequester = await u('req2', 'Other Requester');
  const approver = await u('appr', 'Test Approver');
  const sysadmin = await u('admin', 'Test Sysadmin');
  const auditor = await u('audit', 'Test Auditor');

  const cc = async (code: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO cost_centres (code, name, department) VALUES ($1, $1, 'Test') RETURNING id`,
        [`${code}-${RUN}`],
      )
    ).rows[0]!.id;
  const ccLea = await cc('T-LEA');
  const ccAdm = await cc('T-ADM');

  const category = (
    await db.query<{ id: string }>(`INSERT INTO categories (code, name) VALUES ($1, 'Test cat') RETURNING id`, [
      `T-CAT-${RUN}`,
    ])
  ).rows[0]!.id;

  const grant = (userId: string, role: string, costCentreId: string | null) =>
    db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, $2, $3, $4, 'test setup')`,
      [userId, role, costCentreId, sysadmin],
    );
  await grant(sysadmin, 'sysadmin', null);
  await grant(requester, 'requester', ccLea);
  await grant(otherRequester, 'requester', ccAdm);
  await grant(approver, 'approver', ccLea);
  await grant(auditor, 'auditor', null);

  const req = async (requesterId: string, costCentreId: string, ref: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification, amount, currency)
         VALUES ($1, $2, $3, $4, 'test', 'test', 500, 'TTD') RETURNING id`,
        [`${ref}-${RUN}`, requesterId, costCentreId, category],
      )
    ).rows[0]!.id;
  const leaRequisition = await req(requester, ccLea, 'MM-TLEA-2026-0001');
  const admRequisition = await req(otherRequester, ccAdm, 'MM-TADM-2026-0001');

  return {
    ccLea,
    ccAdm,
    category,
    requester,
    otherRequester,
    approver,
    sysadmin,
    auditor,
    leaRequisition,
    admRequisition,
  };
}
