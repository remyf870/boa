// Phases 1-3 compliance and behaviour gates (§8.1) through the real app:
// requisition lifecycle, DOA engine + self-approval block (A.5.3), delegation,
// quotes gate, budget governance + live tracker (§5.9), attachments/EICAR
// (A.8.7), invoice variance re-approval (§5.4), accounting, exports (A.8.12),
// dashboard, and the masked reporting schema (A.8.11).
// ONE file on purpose: the "active DOA version" is global state, and vitest
// runs tests within a file sequentially.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { eventBus } from '../src/events/bus.js';
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

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const EICAR_IN_PDF = Buffer.from(
  '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n',
);

function multipart(
  fields: Record<string, string>,
  file: { name: string; filename: string; contentType: string; data: Buffer },
): { payload: Buffer; contentType: string } {
  const boundary = `----massyTestBoundary${RUN}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `content-type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function xlsxBuffer(headerRow: string[], rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headerRow);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!TEST_DATABASE_URL)('Phases 1-3 (§5.1-§5.9, §6.1-§6.3)', () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let fx: WorkflowFixture;
  let period: string;
  let delegateUser: string;
  // State threaded through the ordered flow tests
  let reqA: string; // 4000, single-step, approved
  let reqAref = '';
  let reqB: string; // 6000, two-step, approved via delegate
  let reqBref = '';

  async function loginAs(userId: string): Promise<Session> {
    const res = await app.inject({ method: 'GET', url: `/api/auth/dev-login?userId=${userId}` });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.find((c) => c.startsWith('msid=')) : setCookie;
    const cookie = raw!.split(';')[0]!;
    const csrfRes = await app.inject({ method: 'GET', url: '/api/csrf', headers: { cookie } });
    const s = { cookie, csrf: (csrfRes.json() as { token: string }).token };
    await app.inject({
      method: 'POST',
      url: '/api/me/acknowledge-banner',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    return s;
  }

  const post = (s: Session, url: string, body?: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
      payload: body === undefined ? '{}' : JSON.stringify(body),
    });
  const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const upload = (
    s: Session,
    url: string,
    fields: Record<string, string>,
    file: { filename: string; contentType: string; data: Buffer },
  ) => {
    const m = multipart(fields, { name: 'file', ...file });
    return app.inject({
      method: 'POST',
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': m.contentType },
      payload: m.payload,
    });
  };

  async function createDraft(s: Session, amount: number): Promise<{ id: string; reference: string }> {
    const res = await post(s, '/api/requisitions', {
      costCentreId: fx.ccLea,
      categoryId: fx.category,
      supplierId: fx.supplier,
      description: `Test purchase ${RUN}`,
      justification: 'Integration test',
      amount,
      currency: 'TTD',
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { requisition: { id: string; reference: string } }).requisition;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    fx = await createWorkflowFixture(db);
    period = (await db.query<{ p: string }>('SELECT fiscal_period_of(now()) AS p')).rows[0]!.p;
    const del = await db.query<{ id: string }>(
      `INSERT INTO users (entra_object_id, email, display_name, job_title)
       VALUES ($1, $2, 'Delegate User', 'Deputy Manager') RETURNING id`,
      [`dev-delegate-${RUN}`, `delegate-${RUN}@example.test`],
    );
    delegateUser = del.rows[0]!.id;
    await db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, 'approver', $2, $3, 'test setup')`,
      [delegateUser, fx.ccLea, fx.sysadmin],
    );
    app = await buildApp(testConfig(), db);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  // ── §5.1 live preview ───────────────────────────────────────────────────────
  it('§5.1: the form preview shows the resolved route and the budget impact', async () => {
    const s = await loginAs(fx.requester);
    const res = await post(s, '/api/requisitions/preview', {
      costCentreId: fx.ccLea,
      categoryId: fx.category,
      amount: 6000,
      currency: 'TTD',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      route: { label: string; approverName: string }[];
      requiresQuotes: number;
      budget: { available: string; afterThisRequest: string };
    };
    expect(body.route.map((r) => r.label)).toEqual(['Dept Manager', 'Finance Manager']);
    expect(body.requiresQuotes).toBe(1);
    expect(body.budget.available).toBe('10000.00');
    expect(body.budget.afterThisRequest).toBe('4000.00');
  });

  // ── Core lifecycle: draft → submit → approve → reference issued ────────────
  it('§5.2/§5.3: single-step requisition is approved, reference issued, budget committed live', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 4000);
    reqA = draft.id;
    reqAref = draft.reference;
    expect(draft.reference).toMatch(/^MM-T/);

    const submit = await post(requester, `/api/requisitions/${reqA}/submit`);
    expect(submit.statusCode).toBe(200);
    const steps = await db.query<{ id: string; assigned_user_id: string }>(
      `SELECT id, assigned_user_id FROM approval_steps WHERE requisition_id = $1 ORDER BY step_no`,
      [reqA],
    );
    expect(steps.rows).toHaveLength(1);
    expect(steps.rows[0]!.assigned_user_id).toBe(fx.approver);

    // The snapshot froze the rule (plan §4 design rule 1)
    const snap = await db.query<{ s: { rule: { requiresQuotes: number } } }>(
      'SELECT doa_rule_snapshot AS s FROM requisitions WHERE id = $1',
      [reqA],
    );
    expect(snap.rows[0]!.s.rule).toBeTruthy();

    // Approver sees the projected balance and approves; the live event fires
    const approver = await loginAs(fx.approver);
    const events: unknown[] = [];
    const unsubscribe = eventBus.onBudgetChanged((e) => events.push(e));
    const decide = await post(approver, `/api/approvals/steps/${steps.rows[0]!.id}/approve`);
    unsubscribe();
    expect(decide.statusCode).toBe(200);
    const decideBody = decide.json() as { final: boolean; approvalReference: string };
    expect(decideBody.final).toBe(true);
    expect(decideBody.approvalReference).toBe(`${reqAref}-APR`);
    expect(events).toContainEqual({ costCentreId: fx.ccLea, cause: 'requisition_approved' });

    const after = await db.query<{ status: string; approved_at: Date | null; approval_reference: string | null }>(
      'SELECT status, approved_at, approval_reference FROM requisitions WHERE id = $1',
      [reqA],
    );
    expect(after.rows[0]!.status).toBe('approved');
    expect(after.rows[0]!.approved_at).toBeTruthy();

    // budget_remaining_at_decision was recorded on the step (plan §4 rule 2)
    const decidedStep = await db.query<{ budget_remaining_at_decision: string }>(
      'SELECT budget_remaining_at_decision FROM approval_steps WHERE id = $1',
      [steps.rows[0]!.id],
    );
    expect(Number(decidedStep.rows[0]!.budget_remaining_at_decision)).toBe(6000);

    // Live position: committed immediately (§5.9)
    const position = await get(requester, `/api/budget-position?costCentreId=${fx.ccLea}&period=${period}`);
    expect(position.statusCode).toBe(200);
    const totals = (position.json() as { totals: { committed: string; available: string } }).totals;
    expect(totals.committed).toBe('4000.00');
    expect(totals.available).toBe('6000.00');
  });

  it('A.5.14: notification emails carry references and deep links only — never amounts or supplier names', async () => {
    const { rows } = await db.query<{ subject: string; deep_link: string; context: unknown }>(
      `SELECT subject, deep_link, context FROM notification_outbox n
       JOIN users u ON u.id = n.recipient_user_id
       WHERE u.entra_object_id LIKE $1`,
      [`dev-%-${RUN}`],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = `${row.subject} ${row.deep_link} ${JSON.stringify(row.context)}`;
      expect(text).not.toMatch(/4000|6000/);
      expect(text).not.toContain(`Test Supplier ${RUN}`);
    }
  });

  it('A.5.3: self-approval via the API returns 403 and an audit entry', async () => {
    // A mis-built chain (simulated): a step assigned to the requester themselves
    const ref = `MM-TSELF-${RUN}`;
    const snapshot = JSON.stringify({ simulated: true });
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification,
                                 amount, currency, status, doa_version_id, doa_rule_snapshot, submitted_at)
       VALUES ($1, $2, $3, $4, 'self approval probe', 'test', 100, 'TTD', 'submitted', $5, $6, now())
       RETURNING id`,
      [ref, fx.requester, fx.ccLea, fx.category, fx.doaVersionId, snapshot],
    );
    const step = await db.query<{ id: string }>(
      `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id)
       VALUES ($1, 1, 'Probe', $2) RETURNING id`,
      [inserted.rows[0]!.id, fx.requester],
    );
    const s = await loginAs(fx.requester);
    const res = await post(s, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('self_approval_forbidden');
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'approval.self_approval_blocked' AND actor_user_id = $1`,
      [fx.requester],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('§3: nobody approves against a DOA version they uploaded or activated', async () => {
    // Layer 1 (structural): the role combination is impossible — SoD refuses
    // approver to anyone holding doa_approver (migration 0010).
    const sysadminSession = await loginAs(fx.sysadmin);
    const refusedGrant = await post(sysadminSession, `/api/admin/users/${fx.fd}/roles`, {
      role: 'approver',
      costCentreId: fx.ccLea,
      reason: 'SoD probe — DOA activator must not approve',
    });
    expect(refusedGrant.statusCode).toBe(409);
    expect((refusedGrant.json() as { error: string }).error).toBe('segregation_of_duties_conflict');

    // Layer 2 (defence in depth): even if such a data state were reached by
    // another route, the decision endpoint refuses it — for EVERY step
    // purpose, including variance re-approval. Construct the state directly.
    const probeApprover = (
      await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title)
         VALUES ($1, $2, 'DOA Conflict Probe', 'Probe Approver') RETURNING id`,
        [`dev-doaconf-${RUN}`, `doaconf-${RUN}@example.test`],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, 'approver', $2, $3, 'test setup')`,
      [probeApprover, fx.ccLea, fx.sysadmin],
    );
    // Data state the role model forbids: this approver is recorded as the
    // activator of the version the requisition was judged under.
    const probeVersion = (
      await db.query<{ id: string }>(
        `INSERT INTO doa_matrix_versions (version_no, status, uploaded_by, approved_by, approved_at)
         VALUES ((SELECT coalesce(max(version_no), 0) + 1 FROM doa_matrix_versions), 'draft', $1, $2, now())
         RETURNING id`,
        [fx.doaAdmin, probeApprover],
      )
    ).rows[0]!.id;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification,
                                 amount, currency, status, doa_version_id, doa_rule_snapshot, submitted_at)
       VALUES ($1, $2, $3, $4, 'doa conflict probe', 'test', 100, 'TTD', 'submitted', $5, '{}'::jsonb, now())
       RETURNING id`,
      [`MM-TDOACONF-${RUN}`, fx.requester, fx.ccLea, fx.category, probeVersion],
    );
    const step = await db.query<{ id: string }>(
      `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id)
       VALUES ($1, 1, 'Probe', $2) RETURNING id`,
      [inserted.rows[0]!.id, probeApprover],
    );
    const s = await loginAs(probeApprover);
    const res = await post(s, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('doa_version_conflict');
  });

  it('A.5.18: revoking the approver role removes decision power within one request', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 450);
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    const step = await db.query<{ id: string; assigned_user_id: string }>(
      `SELECT id, assigned_user_id FROM approval_steps WHERE requisition_id = $1 AND step_no = 1`,
      [draft.id],
    );
    expect(step.rows[0]!.assigned_user_id).toBe(fx.approver);

    // The step is assigned and visible...
    const approver = await loginAs(fx.approver);
    const before = await get(approver, '/api/approvals/queue');
    expect((before.json() as { queue: { step_id: string }[] }).queue.some((q) => q.step_id === step.rows[0]!.id)).toBe(
      true,
    );

    // ...then the grant is revoked.
    const grant = await db.query<{ id: string }>(
      `SELECT id FROM roles_assignments
       WHERE user_id = $1 AND role = 'approver' AND cost_centre_id = $2 AND revoked_at IS NULL`,
      [fx.approver, fx.ccLea],
    );
    const sysadmin = await loginAs(fx.sysadmin);
    expect(
      (await post(sysadmin, `/api/admin/roles/${grant.rows[0]!.id}/revoke`, { reason: 'test: revocation is immediate' }))
        .statusCode,
    ).toBe(200);

    // Queue empties and the decision is refused on the very next request
    const after = await get(approver, '/api/approvals/queue');
    expect((after.json() as { queue: { step_id: string }[] }).queue.some((q) => q.step_id === step.rows[0]!.id)).toBe(
      false,
    );
    const decide = await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    expect(decide.statusCode).toBe(403);
    expect((decide.json() as { error: string }).error).toBe('approver_role_not_held');
    const stillPending = await db.query<{ decision: string }>('SELECT decision FROM approval_steps WHERE id = $1', [
      step.rows[0]!.id,
    ]);
    expect(stillPending.rows[0]!.decision).toBe('pending');

    // restore for the remaining tests
    await db.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, 'approver', $2, $3, 'test: restore after revocation test')`,
      [fx.approver, fx.ccLea, fx.sysadmin],
    );
  });

  it('§5.2: denial requires a reason, ends the chain, and notifies the requester', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 900);
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    const step = await db.query<{ id: string }>(
      `SELECT id FROM approval_steps WHERE requisition_id = $1 AND step_no = 1`,
      [draft.id],
    );
    const approver = await loginAs(fx.approver);
    const noReason = await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/deny`);
    expect(noReason.statusCode).toBe(400);
    expect((noReason.json() as { error: string }).error).toBe('denial_reason_required');

    const denied = await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/deny`, {
      reason: 'Not budgeted this quarter',
    });
    expect(denied.statusCode).toBe(200);
    const after = await db.query<{ status: string; closed_at: Date | null }>(
      'SELECT status, closed_at FROM requisitions WHERE id = $1',
      [draft.id],
    );
    expect(after.rows[0]!.status).toBe('denied');
    expect(after.rows[0]!.closed_at).toBeTruthy();
    const outbox = await db.query(
      `SELECT 1 FROM notification_outbox WHERE recipient_user_id = $1 AND template = 'requisition_denied'`,
      [fx.requester],
    );
    expect(outbox.rows.length).toBeGreaterThan(0);
  });

  it('§5.1/§5.2: the quotes gate blocks submission; sequential steps gate; a delegate decides with both identities recorded', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 6000);
    reqB = draft.id;
    reqBref = draft.reference;

    // requires_quotes = 1 for the 5000+ band
    const blocked = await post(requester, `/api/requisitions/${reqB}/submit`);
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { error: string }).error).toBe('quotes_required');

    const uploaded = await upload(requester, `/api/requisitions/${reqB}/attachments`, { type: 'quote' }, {
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      data: PDF_BYTES,
    });
    expect(uploaded.statusCode).toBe(201);

    const submit = await post(requester, `/api/requisitions/${reqB}/submit`);
    expect(submit.statusCode).toBe(200);
    // Submitted requisitions are frozen (A.5.33)
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/requisitions/${reqB}`,
      headers: { cookie: requester.cookie, 'x-csrf-token': requester.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(edit.statusCode).toBe(409);

    const steps = await db.query<{ id: string; step_no: number; assigned_user_id: string }>(
      `SELECT id, step_no, assigned_user_id FROM approval_steps WHERE requisition_id = $1 ORDER BY step_no`,
      [reqB],
    );
    expect(steps.rows).toHaveLength(2);

    // Step 2 cannot be decided before step 1 (§5.2 sequential)
    const approverB = await loginAs(fx.approverB);
    const early = await post(approverB, `/api/approvals/steps/${steps.rows[1]!.id}/approve`);
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: string }).error).toBe('previous_step_pending');

    const approverA = await loginAs(fx.approver);
    expect((await post(approverA, `/api/approvals/steps/${steps.rows[0]!.id}/approve`)).statusCode).toBe(200);

    // approverB delegates to delegateUser for a live window (§5.2)
    const delegation = await post(approverB, '/api/delegations', {
      delegateEmail: `delegate-${RUN}@example.test`,
      costCentreId: fx.ccLea,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'Annual leave cover',
    });
    expect(delegation.statusCode).toBe(201);

    const delegate = await loginAs(delegateUser);
    const queue = await get(delegate, '/api/approvals/queue');
    const queued = (queue.json() as { queue: { step_id: string; via_delegation: boolean }[] }).queue;
    expect(queued.some((q) => q.step_id === steps.rows[1]!.id && q.via_delegation)).toBe(true);

    const decide = await post(delegate, `/api/approvals/steps/${steps.rows[1]!.id}/approve`);
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { final: boolean }).final).toBe(true);

    // Both identities recorded (§4 approval_steps.delegate_of_user_id)
    const decided = await db.query<{ assigned_user_id: string; delegate_of_user_id: string }>(
      'SELECT assigned_user_id, delegate_of_user_id FROM approval_steps WHERE id = $1',
      [steps.rows[1]!.id],
    );
    expect(decided.rows[0]!.assigned_user_id).toBe(delegateUser);
    expect(decided.rows[0]!.delegate_of_user_id).toBe(fx.approverB);

    const after = await db.query<{ status: string; approval_reference: string }>(
      'SELECT status, approval_reference FROM requisitions WHERE id = $1',
      [reqB],
    );
    expect(after.rows[0]!.status).toBe('approved');
    expect(after.rows[0]!.approval_reference).toBe(`${reqBref}-APR`);
  });

  it('§5.3: the approval certificate PDF is produced, labelled and audited', async () => {
    const s = await loginAs(fx.requester);
    const res = await get(s, `/api/requisitions/${reqA}/certificate.pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'data.export' AND entity_id = $1`,
      [`approval-certificate:${reqAref}`],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  // ── Attachments (A.8.7) ────────────────────────────────────────────────────
  it('A.8.7: an EICAR upload is quarantined, alerted, notified, and never retrievable', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 300);
    const res = await upload(requester, `/api/requisitions/${draft.id}/attachments`, { type: 'quote' }, {
      filename: 'malware.pdf',
      contentType: 'application/pdf',
      data: EICAR_IN_PDF,
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; attachmentId: string };
    expect(body.error).toBe('file_failed_virus_scan');

    const row = await db.query<{ scan_status: string }>('SELECT scan_status FROM attachments WHERE id = $1', [
      body.attachmentId,
    ]);
    expect(row.rows[0]!.scan_status).toBe('infected');

    const download = await get(requester, `/api/attachments/${body.attachmentId}/download`);
    expect(download.statusCode).toBe(409);

    const alert = await db.query(`SELECT 1 FROM alerts WHERE rule = 'malware_upload_quarantined'`);
    expect(alert.rows.length).toBeGreaterThan(0);
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'attachment.quarantined' AND entity_id = $1`,
      [body.attachmentId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    const notified = await db.query(
      `SELECT 1 FROM notification_outbox WHERE recipient_user_id = $1 AND template = 'attachment_quarantined'`,
      [fx.requester],
    );
    expect(notified.rows.length).toBeGreaterThan(0);
  });

  it('A.8.7: file types are allowlisted by magic bytes, and clean files download with attachment disposition', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 300);
    const bad = await upload(requester, `/api/requisitions/${draft.id}/attachments`, { type: 'quote' }, {
      filename: 'notes.txt',
      contentType: 'text/plain',
      data: Buffer.from('hello world'),
    });
    expect(bad.statusCode).toBe(415);

    const good = await upload(requester, `/api/requisitions/${draft.id}/attachments`, { type: 'quote' }, {
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      data: PDF_BYTES,
    });
    expect(good.statusCode).toBe(201);
    const { attachmentId } = good.json() as { attachmentId: string };
    const download = await get(requester, `/api/attachments/${attachmentId}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.rawPayload.equals(PDF_BYTES)).toBe(true);
  });

  // ── Invoices (§5.4) and Accounting (§5.5) ─────────────────────────────────
  it('§5.4/§5.5: an in-tolerance invoice posts, closes the requisition, and moves committed → actual live', async () => {
    const requester = await loginAs(fx.requester);
    const res = await upload(
      requester,
      `/api/requisitions/${reqA}/invoice`,
      { invoiceNo: `INV-${RUN}-1`, invoiceDate: '2026-08-01', amount: '4100', currency: 'TTD' },
      { filename: 'invoice.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(res.statusCode).toBe(201);
    const created = res.json() as { invoiceId: string; needsReapproval: boolean };
    expect(created.needsReapproval).toBe(false); // 2.5% < 5% tolerance

    const accountant = await loginAs(fx.accountant);
    const queue = await get(accountant, '/api/accounting/queue');
    const queued = (queue.json() as { queue: { invoice_id: string }[] }).queue;
    expect(queued.some((q) => q.invoice_id === created.invoiceId)).toBe(true);

    const posted = await post(accountant, `/api/accounting/invoices/${created.invoiceId}/post`, {
      cdkReference: `CDK-${RUN}-1`,
    });
    expect(posted.statusCode).toBe(200);
    expect((posted.json() as { requisitionClosed: boolean }).requisitionClosed).toBe(true);

    const position = await get(requester, `/api/budget-position?costCentreId=${fx.ccLea}&period=${period}`);
    const totals = (position.json() as { totals: { committed: string; actual: string; available: string } }).totals;
    // reqB (6000) still committed; reqA actualised at 4100
    expect(totals.committed).toBe('6000.00');
    expect(totals.actual).toBe('4100.00');
    expect(totals.available).toBe('-100.00');
  });

  it('§5.4: variance beyond tolerance requires re-approval by the final approver before posting', async () => {
    const requester = await loginAs(fx.requester);
    const res = await upload(
      requester,
      `/api/requisitions/${reqB}/invoice`,
      { invoiceNo: `INV-${RUN}-2`, invoiceDate: '2026-08-02', amount: '6900', currency: 'TTD' },
      { filename: 'invoice2.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(res.statusCode).toBe(201);
    const created = res.json() as { invoiceId: string; needsReapproval: boolean };
    expect(created.needsReapproval).toBe(true); // 15% > 5%

    const accountant = await loginAs(fx.accountant);
    const early = await post(accountant, `/api/accounting/invoices/${created.invoiceId}/post`, {
      cdkReference: `CDK-${RUN}-2`,
    });
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: string }).error).toBe('pending_variance_reapproval');

    // The re-approval step belongs to the FINAL approver of the chain — the
    // delegate who decided step 2
    const step = await db.query<{ id: string; assigned_user_id: string }>(
      `SELECT id, assigned_user_id FROM approval_steps
       WHERE requisition_id = $1 AND purpose = 'variance_reapproval' AND decision = 'pending'`,
      [reqB],
    );
    expect(step.rows).toHaveLength(1);
    expect(step.rows[0]!.assigned_user_id).toBe(delegateUser);

    const finalApprover = await loginAs(delegateUser);
    const decide = await post(finalApprover, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    expect(decide.statusCode).toBe(200);

    const posted = await post(accountant, `/api/accounting/invoices/${created.invoiceId}/post`, {
      cdkReference: `CDK-${RUN}-2`,
    });
    expect(posted.statusCode).toBe(200);
    const after = await db.query<{ status: string }>('SELECT status FROM requisitions WHERE id = $1', [reqB]);
    expect(after.rows[0]!.status).toBe('closed');
  });

  it('§5.4: an invoice against a non-approved requisition is rejected', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 200);
    const res = await upload(
      requester,
      `/api/requisitions/${draft.id}/invoice`,
      { invoiceNo: `INV-${RUN}-3`, invoiceDate: '2026-08-03', amount: '200', currency: 'TTD' },
      { filename: 'invoice3.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('requisition_not_approved');
  });

  // ── Budget governance (§5.9) ───────────────────────────────────────────────
  it('§5.9: a budget change is proposed, submitted, and activated by the budget approver — never the proposer', async () => {
    const owner = await loginAs(fx.budgetOwner);
    const created = await post(owner, '/api/budgets/versions', {
      costCentreId: fx.ccLea,
      period,
      reason: 'Q3 uplift for fleet maintenance',
      lines: [{ categoryId: fx.category, amount: 12000 }],
    });
    expect(created.statusCode).toBe(201);
    const { versionId } = created.json() as { versionId: string };

    // Not yet active — the live figure is unchanged
    const before = await get(owner, `/api/budget-position?costCentreId=${fx.ccLea}&period=${period}`);
    expect((before.json() as { totals: { budget: string } }).totals.budget).toBe('10000.00');

    // The proposer cannot approve (they do not even hold budget_approver;
    // the role combination itself is an SoD conflict — tested below)
    const selfApprove = await post(owner, `/api/budgets/versions/${versionId}/approve`);
    expect(selfApprove.statusCode).toBe(403);

    expect((await post(owner, `/api/budgets/versions/${versionId}/submit`)).statusCode).toBe(200);

    const fd = await loginAs(fx.fd);
    const events: unknown[] = [];
    const unsubscribe = eventBus.onBudgetChanged((e) => events.push(e));
    const approved = await post(fd, `/api/budgets/versions/${versionId}/approve`);
    unsubscribe();
    expect(approved.statusCode).toBe(200);
    expect(events).toContainEqual({ costCentreId: fx.ccLea, cause: 'budget_version_activated' });

    // Old version superseded, new one live — and the tracker reflects it
    const oldVersion = await db.query<{ status: string }>('SELECT status FROM budget_versions WHERE id = $1', [
      fx.budgetVersionId,
    ]);
    expect(oldVersion.rows[0]!.status).toBe('superseded');
    const after = await get(owner, `/api/budget-position?costCentreId=${fx.ccLea}&period=${period}`);
    const totals = (after.json() as { totals: { budget: string; available: string } }).totals;
    expect(totals.budget).toBe('12000.00');
    // committed 0 (all closed), actual 4100 + 6900 = 11000
    expect(totals.available).toBe('1000.00');

    // Audit carries before/after lines (§6.2)
    const audit = await db.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_log WHERE action = 'budget.version_approved' AND entity_id = $1`,
      [versionId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.before).toBeTruthy();
    expect(audit.rows[0]!.after).toBeTruthy();
  });

  it('A.5.3: budget_owner and budget_approver can never be held together (SoD grant conflict)', async () => {
    const sysadmin = await loginAs(fx.sysadmin);
    const res = await post(sysadmin, `/api/admin/users/${fx.budgetOwner}/roles`, {
      role: 'budget_approver',
      reason: 'SoD probe — must be refused',
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('segregation_of_duties_conflict');
  });

  it('§5.9/§6.2: a budget Excel upload becomes a validated draft version', async () => {
    const owner = await loginAs(fx.budgetOwner);
    const categoryCode = (
      await db.query<{ code: string }>('SELECT code FROM categories WHERE id = $1', [fx.category])
    ).rows[0]!.code;
    const workbook = await xlsxBuffer(['Category', 'Amount', 'Currency'], [[categoryCode, 15000, 'TTD']]);
    const res = await upload(
      owner,
      '/api/budgets/upload',
      { costCentreId: fx.ccLea, period, reason: 'Uploaded revision' },
      { filename: 'budget.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: workbook },
    );
    expect(res.statusCode).toBe(201);
    const { versionId } = res.json() as { versionId: string };
    const lines = await db.query<{ amount: string }>('SELECT amount FROM budgets WHERE version_id = $1', [versionId]);
    expect(lines.rows).toHaveLength(1);
    expect(Number(lines.rows[0]!.amount)).toBe(15000);
    // Draft only — the active budget is untouched until approved (§5.9)
    const position = await get(owner, `/api/budget-position?costCentreId=${fx.ccLea}&period=${period}`);
    expect((position.json() as { totals: { budget: string } }).totals.budget).toBe('12000.00');
  });

  // ── Exports, logbook, dashboard (Phase 3) ─────────────────────────────────
  it('A.8.12/A.5.13: logbook and accounting exports are labelled and audited with row counts', async () => {
    const requester = await loginAs(fx.requester);
    const logbook = await get(requester, '/api/logbook/export.xlsx');
    expect(logbook.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(logbook.rawPayload as unknown as ArrayBuffer);
    const firstCell = wb.worksheets[0]!.getRow(1).getCell(1).value;
    expect(String(firstCell)).toContain('Classification:');

    const accountant = await loginAs(fx.accountant);
    const batch = await get(accountant, '/api/accounting/batch-export.xlsx');
    expect(batch.statusCode).toBe(200);

    const audits = await db.query(
      `SELECT entity_id FROM audit_log
       WHERE action = 'data.export' AND entity_id IN ('logbook', 'accounting-batch')
         AND (after ->> 'rowCount') IS NOT NULL`,
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('A.5.28: the auditor exports the audit trail; the sysadmin cannot', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const auditor = await loginAs(fx.auditor);
    const ok = await get(auditor, `/api/admin/audit-export.xlsx?from=${from}&to=${to}`);
    expect(ok.statusCode).toBe(200);
    const sysadmin = await loginAs(fx.sysadmin);
    const denied = await get(sysadmin, `/api/admin/audit-export.xlsx?from=${from}&to=${to}`);
    expect(denied.statusCode).toBe(403);
  });

  it('§5.7: the dashboard serves its four tiles', async () => {
    const approver = await loginAs(fx.approver);
    const res = await get(approver, '/api/dashboard');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      pendingMyApproval: number;
      myOpenRequisitions: number;
      deniedThisMonth: number;
      budgetPositions: { costCentreId: string; totals: { available: string } }[];
    };
    expect(typeof body.pendingMyApproval).toBe('number');
    expect(typeof body.deniedThisMonth).toBe('number');
    expect(body.budgetPositions.some((b) => b.costCentreId === fx.ccLea)).toBe(true);
  });

  it('§0.3: SLA thresholds and tolerances are data — the sysadmin edits them, audited', async () => {
    const sysadmin = await loginAs(fx.sysadmin);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings/sla_reminder_days',
      headers: { cookie: sysadmin.cookie, 'x-csrf-token': sysadmin.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 4 }),
    });
    expect(res.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings/invoice_variance_tolerance',
      headers: { cookie: sysadmin.cookie, 'x-csrf-token': sysadmin.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'lots' }),
    });
    expect(bad.statusCode).toBe(400);
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'setting.changed' AND entity_id = 'sla_reminder_days'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    // restore
    await app.inject({
      method: 'PUT',
      url: '/api/admin/settings/sla_reminder_days',
      headers: { cookie: sysadmin.cookie, 'x-csrf-token': sysadmin.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 3 }),
    });
  });

  // ── Reporting schema (A.8.11) ─────────────────────────────────────────────
  it('A.8.11: reporting views expose ids and job titles — no personal contact details anywhere', async () => {
    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'reporting'
         AND (column_name ILIKE '%email%' OR column_name ILIKE '%phone%' OR column_name ILIKE '%display_name%')`,
    );
    expect(columns.rows).toEqual([]);

    const position = await db.query<{ budget: string; committed: string; actual: string; available: string }>(
      `SELECT budget::text, committed::text, actual::text, available::text
       FROM reporting.v_budget_position WHERE cost_centre_id = $1 AND period = $2 AND category_id = $3`,
      [fx.ccLea, period, fx.category],
    );
    expect(position.rows).toHaveLength(1);
    expect(Number(position.rows[0]!.budget)).toBe(12000);
    expect(Number(position.rows[0]!.actual)).toBe(11000);
    expect(Number(position.rows[0]!.available)).toBe(1000);

    const facts = await db.query(
      `SELECT requester_user_id, requester_job_title FROM reporting.v_requisition_facts WHERE reference = $1`,
      [reqAref],
    );
    expect(facts.rows).toHaveLength(1);
  });

  it('A.8.11: massy_readonly reads reporting views only — base tables refuse it', async () => {
    await db.query('GRANT massy_readonly TO current_user');
    const client = await db.connect();
    try {
      await client.query('SET ROLE massy_readonly');
      const views = await client.query('SELECT count(*)::int AS n FROM reporting.v_requisition_facts');
      expect(views.rows[0].n).toBeGreaterThan(0);
      await expect(client.query('SELECT count(*) FROM public.requisitions')).rejects.toThrow(/permission denied/);
      await expect(client.query('SELECT count(*) FROM public.audit_log')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

  // ── DOA import + activation LAST (it replaces the active version) ─────────
  it('§6.1: DOA upload validates bands (overlap, gap, unknown names) and refuses a broken matrix', async () => {
    const doaAdmin = await loginAs(fx.doaAdmin);
    const categoryCode = (
      await db.query<{ code: string }>('SELECT code FROM categories WHERE id = $1', [fx.category])
    ).rows[0]!.code;
    const ccCode = (
      await db.query<{ code: string }>('SELECT code FROM cost_centres WHERE id = $1', [fx.ccLea])
    ).rows[0]!.code;
    const broken = await xlsxBuffer(
      ['Category', 'Cost Centre', 'Min Amount', 'Max Amount', 'Currency', 'Approver 1', 'Approver 2', 'Approver 3', 'Quotes Required', 'Notes'],
      [
        [categoryCode, ccCode, 0, 5000, 'TTD', fx.titleA, '', '', 0, ''],
        [categoryCode, ccCode, 4000, 9000, 'TTD', 'No Such Job Title XYZ', '', '', 0, ''], // overlap + unknown
        [categoryCode, ccCode, 12000, 20000, 'USD', fx.titleA, '', '', 0, ''], // gap + wrong currency + bounded last band
      ],
    );
    const res = await upload(doaAdmin, '/api/doa/upload', {}, {
      filename: 'doa.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: broken,
    });
    expect(res.statusCode).toBe(422);
    const { issues } = res.json() as { issues: string[] };
    expect(issues.join('\n')).toMatch(/overlap/);
    expect(issues.join('\n')).toMatch(/gap/);
    expect(issues.join('\n')).toMatch(/No Such Job Title XYZ/);
    expect(issues.join('\n')).toMatch(/USD/);
  });

  it('§6.1: a valid DOA upload creates a draft with a diff; the uploader cannot activate; the doa_approver can', async () => {
    const doaAdmin = await loginAs(fx.doaAdmin);
    // Cover every active category (validation demands full coverage)
    const categories = await db.query<{ code: string }>('SELECT code FROM categories WHERE active ORDER BY code');
    const rows = categories.rows.map((c) => [c.code, '', 0, '', 'TTD', fx.titleA, '', '', 0, 'v-next'] as (string | number)[]);
    const workbook = await xlsxBuffer(
      ['Category', 'Cost Centre', 'Min Amount', 'Max Amount', 'Currency', 'Approver 1', 'Approver 2', 'Approver 3', 'Quotes Required', 'Notes'],
      rows,
    );
    const uploaded = await upload(doaAdmin, '/api/doa/upload', {}, {
      filename: 'doa-next.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: workbook,
    });
    expect(uploaded.statusCode).toBe(201);
    const body = uploaded.json() as { versionId: string; diff: { entries: unknown[] } };
    expect(body.diff.entries.length).toBeGreaterThan(0);

    // Two-person rule, three layers deep: (1) activation needs doa_approver,
    // which the uploader's doa_admin role can never coexist with (SoD trigger),
    // so the role guard already refuses; (2) the route refuses uploader ==
    // activator; (3) the 0002 CHECK refuses approved_by == uploaded_by.
    const refused = await post(doaAdmin, `/api/doa/versions/${body.versionId}/activate`);
    expect(refused.statusCode).toBe(403);
    const sysadmin = await loginAs(fx.sysadmin);
    const conflictingGrant = await post(sysadmin, `/api/admin/users/${fx.doaAdmin}/roles`, {
      role: 'doa_approver',
      reason: 'SoD probe — must be refused',
    });
    expect(conflictingGrant.statusCode).toBe(409);

    const fd = await loginAs(fx.fd);
    const activated = await post(fd, `/api/doa/versions/${body.versionId}/activate`);
    expect(activated.statusCode).toBe(200);

    const oldVersion = await db.query<{ status: string }>('SELECT status FROM doa_matrix_versions WHERE id = $1', [
      fx.doaVersionId,
    ]);
    expect(oldVersion.rows[0]!.status).toBe('superseded');
    const audit = await db.query(
      `SELECT 1 FROM audit_log WHERE action = 'doa.version_activated' AND entity_id = $1`,
      [body.versionId],
    );
    expect(audit.rows.length).toBe(1);
  });

  it('§5.4: cumulative invoice totals cannot slip past the tolerance one invoice at a time', async () => {
    // Two invoices, each individually within tolerance of the approved amount,
    // must not be able to post 2x the approved spend (adversarial-review
    // finding): variance is measured on the RUNNING TOTAL.
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 1000);
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    const step = await db.query<{ id: string }>(
      `SELECT id FROM approval_steps WHERE requisition_id = $1 AND step_no = 1`,
      [draft.id],
    );
    const approver = await loginAs(fx.approver);
    await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/approve`);

    const first = await upload(
      requester,
      `/api/requisitions/${draft.id}/invoice`,
      { invoiceNo: `INV-${RUN}-C1`, invoiceDate: '2026-08-04', amount: '950', currency: 'TTD' },
      { filename: 'c1.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(first.statusCode).toBe(201);
    expect((first.json() as { needsReapproval: boolean }).needsReapproval).toBe(false);

    // 950 + 950 = 1900 against a 1000 approval: individually -5%, cumulatively +90%
    const second = await upload(
      requester,
      `/api/requisitions/${draft.id}/invoice`,
      { invoiceNo: `INV-${RUN}-C2`, invoiceDate: '2026-08-04', amount: '950', currency: 'TTD' },
      { filename: 'c2.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { invoiceId: string; needsReapproval: boolean };
    expect(secondBody.needsReapproval).toBe(true);

    // ...and Accounting cannot post it until the approver decides
    const accountant = await loginAs(fx.accountant);
    const early = await post(accountant, `/api/accounting/invoices/${secondBody.invoiceId}/post`, {
      cdkReference: `CDK-${RUN}-C2`,
    });
    expect(early.statusCode).toBe(409);
    expect((early.json() as { error: string }).error).toBe('pending_variance_reapproval');

    // The database refuses the same thing even if a route ever skipped the check
    await expect(
      db.query(`UPDATE invoices SET status = 'submitted' WHERE id = $1`, [secondBody.invoiceId]),
    ).rejects.toThrow(/variance re-approval/);
  });

  it('§5.4: an invoice cannot be posted after its requisition is cancelled', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 700);
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    const step = await db.query<{ id: string }>(
      `SELECT id FROM approval_steps WHERE requisition_id = $1 AND step_no = 1`,
      [draft.id],
    );
    const approver = await loginAs(fx.approver);
    await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    const invoice = await upload(
      requester,
      `/api/requisitions/${draft.id}/invoice`,
      { invoiceNo: `INV-${RUN}-X`, invoiceDate: '2026-08-04', amount: '700', currency: 'TTD' },
      { filename: 'x.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    expect(invoice.statusCode).toBe(201);
    const { invoiceId } = invoice.json() as { invoiceId: string };

    // Cancelling is refused while an invoice is still live...
    const blocked = await post(requester, `/api/requisitions/${draft.id}/cancel`, { reason: 'changed my mind' });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toBe('open_invoices_exist');

    // ...and once the invoice is out of the way and the requisition cancelled,
    // that invoice can never be posted (spend needs a live approval).
    const accountant = await loginAs(fx.accountant);
    expect(
      (await post(accountant, `/api/accounting/invoices/${invoiceId}/reject`, { reason: 'wrong document' })).statusCode,
    ).toBe(200);
    expect((await post(requester, `/api/requisitions/${draft.id}/cancel`, { reason: 'supplier fell through' })).statusCode).toBe(
      200,
    );
    // Direct DB attempt to resurrect and post it is refused by the trigger
    await expect(
      db.query(`UPDATE invoices SET status = 'posted', posted_by = $2, posted_at = now(), cdk_reference = 'X' WHERE id = $1`, [
        invoiceId,
        fx.accountant,
      ]),
    ).rejects.toThrow(/cancelled requisition|variance re-approval/);
  });

  it('§5.4: an invoice Accounting rejected is not resurrected by a later variance approval', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 800);
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    const step = await db.query<{ id: string }>(
      `SELECT id FROM approval_steps WHERE requisition_id = $1 AND step_no = 1`,
      [draft.id],
    );
    const approver = await loginAs(fx.approver);
    await post(approver, `/api/approvals/steps/${step.rows[0]!.id}/approve`);
    const invoice = await upload(
      requester,
      `/api/requisitions/${draft.id}/invoice`,
      { invoiceNo: `INV-${RUN}-R`, invoiceDate: '2026-08-04', amount: '1200', currency: 'TTD' },
      { filename: 'r.pdf', contentType: 'application/pdf', data: PDF_BYTES },
    );
    const { invoiceId, needsReapproval } = invoice.json() as { invoiceId: string; needsReapproval: boolean };
    expect(needsReapproval).toBe(true);

    // Accounting rejects it (their SoD-separated call)
    const accountant = await loginAs(fx.accountant);
    expect((await post(accountant, `/api/accounting/invoices/${invoiceId}/reject`, { reason: 'wrong supplier' })).statusCode).toBe(
      200,
    );

    // The approver then approves the still-pending variance step
    const varianceStep = await db.query<{ id: string }>(
      `SELECT id FROM approval_steps WHERE requisition_id = $1 AND purpose = 'variance_reapproval'`,
      [draft.id],
    );
    expect((await post(approver, `/api/approvals/steps/${varianceStep.rows[0]!.id}/approve`)).statusCode).toBe(200);

    // The rejection stands
    const after = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(after.rows[0]!.status).toBe('rejected');
  });

  it('A.5.3: the database refuses an approval with undecided steps, even by direct SQL', async () => {
    const requester = await loginAs(fx.requester);
    const draft = await createDraft(requester, 6000);
    await upload(requester, `/api/requisitions/${draft.id}/attachments`, { type: 'quote' }, {
      filename: 'q.pdf',
      contentType: 'application/pdf',
      data: PDF_BYTES,
    });
    await post(requester, `/api/requisitions/${draft.id}/submit`);
    // Two pending steps; nobody has decided anything
    await expect(
      db.query(
        `UPDATE requisitions SET status = 'approved', approved_at = now(), approval_reference = $2 WHERE id = $1`,
        [draft.id, `MM-FORGED-${RUN}-APR`],
      ),
    ).rejects.toThrow(/undecided/);
    const still = await db.query<{ status: string }>('SELECT status FROM requisitions WHERE id = $1', [draft.id]);
    expect(still.rows[0]!.status).toBe('submitted');
  });

  it('plan §0.3: configuration is readable without a user context (service and job reads)', async () => {
    // Regression: routes and the SLA job read app_settings on the bare pool.
    // Under the mandated non-owner DB role this returned zero rows and broke
    // every write flow in production while passing in tests
    // (adversarial-review finding).
    await db.query('GRANT massy_app TO current_user');
    const client = await db.connect();
    try {
      await client.query('SET ROLE massy_app');
      await client.query(`SELECT set_config('app.user_id', '', false)`);
      const settings = await client.query('SELECT count(*)::int AS n FROM app_settings');
      expect(settings.rows[0].n).toBeGreaterThan(0);
      const rules = await client.query('SELECT count(*)::int AS n FROM doa_rules');
      expect(rules.rows[0].n).toBeGreaterThan(0);
      // ...while financial records stay invisible without a user context
      const reqs = await client.query('SELECT count(*)::int AS n FROM requisitions');
      expect(reqs.rows[0].n).toBe(0);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

});
