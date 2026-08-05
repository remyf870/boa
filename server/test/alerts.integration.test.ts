// A.8.16 monitoring: every §8.1 alert condition fires when triggered, and the
// scan is idempotent within its window. Uses the same runAlertScan the
// scheduled job runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { runAlertScan } from '../src/audit/alert-rules.js';
import { writeAudit } from '../src/audit/audit.js';
import { runMigrations } from '../src/db/migrate.js';
import { TEST_DATABASE_URL, testPool } from './helpers.js';

describe.skipIf(!TEST_DATABASE_URL)('alert conditions (A.8.16)', () => {
  let db: pg.Pool;
  let actorId: string;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (entra_object_id, email, display_name)
       VALUES ($1, $2, 'Alert Test Actor') RETURNING id`,
      [`dev-alerts-${randomUUID().slice(0, 8)}`, `alerts-${randomUUID().slice(0, 8)}@example.test`],
    );
    actorId = user.rows[0]!.id;
  });

  afterAll(async () => {
    await db?.end();
  });

  it('repeated failed logins from one IP raise a warning', async () => {
    const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 5; i++) {
      await writeAudit(db, { action: 'auth.login.failed', entityType: 'session', ipAddress: ip });
    }
    const { raised } = await runAlertScan(db);
    expect(raised.some((a) => a.rule === 'repeated_failed_logins' && a.details['ip'] === ip)).toBe(true);
  });

  it('privilege escalation attempts raise a critical alert', async () => {
    await writeAudit(db, { actorUserId: actorId, action: 'role.grant_refused', entityType: 'roles_assignment' });
    const { raised } = await runAlertScan(db);
    expect(raised.some((a) => a.rule === 'privilege_escalation_attempt' && a.severity === 'critical')).toBe(true);
  });

  it('a single bulk export and an export burst both raise warnings (A.8.12)', async () => {
    await writeAudit(db, {
      actorUserId: actorId,
      action: 'data.export',
      entityType: 'export',
      after: { rowCount: 6000 },
    });
    for (let i = 0; i < 10; i++) {
      await writeAudit(db, {
        actorUserId: actorId,
        action: 'data.export',
        entityType: 'export',
        after: { rowCount: 10 },
      });
    }
    const { raised } = await runAlertScan(db);
    expect(raised.some((a) => a.rule === 'bulk_export_volume')).toBe(true);
    expect(raised.some((a) => a.rule === 'bulk_export_frequency' && a.details['actorUserId'] === actorId)).toBe(true);
  });

  it('admin activity outside office hours raises a warning', async () => {
    await writeAudit(db, { actorUserId: actorId, action: 'role.granted', entityType: 'roles_assignment' });
    // Shift "office hours" so the current moment is outside them
    const hourNow = new Date().getUTCHours();
    const { raised } = await runAlertScan(db, {
      officeStartUtc: (hourNow + 1) % 24,
      officeEndUtc: (hourNow + 2) % 24 || 24,
    });
    expect(raised.some((a) => a.rule === 'out_of_hours_admin_activity')).toBe(true);
  });

  it('a broken audit chain raises a critical alert', async () => {
    await writeAudit(db, { action: 'test.alert.chain', entityType: 'test', after: { marker: randomUUID() } });
    const { rows } = await db.query<{ seq: string; after: unknown }>(
      "SELECT seq::text, after FROM audit_log WHERE action = 'test.alert.chain' ORDER BY seq DESC LIMIT 1",
    );
    const target = rows[0]!;
    const client = await db.connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete_tg');
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_hash_chain_tg');
      await client.query(`UPDATE audit_log SET after = '{"tampered":true}'::jsonb WHERE seq = $1`, [target.seq]);

      const { raised, chainOk } = await runAlertScan(db);
      expect(chainOk).toBe(false);
      expect(raised.some((a) => a.rule === 'audit_chain_verification_failed' && a.severity === 'critical')).toBe(true);

      await client.query('UPDATE audit_log SET after = $2 WHERE seq = $1', [target.seq, JSON.stringify(target.after)]);
    } finally {
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_hash_chain_tg');
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete_tg');
      client.release();
    }
  });

  it('is idempotent inside the window — the same condition does not re-alert', async () => {
    const first = await runAlertScan(db);
    expect(first.chainOk).toBe(true); // restored above
    const second = await runAlertScan(db);
    const rulesFirstRun = new Set(first.raised.map((a) => `${a.rule}:${JSON.stringify(a.details)}`));
    for (const again of second.raised) {
      expect(rulesFirstRun.has(`${again.rule}:${JSON.stringify(again.details)}`)).toBe(false);
    }
  });
});
