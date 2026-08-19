// Synthetic development/test data ONLY (A.8.33). Identities mirror the
// client's published Rentals Trinidad org structure (July 2026 deck) so demos
// read true, but every email is a non-routable @massymotors.test address,
// every amount is invented, and this script refuses to run in production.
// There is no code path anywhere in this repository that copies production
// data into a non-production environment.
//
// The DOA seeded here is the TIERED model from the client change list + the
// MML DOA Framework draft (IMP 26302): Tier 5 (supervisors / first-line
// managers) → Tier 4 (Snr Manager Rentals, Dept Head) → Tier 3 (executive),
// with the Accounts finance_review step appended automatically at submission
// (app_settings.accounting_final_approval). TT$ bands approximate the
// framework's US$ limits at ~6.8 TTD/USD — exact conversion is TODO(client).
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('seed: refusing to run in production (A.8.33 — test data is synthetic only)');
  process.exit(1);
}

const db = createPool(config);

const existing = await db.query("SELECT 1 FROM cost_centres WHERE code IN ('LEA', 'RENTALS')");
if (existing.rows.length > 0) {
  console.log('seed: already seeded (a seeded department exists) — nothing to do');
  await db.end();
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query('BEGIN');

  // ── Departments (client change list: cost centres ARE departments now —
  //    one row per department, one department budget) ────────────────────────
  const cc = async (code: string, name: string, department: string) =>
    (
      await client.query<{ id: string }>(
        'INSERT INTO cost_centres (code, name, department) VALUES ($1, $2, $3) RETURNING id',
        [code, name, department],
      )
    ).rows[0]!.id;
  const ccRentals = await cc('RENTALS', 'Rentals (Leasing & Short-Term)', 'Rentals');
  const ccAdm = await cc('ADM', 'Administration', 'Administration');

  // ── Users — the Rentals Trinidad management chain (org chart) plus
  //    synthetic governance actors ─────────────────────────────────────────
  const user = async (slug: string, name: string, title: string, homeCcId: string | null) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title, home_cost_centre_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [`dev-${slug}`, `${slug}@massymotors.test`, name, title, homeCcId],
      )
    ).rows[0]!.id;

  // Governance (synthetic people — not on the org chart)
  const andre = await user('andre.sysadmin', 'Andre Williams', 'IT Systems Administrator', null);
  const fiona = await user('fiona.fd', 'Fiona Ramlogan', 'Finance Director', null);
  const nigel = await user('nigel.doa', 'Nigel Thomas', 'Compliance Officer', null);
  const camille = await user('camille.auditor', 'Camille Baptiste', 'Internal Auditor', null);

  // Finance line (MML DOA sign-off page: AVP Finance / Credit Manager M. Awai)
  const awai = await user('m.awai', 'M. Awai', 'AVP Finance', null);

  // Tier 4 — Department Head (Snr Manager Rentals, GGP 2 Level 5)
  const jason = await user('jason.daniel', 'Jason Daniel', 'Senior Manager Rentals', ccRentals);

  // Tier 3 — executive owner of Rentals (VP Operations is TBD in the DOA)
  const vpOps = await user('vp.operations', 'V. Ramnarine', 'VP Operations (SYNTHETIC)', null);

  // Tier 5 — managers & supervisors (Leasing + Short-Term Rentals)
  const danielle = await user('danielle.contant', 'Danielle Contant', 'Business Development Manager Rentals', ccRentals);
  const fabian = await user('fabian.green', 'Fabian Green', 'Country Manager Short Term Rentals', ccRentals);
  const clinton = await user('clinton.pattoo', 'Clinton Pattoo', 'Rental Fleet Supervisor', ccRentals);
  const wendell = await user('wendell.frederick', 'Wendell Frederick', 'Supervisor Workshop', ccRentals);
  const usha = await user('usha.mahabir', 'Usha Mahabir', 'Supervisor San Fernando', ccRentals);
  const raaiysa = await user('raaiysa.gomez', 'Raa’iysa Gomez', 'Location Supervisor Piarco', ccRentals);
  const keshini = await user('keshini.balgobin', 'Keshini Balgobin', 'Location Supervisor San Fernando', ccRentals);

  // Tier 6 — requesters only
  const shada = await user('shada.charles', 'Shada Charles', 'Leasing Coordinator', ccRentals);
  const adrian = await user('adrian.clifton', 'Adrian Clifton', 'Fleet Officer', ccRentals);
  const kassidy = await user('kassidy.burke', 'Kassidy Burke', 'Assistant Fleet Officer', ccRentals);
  const crystal = await user('crystal.simon-bynoe', 'Crystal Simon-Bynoe', 'Corporate Rentals Sales Executive', ccRentals);
  const jordan = await user('jordan.clarke', 'Jordan Clarke', 'Rental Agent Morvant', ccRentals);
  const kerry = await user('kerry.requester', 'Kerry Ali', 'Administrative Assistant (SYNTHETIC)', ccAdm);

  // ── Role grants (A.5.18: who granted, when, why). Multi-role by design
  //    (client change list): managers are requesters AND approvers. ──────────
  const grant = async (userId: string, role: string, costCentreId: string | null, tier: number | null = null) =>
    client.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, tier, granted_by, granted_reason)
       VALUES ($1, $2, $3, $4, $5, 'Seed: synthetic development data (A.8.33)')`,
      [userId, role, costCentreId, tier, andre],
    );
  await grant(andre, 'sysadmin', null);
  await grant(camille, 'auditor', null);
  await grant(nigel, 'doa_admin', null);
  // §6.1 DOA activation: the Finance Director activates and therefore holds
  // no approver role (§3 — nobody approves against a version they activated).
  await grant(fiona, 'doa_approver', null);
  await grant(fiona, 'budget_approver', null);

  // Accounts — the final hurdle on every requisition (org-wide accounting),
  // plus the finance seat on budget approvals. Never a requester (SoD).
  await grant(awai, 'accounting', null);
  await grant(awai, 'budget_approver', null);

  // Tier 4: Department Head — approves Tier-5 escalations, the department
  // budget (with the ELT) and supplier requests; requests spend like anyone.
  await grant(jason, 'approver', ccRentals, 4);
  await grant(jason, 'requester', ccRentals);
  await grant(jason, 'budget_approver', null);
  await grant(jason, 'supplier_approver', null);

  // Tier 3: executive — approves above the Department Head's limit.
  await grant(vpOps, 'approver', ccRentals, 3);
  await grant(vpOps, 'approver', ccAdm, 3);

  // Tier 5: managers & supervisors — approve Tier-6 requests within band,
  // and are requesters themselves (multi-role).
  for (const t5 of [danielle, fabian, clinton, wendell, usha, raaiysa, keshini]) {
    await grant(t5, 'approver', ccRentals, 5);
    await grant(t5, 'requester', ccRentals);
  }
  // The BD Manager proposes the department budget (Tier 4 + ELT approve it).
  await grant(danielle, 'budget_owner', ccRentals);

  // Tier 6: requesters
  for (const t6 of [shada, adrian, kassidy, crystal, jordan]) {
    await grant(t6, 'requester', ccRentals);
  }
  await grant(kerry, 'requester', ccAdm);

  // ── Categories — Rentals cost lines (BAN Oct–May26 report) ───────────────
  const cat = async (code: string, name: string, gl: string) =>
    (
      await client.query<{ id: string }>(
        'INSERT INTO categories (code, name, gl_account_code) VALUES ($1, $2, $3) RETURNING id',
        [code, name, gl],
      )
    ).rows[0]!.id;
  const catSpares = await cat('SPARES', 'Spares', '5100');
  const catTyres = await cat('TYRES', 'New Tyres & Tubes', '5105');
  const catMaint = await cat('MAINT', 'Maintenance & Materials', '5120');
  const catLabour = await cat('CONTRACT-LAB', 'Contract Labour', '5130');
  const catIns = await cat('FLEET-INS', 'Fleet Insurance', '5140');
  const catFuel = await cat('GASOLENE', 'Gasolene & Lubricants', '5110');
  const catAc = await cat('AC-REPAIRS', 'A/C Repairs', '5150');
  const catOffice = await cat('OFFICE', 'Office Supplies', '6200');
  const allCategories = [catSpares, catTyres, catMaint, catLabour, catIns, catFuel, catAc, catOffice];

  // ── Suppliers (no bank details by design — A.5.34). Three already on the
  //    approved list; one pending to demo the Tier-5-requests → Tier-4-approves
  //    supplier workflow. ─────────────────────────────────────────────────────
  await client.query(
    `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id, status) VALUES
     ('Caribbean Auto Supplies Ltd (SYNTHETIC)', 'CDK-0001', 'TT-000-0001', 'active'),
     ('Port of Spain Office Depot (SYNTHETIC)', 'CDK-0002', 'TT-000-0002', 'active'),
     ('TT Fleet Services Co (SYNTHETIC)', 'CDK-0003', 'TT-000-0003', 'active')`,
  );
  await client.query(
    `INSERT INTO suppliers (name, cdk_vendor_ref, tax_id, status, requested_by, requested_at, requested_reason)
     VALUES ('Island Tyre Distributors (SYNTHETIC)', 'CDK-0004', 'TT-000-0004', 'pending_approval', $1, now(),
             'New tyre supplier with better fleet pricing (SYNTHETIC)')`,
    [clinton],
  );

  // ── DOA matrix v1 — the tiered Leasing model (client md + IMP 26302).
  //    TT$ bands ≈ US$5k / US$25k at ~6.8 (TODO(client): confirm conversion).
  //    Every submitted requisition additionally gets the Accounts
  //    finance_review step (accounting_final_approval, migration 0014). ──────
  const doaVersion = (
    await client.query<{ id: string }>(
      `INSERT INTO doa_matrix_versions (version_no, status, effective_from, uploaded_by, approved_by, approved_at)
       VALUES (1, 'active', now(), $1, $2, now()) RETURNING id`,
      [nigel, fiona],
    )
  ).rows[0]!.id;

  const seqT5 = JSON.stringify([{ type: 'tier', value: '5', label: 'Tier 5' }]);
  const seqT5T4 = JSON.stringify([
    { type: 'tier', value: '5', label: 'Tier 5' },
    { type: 'tier', value: '4', label: 'Tier 4' },
  ]);
  const seqT5T4T3 = JSON.stringify([
    { type: 'tier', value: '5', label: 'Tier 5' },
    { type: 'tier', value: '4', label: 'Tier 4' },
    { type: 'tier', value: '3', label: 'Tier 3' },
  ]);
  for (const categoryId of allCategories) {
    await client.query(
      `INSERT INTO doa_rules (version_id, category_id, cost_centre_id, min_amount, max_amount, currency, approval_sequence, requires_quotes)
       VALUES
       ($1, $2, NULL, 0,      34000,  'TTD', $3, 1),
       ($1, $2, NULL, 34000,  170000, 'TTD', $4, 2),
       ($1, $2, NULL, 170000, NULL,   'TTD', $5, 3)`,
      [doaVersion, categoryId, seqT5, seqT5T4, seqT5T4T3],
    );
  }

  // ── The Rentals department budget, FY2026-Q3 — through the §5.9 governance
  //    walk: the BD Manager (budget owner) proposes, the Department Head
  //    (budget approver, never the proposer) activates. ──────────────────────
  const budgetVersion = (
    await client.query<{ id: string }>(
      `INSERT INTO budget_versions (cost_centre_id, period, version_no, reason, proposed_by)
       VALUES ($1, 'FY2026-Q3', 1, 'Initial Rentals department budget FY2026-Q3 (SYNTHETIC seed)', $2)
       RETURNING id`,
      [ccRentals, danielle],
    )
  ).rows[0]!.id;
  for (const [categoryId, amount] of [
    [catSpares, 150000],
    [catTyres, 80000],
    [catMaint, 120000],
    [catLabour, 130000],
    [catIns, 150000],
    [catFuel, 90000],
    [catAc, 40000],
    [catOffice, 20000],
  ] as const) {
    await client.query(
      `INSERT INTO budgets (cost_centre_id, category_id, period, amount, currency, version, version_id)
       VALUES ($1, $2, 'FY2026-Q3', $3, 'TTD', 1, $4)`,
      [ccRentals, categoryId, amount, budgetVersion],
    );
  }
  await client.query(
    `UPDATE budget_versions SET status = 'pending_approval', submitted_at = now() WHERE id = $1`,
    [budgetVersion],
  );
  await client.query(
    `UPDATE budget_versions SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`,
    [budgetVersion, jason],
  );

  // ── Sample requisitions ──────────────────────────────────────────────────
  // Submitted: Tier-5 step (Danielle) then the Accounts finance_review step
  // (M. Awai) — the chain shape every real submission now produces.
  const ref1 = (await client.query<{ r: string }>("SELECT next_reference('RENTALS', 2026) AS r")).rows[0]!.r;
  // The snapshot must be byte-shape-identical to what buildSnapshot
  // (doa/engine.ts) writes on a real submission — camelCase keys, versionNo
  // included. to_jsonb(dr) emitted snake_case, so consumers of
  // rule.requiresQuotes saw NULL on the one seeded submission (review
  // finding: the fixture was a state the app cannot produce).
  const ruleRow = (
    await client.query<{
      id: string;
      category_id: string;
      cost_centre_id: string | null;
      min_amount: string;
      max_amount: string | null;
      currency: string;
      approval_sequence: unknown;
      requires_quotes: number;
      notes: string | null;
    }>(
      `SELECT id, category_id, cost_centre_id, min_amount, max_amount, currency,
              approval_sequence, requires_quotes, notes
       FROM doa_rules dr
       WHERE dr.version_id = $1 AND dr.category_id = $2 AND dr.min_amount <= 12000 AND (dr.max_amount IS NULL OR dr.max_amount > 12000)
       LIMIT 1`,
      [doaVersion, catSpares],
    )
  ).rows[0]!;
  const snapshot = {
    rule: {
      id: ruleRow.id,
      versionId: doaVersion,
      versionNo: 1,
      categoryId: ruleRow.category_id,
      costCentreId: ruleRow.cost_centre_id,
      minAmount: ruleRow.min_amount,
      maxAmount: ruleRow.max_amount,
      currency: ruleRow.currency,
      approvalSequence: ruleRow.approval_sequence,
      requiresQuotes: ruleRow.requires_quotes,
      notes: ruleRow.notes,
    },
    resolvedSteps: [{ stepNo: 1, descriptor: { type: 'tier', value: '5', label: 'Tier 5' }, userId: danielle }],
    flags: [],
    resolvedAt: new Date().toISOString(),
  };
  const reqRentals = (
    await client.query<{ id: string }>(
      `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification,
                                 amount, currency, status, doa_version_id, doa_rule_snapshot, submitted_at)
       VALUES ($1, $2, $3, $4, 'Brake pads and filters for lease fleet (SYNTHETIC)',
               'Scheduled maintenance batch for Q3 (SYNTHETIC)', 12000, 'TTD', 'submitted', $5, $6, now())
       RETURNING id`,
      [ref1, shada, ccRentals, catSpares, doaVersion, JSON.stringify(snapshot)],
    )
  ).rows[0]!.id;
  // The 0–34k band requires one clean quote (seeded above); a submitted
  // requisition without one is a state the submit gate can never produce, so
  // the fixture carries a synthetic quote row. (The storage key points at no
  // real object — downloading it 404s, acceptable for a synthetic fixture.)
  await client.query(
    `INSERT INTO attachments (requisition_id, type, filename, content_type, size_bytes, sha256, storage_key,
                              scan_status, uploaded_by)
     VALUES ($1, 'quote', 'quote-caribbean-auto-supplies-SYNTHETIC.pdf', 'application/pdf', 1024, $2, $3, 'clean', $4)`,
    [reqRentals, 'f'.repeat(64), `seed/rentals/quote-1-synthetic-${Date.now()}`, shada],
  );
  await client.query(
    `INSERT INTO approval_steps (requisition_id, step_no, assigned_role, assigned_user_id, purpose) VALUES
     ($1, 1, 'Tier 5', $2, 'doa'),
     ($1, 2, 'Accounts — final review', $3, 'finance_review')`,
    [reqRentals, danielle, awai],
  );

  const ref2 = (await client.query<{ r: string }>("SELECT next_reference('RENTALS', 2026) AS r")).rows[0]!.r;
  await client.query(
    `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'Fuel cards top-up (SYNTHETIC, draft)', 'Monthly fleet fuel (SYNTHETIC)', 8000, 'TTD', 'draft')`,
    [ref2, shada, ccRentals, catFuel],
  );

  // A requisition in a DIFFERENT department — the A.5.15 acceptance test
  // fetches this as the Rentals requester and must get 404.
  const ref3 = (await client.query<{ r: string }>("SELECT next_reference('ADM', 2026) AS r")).rows[0]!.r;
  await client.query(
    `INSERT INTO requisitions (reference, requester_id, cost_centre_id, category_id, description, justification, amount, currency, status)
     VALUES ($1, $2, $3, $4, 'Stationery order (SYNTHETIC, draft)', 'Front office restock (SYNTHETIC)', 900, 'TTD', 'draft')`,
    [ref3, kerry, ccAdm, catOffice],
  );

  await client.query('COMMIT');
  console.log(
    'seed: complete — Rentals org (Tier 3/4/5 approvers + requesters), Accounts final review, ' +
      'tiered DOA v1 active, Rentals FY2026-Q3 budget, 4 suppliers (1 pending approval), 3 requisitions',
  );
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await db.end();
}
