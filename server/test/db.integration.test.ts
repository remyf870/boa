// Database-level compliance gates (§8.1). Requires DATABASE_URL; CI provides a
// disposable PostgreSQL 16. Records are undeletable by design, so tests create
// uniquely-tagged rows instead of cleaning up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { verifyAuditChain, writeAudit } from '../src/audit/audit.js';
import { createActors, RUN, TEST_DATABASE_URL, testPool, type TestActors } from './helpers.js';

describe.skipIf(!TEST_DATABASE_URL)('database compliance gates', () => {
  let db: pg.Pool;
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    actors = await createActors(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  it('A.8.32: migrations are idempotent and recorded with hashes', async () => {
    const second = await runMigrations(TEST_DATABASE_URL!);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThanOrEqual(6);
    const { rows } = await db.query('SELECT name, sha256 FROM schema_migrations ORDER BY name');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('A.8.15: audit rows are hash-chained and the chain verifies', async () => {
    await writeAudit(db, { actorUserId: actors.requester, action: `test.chain.${RUN}`, entityType: 'test' });
    await writeAudit(db, { actorUserId: actors.requester, action: `test.chain.${RUN}`, entityType: 'test', after: { x: 1 } });
    const result = await verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBeGreaterThanOrEqual(2);
    const { rows } = await db.query(
      'SELECT prev_hash, row_hash FROM audit_log ORDER BY seq DESC LIMIT 2',
    );
    expect(rows[0].prev_hash).toBe(rows[1].row_hash); // linked
  });

  it('A.8.15: UPDATE and DELETE on audit_log are rejected at the DB layer', async () => {
    await expect(db.query('UPDATE audit_log SET action = $1 WHERE seq = 1', ['tampered'])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query('DELETE FROM audit_log WHERE seq = 1')).rejects.toThrow(/append-only/);
  });

  it('A.8.15: tampering is detected by chain verification even when triggers are bypassed', async () => {
    // Simulate a privileged attacker: disable protections, edit history, restore
    const { rows } = await db.query<{ seq: string; after: unknown }>(
      'SELECT seq::text, after FROM audit_log WHERE action = $1 ORDER BY seq LIMIT 1',
      [`test.chain.${RUN}`],
    );
    const target = rows[0]!.seq;
    const original = rows[0]!.after;
    const client = await db.connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete_tg');
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_hash_chain_tg');
      await client.query(`UPDATE audit_log SET after = '{"tampered":true}'::jsonb WHERE seq = $1`, [target]);
      const broken = await verifyAuditChain(db);
      expect(broken.ok).toBe(false);
      expect(broken.defects.some((d) => d.seq === target)).toBe(true);
      // restore the exact original value so later tests see an intact chain
      await client.query('UPDATE audit_log SET after = $2 WHERE seq = $1', [
        target,
        original === null ? null : JSON.stringify(original),
      ]);
    } finally {
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_hash_chain_tg');
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete_tg');
      client.release();
    }
    const restored = await verifyAuditChain(db);
    expect(restored.ok).toBe(true);
  });

  it('A.5.33: financial records cannot be deleted', async () => {
    await expect(db.query('DELETE FROM requisitions WHERE id = $1', [actors.leaRequisition])).rejects.toThrow(
      /no-delete|append-only/,
    );
    await expect(db.query('DELETE FROM roles_assignments WHERE user_id = $1', [actors.requester])).rejects.toThrow(
      /no-delete|append-only/,
    );
  });

  it('A.5.3: the SoD trigger blocks conflicting role grants', async () => {
    // approver + accounting on the same user must be impossible
    await expect(
      db.query(
        `INSERT INTO roles_assignments (user_id, role, granted_by, granted_reason)
         VALUES ($1, 'accounting', $2, 'sod test')`,
        [actors.approver, actors.sysadmin],
      ),
    ).rejects.toThrow(/segregation of duties/);
    // sysadmin + approver must be impossible
    await expect(
      db.query(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
         VALUES ($1, 'approver', $2, $3, 'sod test')`,
        [actors.sysadmin, actors.ccLea, actors.sysadmin],
      ),
    ).rejects.toThrow(/segregation of duties/);
  });

  it('§6.1 two-person rule: a DOA version cannot be approved by its uploader', async () => {
    await expect(
      db.query(
        `INSERT INTO doa_matrix_versions (version_no, status, uploaded_by, approved_by, approved_at)
         VALUES (990000 + floor(random() * 9999)::int, 'active', $1, $1, now())`,
        [actors.sysadmin],
      ),
    ).rejects.toThrow(/two_person_rule/);
  });

  it('§5.3: reference issuance is sequential and gap-free per prefix/year', async () => {
    const prefix = `T${RUN.slice(0, 4)}`;
    const a = await db.query<{ r: string }>('SELECT next_reference($1, 2026) AS r', [prefix]);
    const b = await db.query<{ r: string }>('SELECT next_reference($1, 2026) AS r', [prefix]);
    expect(a.rows[0]!.r).toBe(`MM-${prefix}-2026-0001`);
    expect(b.rows[0]!.r).toBe(`MM-${prefix}-2026-0002`);
  });

  it('§5.2: a denial without a reason is rejected by the schema', async () => {
    await expect(
      db.query(
        `INSERT INTO approval_steps (requisition_id, step_no, assigned_user_id, decision, decided_at)
         VALUES ($1, 99, $2, 'denied', now())`,
        [actors.leaRequisition, actors.approver],
      ),
    ).rejects.toThrow(/denial_requires_reason/);
  });

  it('A.5.34: no bank/payment fields exist anywhere in the schema', async () => {
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (column_name ILIKE '%bank%' OR column_name ILIKE '%iban%' OR column_name ILIKE '%swift%'
              OR column_name ILIKE '%routing%' OR column_name ILIKE '%sort_code%'
              OR column_name ILIKE '%beneficiary%' OR column_name ILIKE '%card%'
              OR column_name ILIKE '%account_no%' OR column_name ILIKE '%payment%')`,
    );
    expect(rows).toEqual([]);
  });

  it('A.8.17: every timestamp column in the schema is timestamptz — no naive local times', async () => {
    // Schema-wide: any future table with a naive timestamp fails this too
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND data_type = 'timestamp without time zone'`,
    );
    expect(rows).toEqual([]);
  });

  it('A.5.12: classification columns exist with the mandated defaults', async () => {
    const { rows } = await db.query<{ table_name: string; column_default: string }>(
      `SELECT table_name, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'classification'
       ORDER BY table_name`,
    );
    const byTable = new Map(rows.map((r) => [r.table_name, r.column_default]));
    expect(byTable.get('requisitions')).toContain('internal');
    expect(byTable.get('invoices')).toContain('confidential'); // invoices are Confidential per §8.1
    expect(byTable.get('attachments')).toContain('internal');
  });

  it('A.8.3/A.5.33: connected as the massy_app role, RLS scopes rows and DELETE is impossible', async () => {
    await db.query('GRANT massy_app TO current_user');
    const client = await db.connect();
    try {
      await client.query('SET ROLE massy_app');

      // no acting user → zero rows (default-deny at the database itself)
      await client.query(`SELECT set_config('app.user_id', '', false)`);
      const anonymous = await client.query('SELECT count(*)::int AS n FROM requisitions');
      expect(anonymous.rows[0].n).toBe(0);

      // as the LEA requester: own requisition visible, the ADM one invisible
      await client.query(`SELECT set_config('app.user_id', $1, false)`, [actors.requester]);
      const own = await client.query('SELECT EXISTS (SELECT 1 FROM requisitions WHERE id = $1) AS v', [
        actors.leaRequisition,
      ]);
      const foreign = await client.query('SELECT EXISTS (SELECT 1 FROM requisitions WHERE id = $1) AS v', [
        actors.admRequisition,
      ]);
      expect(own.rows[0].v).toBe(true);
      expect(foreign.rows[0].v).toBe(false);

      // a non-auditor cannot read audit detail even with direct SQL
      const audit = await client.query('SELECT count(*)::int AS n FROM audit_log');
      expect(audit.rows[0].n).toBe(0);

      // the app role holds no DELETE grant on records (A.5.33)
      await expect(client.query('DELETE FROM requisitions WHERE id = $1', [actors.leaRequisition])).rejects.toThrow(
        /permission denied|not permitted/,
      );
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      await client.query(`SELECT set_config('app.user_id', '', false)`).catch(() => undefined);
      client.release();
    }
  });
});
