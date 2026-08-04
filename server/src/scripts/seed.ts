// Synthetic development/test data ONLY (A.8.33). Every identity is fake, every
// email is @example.test. There is no code path anywhere in this repository
// that copies production data into a non-production environment — and this
// script refuses to run in production.
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('seed: refusing to run in production (A.8.33 — test data is synthetic only)');
  process.exit(1);
}

const db = createPool(config);

const existing = await db.query("SELECT 1 FROM cost_centres WHERE code = 'LEA'");
if (existing.rows.length > 0) {
  console.log('seed: already seeded (cost centre LEA exists) — nothing to do');
  await db.end();
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query('BEGIN');

  // ── Cost centres ─────────────────────────────────────────────────────────
  const cc = async (code: string, name: string, department: string) =>
    (
      await client.query<{ id: string }>(
        'INSERT INTO cost_centres (code, name, department) VALUES ($1, $2, $3) RETURNING id',
        [code, name, department],
      )
    ).rows[0]!.id;
  const ccLea = await cc('LEA', 'Leasing Operations', 'Leasing');
  const ccFleet = await cc('LEA-FLT', 'Leasing Fleet Maintenance', 'Leasing');
  const ccAdm = await cc('ADM', 'Administration', 'Administration');

  // ── Users (synthetic) ────────────────────────────────────────────────────
  const user = async (slug: string, name: string, title: string) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`dev-${slug}`, `${slug}@example.test`, name, title],
      )
    ).rows[0]!.id;

  const andre = await user('andre.sysadmin', 'Andre Williams', 'IT Systems Administrator');
  const riya = await user('riya.requester', 'Riya Maharaj', 'Leasing Coordinator');
  const kerry = await user('kerry.requester', 'Kerry Ali', 'Administrative Assistant');
  const devon = await user('devon.manager', 'Devon Charles', 'Department Manager');
  const anjali = await user('anjali.finance', 'Anjali Singh', 'Finance Manager');
  const sharon = await user('sharon.md', 'Sharon Lee', 'Managing Director');
  const marcus = await user('marcus.accounting', 'Marcus Joseph', 'Accounts Clerk');
  const priya = await user('priya.budget', 'Priya Gopaul', 'Financial Analyst');
  const nigel = await user('nigel.doa', 'Nigel Thomas', 'Compliance Officer');
  const camille = await user('camille.auditor', 'Camille Baptiste', 'Internal Auditor');

  // ── Role grants (A.5.18: who granted, when, why) ─────────────────────────
  const grant = async (userId: string, role: string, costCentreId: string | null) =>
    client.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, $2, $3, $4, 'Seed: synthetic development data (A.8.33)')`,
      [userId, role, costCentreId, andre],
    );
  await grant(andre, 'sysadmin', null);
  await grant(riya, 'requester', ccLea);
  await grant(riya, 'requester', ccFleet);
  await grant(kerry, 'requester', ccAdm);
  await grant(devon, 'approver', ccLea);
  await grant(devon, 'approver', ccFleet);
  await grant(anjali, 'approver', ccLea);
  await grant(anjali, 'approver', ccFleet);
  await grant(anjali, 'approver', ccAdm);
  await grant(sharon, 'approver', ccLea);
  await grant(marcus, 'accounting', null);
  await grant(priya, 'budget_owner', ccLea);
  await grant(nigel, 'doa_admin', null);
  await grant(camille, 'auditor', null);

  // ── Categories ───────────────────────────────────────────────────────────
  const cat = async (code: string, name: string, gl: string) =>
    (
      await client.query<{ id: string }>(
        'INSERT INTO categories (code, name, gl_account_code) VALUES ($1, $2, $3) RETURNING id',
        [code, name, gl],
      )
    ).rows[0]!.id;
  const catParts = await cat('VEH-PARTS', 'Vehicle parts & consumables', '5100');
  const catFuel = await cat('FUEL', 'Fuel & lubricants', '5110');
  const catOffice = await cat('OFFICE', 'Office supplies', '6200');
  const catIt = await cat('IT-EQUIP', 'IT equipment', '6400');

  // ── Suppliers (no bank details by design — A.5.34) ───────────────────────
  await client.query(
    `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id) VALUES
     ('Caribbean Auto Supplies Ltd (SYNTHETIC)', 'CDK-0001', 'TT-000-0001'),
     ('Port of Spain Office Depot (SYNTHETIC)', 'CDK-0002', 'TT-000-0002'),
     ('TT Fleet Services Co (SYNTHETIC)', 'CDK-0003', 'TT-000-0003')`,
  );

  // ── DOA matrix v1 (draft content — real DOA is TODO(client), §9 Q1) ──────
  // Uploaded by the DOA admin, activated by a second person (two-person rule §6.1).
  const doaVersion = (
    await client.query<{ id: string }>(
      `INSERT INTO doa_matrix_versions (version_no, status, effective_from, uploaded_by, approved_by, approved_at)
       VALUES (1, 'active', now(), $1, $2, now()) RETURNING id`,
      [nigel, anjali],
    )
  ).rows[0]!.id;

  const seqDm = JSON.stringify([{ type: 'job_title', value: 'Department Manager' }]);
  const seqDmFm = JSON.stringify([
    { type: 'job_title', value: 'Department Manager' },
    { type: 'job_title', value: 'Finance Manager' },
  ]);
  const seqDmFmMd = JSON.stringify([
    { type: 'job_title', value: 'Department Manager' },
    { type: 'job_title', value: 'Finance Manager' },
    { type: 'job_title', value: 'Managing Director' },
  ]);
  for (const categoryId of [catParts, catFuel, catOffice, catIt]) {
    await client.query(
      `INSERT INTO doa_rules (version_id, category_id, cost_centre_id, min_amount, max_amount, currency, approval_sequence, requires_quotes)
       VALUES
       ($1, $2, NULL, 0,     5000,   'TTD', $3, 0),
       ($1, $2, NULL, 5000,  25000,  'TTD', $4, 1),
       ($1, $2, NULL, 25000, 100000, 'TTD', $4, 3),
       ($1, $2, NULL, 100000, NULL,  'TTD', $5, 3)`,
      [doaVersion, categoryId, seqDm, seqDmFm, seqDmFmMd],
    );
  }

  // ── Budgets FY2026-Q3, LEA × category (structure is TODO(client), §9 Q3) ─
  for (const [categoryId, amount] of [
    [catParts, 250000],
    [catFuel, 180000],
    [catOffice, 20000],
    [catIt, 60000],
  ] as const) {
    await client.query(
      `INSERT INTO budgets (cost_centre_id, category_id, period, amount, currency, version, approved_by, approved_at)
       VALUES ($1, $2, 'FY2026-Q3', $3, 'TTD', 1, $4, now())`,
      [ccLea, categoryId, amount, anjali],
    );
  }

  // ── Sample requisitions for the RBAC scope tests ─────────────────────────
  const ref1 = (await client.query<{ r: string }>("SELECT next_reference('LEA', 2026) AS r")).rows[0]!.r;
  const snapshot = (
    await client.query<{ s: unknown }>(
      `SELECT to_jsonb(dr) AS s FROM doa_rules dr
       WHERE dr.version_id = $1 AND dr.category_id = $2 AND dr.min_amount <= 12000 AND (dr.max_amount IS NULL OR dr.max_amount > 12000)
       LIMIT 1`,
      [doaVersion, catParts],
    )
  ).rows[0]!.s;
  const reqLea = (
    await client.query<{ id: string }>(
      `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification,
                                 amount, currency, status, doa_version_id, doa_rule_snapshot, submitted_at)
       VALUES ($1, $2, $3, $4, 'Brake pads and filters for lease fleet (SYNTHETIC)',
               'Scheduled maintenance batch for Q3 (SYNTHETIC)', 12000, 'TTD', 'submitted', $5, $6, now())
       RETURNING id`,
      [ref1, riya, ccLea, catParts, doaVersion, JSON.stringify(snapshot)],
    )
  ).rows[0]!.id;
  await client.query(
    `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id) VALUES
     ($1, 1, 'Department Manager', $2),
     ($1, 2, 'Finance Manager', $3)`,
    [reqLea, devon, anjali],
  );

  const ref2 = (await client.query<{ r: string }>("SELECT next_reference('LEA', 2026) AS r")).rows[0]!.r;
  await client.query(
    `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'Fuel cards top-up (SYNTHETIC, draft)', 'Monthly fleet fuel (SYNTHETIC)', 8000, 'TTD', 'draft')`,
    [ref2, riya, ccLea, catFuel],
  );

  // A requisition in a DIFFERENT cost centre — the A.5.15 acceptance test
  // fetches this as the Leasing requester and must get 404.
  const ref3 = (await client.query<{ r: string }>("SELECT next_reference('ADM', 2026) AS r")).rows[0]!.r;
  await client.query(
    `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'Stationery order (SYNTHETIC, draft)', 'Front office restock (SYNTHETIC)', 900, 'TTD', 'draft')`,
    [ref3, kerry, ccAdm, catOffice],
  );

  await client.query('COMMIT');
  console.log('seed: complete — 10 synthetic users, 3 cost centres, DOA v1 active, budgets FY2026-Q3, 3 requisitions');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await db.end();
}
