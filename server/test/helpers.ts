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

export interface WorkflowFixture extends TestActors {
  /** Second-level approver (job title "Test Finance <RUN>"). */
  approverB: string;
  /** doa_admin (uploaded the active DOA version). */
  doaAdmin: string;
  /** doa_approver + budget_approver (activated DOA v1 and budget v1). */
  fd: string;
  accountant: string;
  budgetOwner: string;
  supplier: string;
  doaVersionId: string;
  budgetVersionId: string;
  titleA: string;
  titleB: string;
}

/**
 * Extends createActors with everything the Phase 1-3 flows need: an ACTIVE
 * DOA version (band 0-5000: approver A; 5000+: A → B, 1 quote required) and
 * an ACTIVE budget (10000 for the test category) built through the §5.9
 * governance walk. The base `approver` gets job title "Test Manager <RUN>".
 */
export async function createWorkflowFixture(db: pg.Pool): Promise<WorkflowFixture> {
  const actors = await createActors(db);
  const titleA = `Test Manager ${RUN}`;
  const titleB = `Test Finance ${RUN}`;

  await db.query('UPDATE users SET job_title = $2 WHERE id = $1', [actors.approver, titleA]);

  const u = async (slug: string, name: string, title: string | null) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`dev-${slug}-${RUN}`, `${slug}-${RUN}@example.test`, name, title],
      )
    ).rows[0]!.id;
  const approverB = await u('apprb', 'Second Approver', titleB);
  const doaAdmin = await u('doaadm', 'DOA Admin', 'Compliance Officer');
  const fd = await u('fd', 'Finance Director', 'Finance Director');
  const accountant = await u('acct', 'Test Accountant', 'Accounts Clerk');
  const budgetOwner = await u('bowner', 'Budget Owner', 'Financial Analyst');

  const grant = (userId: string, role: string, costCentreId: string | null) =>
    db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, $2, $3, $4, 'test setup')`,
      [userId, role, costCentreId, actors.sysadmin],
    );
  await grant(approverB, 'approver', actors.ccLea);
  await grant(doaAdmin, 'doa_admin', null);
  await grant(fd, 'doa_approver', null);
  await grant(fd, 'budget_approver', null);
  await grant(accountant, 'accounting', null);
  await grant(budgetOwner, 'budget_owner', actors.ccLea);

  const supplier = (
    await db.query<{ id: string }>(
      `INSERT INTO suppliers (name, cdk_vendor_ref) VALUES ($1, $2) RETURNING id`,
      [`Test Supplier ${RUN}`, `CDK-T-${RUN}`],
    )
  ).rows[0]!.id;

  // Active DOA: uploaded by doaAdmin, activated by fd (two-person rule)
  const nextVersionNo = (
    await db.query<{ n: number }>('SELECT coalesce(max(version_no), 0) + 1 AS n FROM doa_matrix_versions')
  ).rows[0]!.n;
  // Supersede any active version from another test file's fixture (one-active
  // unique index) — safe: files sharing the DB create cc-scoped rules only.
  await db.query(`UPDATE doa_matrix_versions SET status = 'superseded', effective_to = now() WHERE status = 'active'`);
  const doaVersionId = (
    await db.query<{ id: string }>(
      `INSERT INTO doa_matrix_versions (version_no, status, effective_from, uploaded_by, approved_by, approved_at)
       VALUES ($1, 'active', now(), $2, $3, now()) RETURNING id`,
      [nextVersionNo, doaAdmin, fd],
    )
  ).rows[0]!.id;
  const seqA = JSON.stringify([{ type: 'job_title', value: titleA, label: 'Dept Manager' }]);
  const seqAB = JSON.stringify([
    { type: 'job_title', value: titleA, label: 'Dept Manager' },
    { type: 'job_title', value: titleB, label: 'Finance Manager' },
  ]);
  await db.query(
    `INSERT INTO doa_rules (version_id, category_id, cost_centre_id, min_amount, max_amount, currency, approval_sequence, requires_quotes)
     VALUES ($1, $2, $3, 0, 5000, 'TTD', $4, 0),
            ($1, $2, $3, 5000, NULL, 'TTD', $5, 1)`,
    [doaVersionId, actors.category, actors.ccLea, seqA, seqAB],
  );

  // Active budget 10000 via the governance walk (draft → pending → active)
  const period = (
    await db.query<{ p: string }>('SELECT fiscal_period_of(now()) AS p')
  ).rows[0]!.p;
  const budgetVersionId = (
    await db.query<{ id: string }>(
      `INSERT INTO budget_versions (cost_centre_id, period, version_no, reason, proposed_by)
       VALUES ($1, $2, 1, 'test fixture budget', $3) RETURNING id`,
      [actors.ccLea, period, budgetOwner],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO budgets (cost_centre_id, category_id, period, amount, currency, version, version_id)
     VALUES ($1, $2, $3, 10000, 'TTD', 1, $4)`,
    [actors.ccLea, actors.category, period, budgetVersionId],
  );
  await db.query(`UPDATE budget_versions SET status = 'pending_approval', submitted_at = now() WHERE id = $1`, [
    budgetVersionId,
  ]);
  await db.query(
    `UPDATE budget_versions SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`,
    [budgetVersionId, fd],
  );

  return {
    ...actors,
    approverB,
    doaAdmin,
    fd,
    accountant,
    budgetOwner,
    supplier,
    doaVersionId,
    budgetVersionId,
    titleA,
    titleB,
  };
}
