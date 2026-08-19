// Regression tests for the 2026-08-08 client change wave (migrations
// 0013/0014): tiered DOA descriptors, the Accounts finance_review final
// hurdle, the supplier request→approve workflow, admin user pre-provisioning
// with tiered role grants, and the requisition-list document enrichment.
// The legacy single-track chain stays covered by phase1-3.integration.test.ts
// (its fixture pins accounting_final_approval=false).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { listMigrationFiles, runMigrations } from '../src/db/migrate.js';
import { provisionUser } from '../src/auth/provision.js';
import { notifySupplierApproversBulk } from '../src/routes/suppliers.js';
import {
  createWorkflowFixture,
  RUN,
  testConfig,
  TEST_DATABASE_URL,
  testPool,
  type WorkflowFixture,
} from './helpers.js';

interface Session {
  cookie: string;
  csrf: string;
}

describe.skipIf(!TEST_DATABASE_URL)('change wave: tiers, accounts final review, suppliers, admin users', () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let fx: WorkflowFixture;
  let t5User: string;
  let t4User: string;

  async function loginAs(userId: string): Promise<Session> {
    const res = await app.inject({ method: 'GET', url: `/api/auth/dev-login?userId=${userId}` });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.find((c) => c.startsWith('msid=')) : setCookie;
    expect(raw).toBeTruthy();
    const cookie = raw!.split(';')[0]!;
    const csrfRes = await app.inject({ method: 'GET', url: '/api/csrf', headers: { cookie } });
    expect(csrfRes.statusCode).toBe(200);
    const s = { cookie, csrf: (csrfRes.json() as { token: string }).token };
    await app.inject({
      method: 'POST',
      url: '/api/me/acknowledge-banner',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    return s;
  }

  const post = (s: Session, url: string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });

  /** Create a draft via the API as the fixture requester. */
  async function createDraft(s: Session, amount: number): Promise<string> {
    const res = await post(s, '/api/requisitions', {
      costCentreId: fx.ccLea,
      categoryId: fx.category,
      description: `change-wave test ${RUN}`,
      justification: 'regression coverage',
      amount,
      currency: 'TTD',
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { requisition: { id: string } }).requisition.id;
  }

  async function stepsOf(requisitionId: string) {
    const { rows } = await db.query<{
      id: string;
      step_no: number;
      purpose: string;
      assigned_user_id: string;
      decision: string;
    }>(
      'SELECT id, step_no, purpose, assigned_user_id, decision FROM approval_steps WHERE requisition_id = $1 ORDER BY step_no',
      [requisitionId],
    );
    return rows;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    fx = await createWorkflowFixture(db);
    // This suite covers the DEFAULT (0014) behaviour: Accounts reviews last.
    await db.query(`UPDATE app_settings SET value = 'true'::jsonb WHERE key = 'accounting_final_approval'`);

    // Tier-holding approvers + a tier-routed DOA version superseding the
    // fixture's job-title one (rules of an active version are frozen, so a
    // fresh version is the only way to add tier rules).
    const u = async (slug: string, name: string) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO users (entra_object_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
          [`dev-${slug}-${RUN}`, `${slug}-${RUN}@example.test`, name],
        )
      ).rows[0]!.id;
    t5User = await u('tier5', 'Tier Five Supervisor');
    t4User = await u('tier4', 'Tier Four Manager');
    await db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, tier, granted_by, granted_reason)
       VALUES ($1, 'approver', $2, 5, $3, 'test setup'), ($4, 'approver', $2, 4, $3, 'test setup')`,
      [t5User, fx.ccLea, fx.sysadmin, t4User],
    );

    const versionNo = (
      await db.query<{ n: number }>('SELECT coalesce(max(version_no), 0) + 1 AS n FROM doa_matrix_versions')
    ).rows[0]!.n;
    await db.query(
      `UPDATE doa_matrix_versions SET status = 'superseded', effective_to = now() WHERE status = 'active'`,
    );
    const versionId = (
      await db.query<{ id: string }>(
        `INSERT INTO doa_matrix_versions (version_no, status, effective_from, uploaded_by, approved_by, approved_at)
         VALUES ($1, 'active', now(), $2, $3, now()) RETURNING id`,
        [versionNo, fx.doaAdmin, fx.fd],
      )
    ).rows[0]!.id;
    const seqT5 = JSON.stringify([{ type: 'tier', value: '5', label: 'Tier 5' }]);
    const seqT5T4 = JSON.stringify([
      { type: 'tier', value: '5', label: 'Tier 5' },
      { type: 'tier', value: '4', label: 'Tier 4' },
    ]);
    await db.query(
      `INSERT INTO doa_rules (version_id, category_id, cost_centre_id, min_amount, max_amount, currency, approval_sequence, requires_quotes)
       VALUES ($1, $2, $3, 0, 5000, 'TTD', $4, 0),
              ($1, $2, $3, 5000, NULL, 'TTD', $5, 0)`,
      [versionId, fx.category, fx.ccLea, seqT5, seqT5T4],
    );

    app = await buildApp(testConfig(), db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('routes tier descriptors to tier-granted approvers and appends the Accounts finance_review step', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 800);
    const submit = await post(requester, `/api/requisitions/${id}/submit`);
    expect(submit.statusCode).toBe(200);

    const steps = await stepsOf(id);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ step_no: 1, purpose: 'doa', assigned_user_id: t5User });
    expect(steps[1]).toMatchObject({ step_no: 2, purpose: 'finance_review' });
    // The finance reviewer holds the org-wide accounting role
    const holder = await db.query(
      `SELECT 1 FROM roles_assignments WHERE user_id = $1 AND role = 'accounting' AND revoked_at IS NULL`,
      [steps[1]!.assigned_user_id],
    );
    expect(holder.rows).toHaveLength(1);
  });

  it('keeps the requisition open until Accounts approves, then finalises', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 900);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const steps = await stepsOf(id);
    const financeStep = steps.find((s) => s.purpose === 'finance_review')!;

    // Accounts cannot jump the queue: the DOA step is still pending
    const reviewer = await loginAs(financeStep.assigned_user_id);
    const early = await post(reviewer, `/api/approvals/steps/${financeStep.id}/approve`);
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: string }).error).toBe('previous_step_pending');

    // Tier-5 approval is NOT final any more
    const t5 = await loginAs(t5User);
    const doaStep = steps.find((s) => s.purpose === 'doa')!;
    const first = await post(t5, `/api/approvals/steps/${doaStep.id}/approve`);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { final: boolean }).final).toBe(false);
    const midway = await db.query<{ status: string }>('SELECT status FROM requisitions WHERE id = $1', [id]);
    expect(midway.rows[0]!.status).toBe('submitted');

    // The DB state machine refuses approval while the finance step is pending
    await expect(
      db.query(
        `UPDATE requisitions SET status = 'approved', approved_at = now(), approval_reference = reference || '-APR'
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/undecided/);

    // The step shows in the reviewer's queue and their approval finalises
    const queue = await get(reviewer, '/api/approvals/queue');
    const mine = (queue.json() as { queue: { step_id: string }[] }).queue.map((q) => q.step_id);
    expect(mine).toContain(financeStep.id);
    const final = await post(reviewer, `/api/approvals/steps/${financeStep.id}/approve`);
    expect(final.statusCode).toBe(200);
    expect((final.json() as { final: boolean }).final).toBe(true);
    const done = await db.query<{ status: string; approval_reference: string | null }>(
      'SELECT status, approval_reference FROM requisitions WHERE id = $1',
      [id],
    );
    expect(done.rows[0]!.status).toBe('approved');
    expect(done.rows[0]!.approval_reference).toMatch(/-APR$/);
  });

  it('lets Accounts veto: denial of the finance_review step denies the requisition', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 700);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const steps = await stepsOf(id);
    const t5 = await loginAs(t5User);
    expect(
      (await post(t5, `/api/approvals/steps/${steps.find((s) => s.purpose === 'doa')!.id}/approve`)).statusCode,
    ).toBe(200);
    const financeStep = steps.find((s) => s.purpose === 'finance_review')!;
    const reviewer = await loginAs(financeStep.assigned_user_id);
    const deny = await post(reviewer, `/api/approvals/steps/${financeStep.id}/deny`, {
      reason: 'No budget cover for this line',
    });
    expect(deny.statusCode).toBe(200);
    const after = await db.query<{ status: string }>('SELECT status FROM requisitions WHERE id = $1', [id]);
    expect(after.rows[0]!.status).toBe('denied');
  });

  it('escalates above the Tier-5 band to the Tier-4 approver', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 6000);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const steps = await stepsOf(id);
    expect(steps.map((s) => s.purpose)).toEqual(['doa', 'doa', 'finance_review']);
    expect(steps[0]!.assigned_user_id).toBe(t5User);
    expect(steps[1]!.assigned_user_id).toBe(t4User);
  });

  it('SoD: accounting can never hold the requester role', async () => {
    await expect(
      db.query(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
         VALUES ($1, 'accounting', NULL, $2, 'sod test')`,
        [fx.requester, fx.sysadmin],
      ),
    ).rejects.toThrow(/segregation of duties/);
  });

  it('suppliers: Tier 5 requests, only active suppliers reach /api/reference, approval is two-person', async () => {
    const t5 = await loginAs(t5User);
    const name = `Island Tyres ${RUN}`;
    const created = await post(t5, '/api/suppliers/request', {
      name,
      cdkVendorRef: `CDK-${RUN}`,
      reason: 'Better fleet pricing',
    });
    expect(created.statusCode).toBe(201);
    const supplierId = (created.json() as { id: string }).id;

    // Not usable while pending
    const refPending = await get(t5, '/api/reference');
    const namesPending = (refPending.json() as { suppliers: { name: string }[] }).suppliers.map((s) => s.name);
    expect(namesPending).not.toContain(name);

    // A non-holder of supplier_approver cannot decide
    expect((await post(t5, `/api/suppliers/${supplierId}/approve`)).statusCode).toBe(403);

    // Grant supplier_approver to the Tier-4 manager; their approval activates
    await db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, 'supplier_approver', NULL, $2, 'test setup')`,
      [t4User, fx.sysadmin],
    );
    const t4 = await loginAs(t4User);
    expect((await post(t4, `/api/suppliers/${supplierId}/approve`)).statusCode).toBe(200);
    const refActive = await get(t5, '/api/reference');
    const namesActive = (refActive.json() as { suppliers: { name: string }[] }).suppliers.map((s) => s.name);
    expect(namesActive).toContain(name);

    // Two-person rule: the requester of a supplier can never approve it
    const own = await post(t4, '/api/suppliers/request', { name: `Own Goal ${RUN}`, reason: 'testing self-approval' });
    expect(own.statusCode).toBe(201);
    const ownId = (own.json() as { id: string }).id;
    const self = await post(t4, `/api/suppliers/${ownId}/approve`);
    expect(self.statusCode).toBe(403);
    expect((self.json() as { error: string }).error).toBe('supplier_self_approval_forbidden');
  });

  it('admin: pre-provisions a user, grants a tiered role, and the row is claimed by email at first login', async () => {
    const admin = await loginAs(fx.sysadmin);
    const email = `newhire-${RUN}@example.test`;
    const created = await post(admin, '/api/admin/users', {
      email,
      displayName: 'New Hire',
      jobTitle: 'Fleet Supervisor',
      homeCostCentreId: fx.ccLea,
    });
    expect(created.statusCode).toBe(201);
    const userId = (created.json() as { id: string }).id;

    const granted = await post(admin, `/api/admin/users/${userId}/roles`, {
      role: 'approver',
      costCentreId: fx.ccLea,
      tier: 5,
      reason: 'initial access',
    });
    expect(granted.statusCode).toBe(200);

    const list = await get(admin, '/api/admin/users');
    const row = (list.json() as { users: { id: string; pending_first_login: boolean; home_department: string | null; roles: { role: string; tier: number | null }[] }[] }).users.find(
      (u) => u.id === userId,
    )!;
    expect(row.pending_first_login).toBe(true);
    expect(row.home_department).toBe('Test');
    expect(row.roles).toContainEqual(expect.objectContaining({ role: 'approver', tier: 5 }));

    // First real sign-in claims the pre-provisioned row by email
    const claimed = await provisionUser(db, { entraObjectId: `entra-${RUN}`, email, displayName: 'New Hire' }, {});
    expect(claimed.id).toBe(userId);
    const after = await db.query<{ entra_object_id: string }>('SELECT entra_object_id FROM users WHERE id = $1', [
      userId,
    ]);
    expect(after.rows[0]!.entra_object_id).toBe(`entra-${RUN}`);
    // Claiming a ROLE-BEARING pending row raises a review alert: the email
    // match is the only binding check, so every such claim gets eyes on it.
    const claimAlert = await db.query<{ severity: string; details: { roles?: string[] } }>(
      `SELECT severity, details FROM alerts
       WHERE rule = 'pre_provisioned_role_claim' AND details->>'userId' = $1`,
      [userId],
    );
    expect(claimAlert.rows).toHaveLength(1);
    expect(claimAlert.rows[0]!.severity).toBe('warning'); // approver is not in the critical set
    expect(claimAlert.rows[0]!.details.roles).toContain('approver');
    // Duplicate email is refused
    const dup = await post(admin, '/api/admin/users', { email, displayName: 'Dup' });
    expect(dup.statusCode).toBe(409);
  });

  it('requisition list rows carry department and quotation/invoice documents', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 450);
    await db.query(
      `INSERT INTO attachments (requisition_id, type, filename, content_type, size_bytes, sha256, storage_key, scan_status, uploaded_by)
       VALUES ($1, 'quote', 'quote-${RUN}.pdf', 'application/pdf', 100, $2, $3, 'clean', $4)`,
      [id, 'b'.repeat(64), `${RUN}quotekey`.padEnd(48, '0'), fx.requester],
    );
    const list = await get(requester, '/api/requisitions?mine=true&limit=200');
    expect(list.statusCode).toBe(200);
    const row = (list.json() as { requisitions: { id: string; department: string; quote_files: { filename: string; scan_status: string }[]; invoice_files: unknown[] }[] }).requisitions.find(
      (r) => r.id === id,
    )!;
    expect(row.department).toBe('Test');
    expect(row.quote_files).toHaveLength(1);
    expect(row.quote_files[0]).toMatchObject({ filename: `quote-${RUN}.pdf`, scan_status: 'clean' });
    expect(row.invoice_files).toHaveLength(0);
  });

  it('/api/me reports the home department set by the admin', async () => {
    const admin = await loginAs(fx.sysadmin);
    expect(
      (
        await post(admin, `/api/admin/users/${fx.requester}/department`, { homeCostCentreId: fx.ccLea })
      ).statusCode,
    ).toBe(200);
    const requester = await loginAs(fx.requester);
    const me = await get(requester, '/api/me');
    expect((me.json() as { department: { department: string } }).department.department).toBe('Test');
  });

  // ── Review-fix regressions (2026-08-09 wave corrections) ───────────────────

  async function makeUser(slug: string, name: string): Promise<string> {
    return (
      await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [`dev-${slug}-${RUN}`, `${slug}-${RUN}@example.test`, name],
      )
    ).rows[0]!.id;
  }
  const grantOrgRole = (userId: string, role: string) =>
    db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, $2, NULL, $3, 'test setup')`,
      [userId, role, fx.sysadmin],
    );

  it('supplier control: non-active suppliers are blocked at create, PATCH, submit and by the DB', async () => {
    const t5 = await loginAs(t5User);
    const requester = await loginAs(fx.requester);

    // The exact bypass path the review found: request a supplier and read the
    // pending id straight out of the 201 response.
    const created = await post(t5, '/api/suppliers/request', {
      name: `Shady Ltd ${RUN}`,
      reason: 'bypass-attempt coverage',
    });
    expect(created.statusCode).toBe(201);
    const pendingId = (created.json() as { id: string }).id;

    // Blocked at draft create
    const atCreate = await post(requester, '/api/requisitions', {
      costCentreId: fx.ccLea,
      categoryId: fx.category,
      supplierId: pendingId,
      description: `supplier gate ${RUN}`,
      justification: 'regression coverage',
      amount: 300,
      currency: 'TTD',
    });
    expect(atCreate.statusCode).toBe(400);
    expect((atCreate.json() as { error: string }).error).toBe('supplier_not_active');

    // Blocked at PATCH
    const draftId = await createDraft(requester, 310);
    const atPatch = await app.inject({
      method: 'PATCH',
      url: `/api/requisitions/${draftId}`,
      headers: { cookie: requester.cookie, 'x-csrf-token': requester.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId: pendingId }),
    });
    expect(atPatch.statusCode).toBe(400);
    expect((atPatch.json() as { error: string }).error).toBe('supplier_not_active');

    // Attach while ACTIVE, then deactivate before submitting: submit is the
    // authoritative gate because the supplier can change under the draft.
    await db.query(
      `UPDATE suppliers SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`,
      [pendingId, t4User],
    );
    const attach = await app.inject({
      method: 'PATCH',
      url: `/api/requisitions/${draftId}`,
      headers: { cookie: requester.cookie, 'x-csrf-token': requester.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId: pendingId }),
    });
    expect(attach.statusCode).toBe(200);
    await db.query(`UPDATE suppliers SET status = 'inactive' WHERE id = $1`, [pendingId]);
    const atSubmit = await post(requester, `/api/requisitions/${draftId}/submit`);
    expect(atSubmit.statusCode).toBe(422);
    expect((atSubmit.json() as { error: string }).error).toBe('supplier_not_active');

    // Reactivated → submit passes
    await db.query(`UPDATE suppliers SET status = 'active' WHERE id = $1`, [pendingId]);
    expect((await post(requester, `/api/requisitions/${draftId}/submit`)).statusCode).toBe(200);

    // DB defence-in-depth: a direct submitted flip re-checks the supplier too
    const second = await post(t5, '/api/suppliers/request', {
      name: `Shady Two ${RUN}`,
      reason: 'bypass-attempt coverage',
    });
    const pendingId2 = (second.json() as { id: string }).id;
    const rawDraft = await createDraft(requester, 320);
    await db.query(`UPDATE requisitions SET supplier_id = $2 WHERE id = $1`, [rawDraft, pendingId2]);
    await expect(
      db.query(`UPDATE requisitions SET status = 'submitted', submitted_at = now() WHERE id = $1`, [rawDraft]),
    ).rejects.toThrow(/active\) supplier/);
  });

  it('revoking the accounting role reassigns pending finance_review steps, or alerts when nobody remains', async () => {
    // The suite DB is shared across test files, each of which seeds its own
    // accountant — pin the pool to exactly the holders this test controls
    // (earlier files have already finished; every fixture creates fresh
    // users, so revoking their leftovers affects nothing).
    await db.query(
      `UPDATE roles_assignments
       SET revoked_at = now(), revoked_by = $2, revoked_reason = 'change-wave revoke-test isolation'
       WHERE role = 'accounting' AND revoked_at IS NULL AND user_id <> $1`,
      [fx.accountant, fx.sysadmin],
    );
    const acctB = await makeUser('acctb', 'Second Accountant');
    await grantOrgRole(acctB, 'accounting');

    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 420);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const financeStep = (await stepsOf(id)).find((s) => s.purpose === 'finance_review')!;
    expect(financeStep.assigned_user_id).toBe(fx.accountant); // earliest grant

    // Revoke the assignee's accounting grant through the API — before the fix
    // this path never ran reassignment (it was approver-only) and the step
    // stayed stranded with no alert.
    const admin = await loginAs(fx.sysadmin);
    const grantA = (
      await db.query<{ id: string }>(
        `SELECT id FROM roles_assignments WHERE user_id = $1 AND role = 'accounting' AND revoked_at IS NULL`,
        [fx.accountant],
      )
    ).rows[0]!;
    expect((await post(admin, `/api/admin/roles/${grantA.id}/revoke`, { reason: 'changed desks' })).statusCode).toBe(
      200,
    );
    const moved = (await stepsOf(id)).find((s) => s.purpose === 'finance_review')!;
    expect(moved.assigned_user_id).toBe(acctB);

    // Revoking the LAST holder raises the unassignable alert
    const grantB = (
      await db.query<{ id: string }>(
        `SELECT id FROM roles_assignments WHERE user_id = $1 AND role = 'accounting' AND revoked_at IS NULL`,
        [acctB],
      )
    ).rows[0]!;
    expect((await post(admin, `/api/admin/roles/${grantB.id}/revoke`, { reason: 'also leaving' })).statusCode).toBe(
      200,
    );
    const alert = await db.query(
      `SELECT 1 FROM alerts WHERE rule = 'approval_step_unassignable' AND details->>'stepId' = $1`,
      [financeStep.id],
    );
    expect(alert.rows).toHaveLength(1);

    // Restore the fixture accountant for the remaining tests
    await grantOrgRole(fx.accountant, 'accounting');
  });

  it('finance_review is role-addressed: any accounting holder may pick it up and decide', async () => {
    const acctC = await makeUser('acctc', 'Covering Accountant');
    await grantOrgRole(acctC, 'accounting');

    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 480);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const steps = await stepsOf(id);
    const financeStep = steps.find((s) => s.purpose === 'finance_review')!;
    expect(financeStep.assigned_user_id).not.toBe(acctC); // nominally addressed to the earliest holder

    const t5 = await loginAs(t5User);
    expect(
      (await post(t5, `/api/approvals/steps/${steps.find((s) => s.purpose === 'doa')!.id}/approve`)).statusCode,
    ).toBe(200);

    // The step surfaces in the OTHER holder's queue as a role pickup — not a
    // delegation (accounting can never delegate: SoD bars it from approver).
    const c = await loginAs(acctC);
    const queue = (await get(c, '/api/approvals/queue')).json() as {
      queue: { step_id: string; via_delegation: boolean }[];
    };
    const mine = queue.queue.find((q) => q.step_id === financeStep.id);
    expect(mine).toBeTruthy();
    expect(mine!.via_delegation).toBe(false);

    // ...and they can decide it; the decision is stamped with the decider.
    const final = await post(c, `/api/approvals/steps/${financeStep.id}/approve`);
    expect(final.statusCode).toBe(200);
    expect((final.json() as { final: boolean }).final).toBe(true);
    const decided = (await stepsOf(id)).find((s) => s.purpose === 'finance_review')!;
    expect(decided).toMatchObject({ assigned_user_id: acctC, decision: 'approved' });
    const done = await db.query<{ status: string }>('SELECT status FROM requisitions WHERE id = $1', [id]);
    expect(done.rows[0]!.status).toBe('approved');
  });

  it('under the non-owner massy_app role the decide() sequence persists the requisition flip', async () => {
    const requester = await loginAs(fx.requester);
    const id = await createDraft(requester, 650);
    expect((await post(requester, `/api/requisitions/${id}/submit`)).statusCode).toBe(200);
    const steps = await stepsOf(id);
    const t5 = await loginAs(t5User);
    expect(
      (await post(t5, `/api/approvals/steps/${steps.find((s) => s.purpose === 'doa')!.id}/approve`)).statusCode,
    ).toBe(200);
    const financeStep = steps.find((s) => s.purpose === 'finance_review')!;

    // A different accounting holder performs the role pickup — replaying the
    // decide() statement order verbatim under RLS. Step first, requisition
    // second: before the 0014 policy fix the second UPDATE matched 0 rows
    // (the silent finalisation no-op) because no pending step remained.
    const acctD = await makeUser('acctd', 'RLS Accountant');
    await grantOrgRole(acctD, 'accounting');
    await db.query('GRANT massy_app TO current_user');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE massy_app');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [acctD]);
      const stepUpd = await client.query(
        `UPDATE approval_steps SET decision = 'approved', decided_at = now(), assigned_user_id = $2
         WHERE id = $1 AND decision = 'pending'`,
        [financeStep.id, acctD],
      );
      expect(stepUpd.rowCount).toBe(1);
      const reqUpd = await client.query(
        `UPDATE requisitions
         SET status = 'approved', approved_at = now(), approval_reference = reference || '-APR', updated_at = now()
         WHERE id = $1`,
        [id],
      );
      expect(reqUpd.rowCount).toBe(1);
      // The accounting arm covers the approved → closed flip on final posting
      const closeUpd = await client.query(
        `UPDATE requisitions SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      expect(closeUpd.rowCount).toBe(1);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
    const final = await db.query<{ status: string; approval_reference: string | null }>(
      'SELECT status, approval_reference FROM requisitions WHERE id = $1',
      [id],
    );
    expect(final.rows[0]!.status).toBe('closed');
    expect(final.rows[0]!.approval_reference).toMatch(/-APR$/);
  });

  it('SoD: accounting can never be combined with doa_admin or doa_approver', async () => {
    await expect(
      db.query(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
         VALUES ($1, 'accounting', NULL, $2, 'sod test')`,
        [fx.doaAdmin, fx.sysadmin],
      ),
    ).rejects.toThrow(/segregation of duties/);
    await expect(
      db.query(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
         VALUES ($1, 'accounting', NULL, $2, 'sod test')`,
        [fx.fd, fx.sysadmin],
      ),
    ).rejects.toThrow(/segregation of duties/);
  });

  it('supplier records: live-name uniqueness, terminal rejection, frozen evidence (DB backstop)', async () => {
    const name = `Integrity Motors ${RUN}`;
    const sup = (
      await db.query<{ id: string }>(
        `INSERT INTO suppliers (name, status, requested_by, requested_at, requested_reason)
         VALUES ($1, 'pending_approval', $2, now(), 'integrity test') RETURNING id`,
        [name, t5User],
      )
    ).rows[0]!.id;

    // Partial unique index: a concurrent duplicate can no longer slip past
    // the friendly read-then-insert check (case-insensitive)
    await expect(
      db.query(`INSERT INTO suppliers (name, status) VALUES ($1, 'pending_approval')`, [name.toUpperCase()]),
    ).rejects.toThrow(/suppliers_live_name_uq|duplicate key/);

    // 'active' without approval evidence is impossible for requested rows
    await expect(db.query(`UPDATE suppliers SET status = 'active' WHERE id = $1`, [sup])).rejects.toThrow(
      /supplier_active_requires_approval/,
    );
    // 'rejected' without who/when/why is impossible
    await expect(db.query(`UPDATE suppliers SET status = 'rejected' WHERE id = $1`, [sup])).rejects.toThrow(
      /supplier_rejection_is_complete/,
    );
    // approval evidence is writable only by the approving transition
    await expect(
      db.query(`UPDATE suppliers SET approved_by = $2, approved_at = now() WHERE id = $1`, [sup, t4User]),
    ).rejects.toThrow(/approving transition/);

    // A legitimate rejection is terminal — no silent resurrection
    await db.query(
      `UPDATE suppliers
       SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = 'integrity test'
       WHERE id = $1`,
      [sup, t4User],
    );
    await expect(
      db.query(
        `UPDATE suppliers
         SET status = 'pending_approval', rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
         WHERE id = $1`,
        [sup],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('admin: pre-provision respects the allowed_email_domains allowlist', async () => {
    await db.query(`UPDATE app_settings SET value = '["example.test"]'::jsonb WHERE key = 'allowed_email_domains'`);
    try {
      const admin = await loginAs(fx.sysadmin);
      const blocked = await post(admin, '/api/admin/users', {
        email: `outsider-${RUN}@massy-other.example`,
        displayName: 'Outsider',
      });
      expect(blocked.statusCode).toBe(400);
      expect((blocked.json() as { error: string }).error).toBe('email_domain_not_allowed');
      const allowed = await post(admin, '/api/admin/users', {
        email: `insider-${RUN}@example.test`,
        displayName: 'Insider',
      });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await db.query(`UPDATE app_settings SET value = '[]'::jsonb WHERE key = 'allowed_email_domains'`);
    }
  });

  it('bulk supplier notification digests to one counted message per approver', async () => {
    const supApprover = await makeUser('supappr', 'Bulk Supplier Approver');
    await grantOrgRole(supApprover, 'supplier_approver');
    await notifySupplierApproversBulk(db, fx.sysadmin, 12);
    const outbox = await db.query<{ subject: string; recipient_user_id: string }>(
      `SELECT subject, recipient_user_id FROM notification_outbox WHERE template = 'supplier_bulk_approval_requested'`,
    );
    expect(outbox.rows.some((r) => r.recipient_user_id === supApprover)).toBe(true);
    expect(outbox.rows[0]!.subject).toBe('12 supplier requests await your approval');
  });

  it('the startup guard inventory agrees with the applied migration ledger', async () => {
    const files = await listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const f of files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    const { rows } = await db.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations');
    const ledger = new Map(rows.map((r) => [r.name, r.sha256]));
    for (const f of files) expect(ledger.get(f.name)).toBe(f.sha256);
  });
});
