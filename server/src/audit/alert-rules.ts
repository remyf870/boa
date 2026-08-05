// A.8.16 alert-condition detection. Pure module so the scheduled job
// (scripts/check-alerts.ts) and the test suite share one implementation.
// Conditions per plan §8.1: repeated failed logins, privilege escalation,
// bulk export, out-of-hours admin activity, audit chain verification failure.
import type pg from 'pg';
import { raiseAlert, verifyAuditChain } from './audit.js';

export interface AlertThresholds {
  windowMinutes: number;
  failedLogins: number;
  exportsPerActor: number;
  exportRows: number;
  officeStartUtc: number;
  officeEndUtc: number;
}

export const ALERT_THRESHOLDS: AlertThresholds = {
  windowMinutes: 60,
  failedLogins: 5,
  exportsPerActor: 10,
  exportRows: 5000,
  // Office hours in UTC. Trinidad is UTC-4, so 10:00–24:00 UTC = 06:00–20:00 AST.
  // TODO(client): confirm office hours.
  officeStartUtc: 10,
  officeEndUtc: 24,
};

export interface RaisedAlert {
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  details: Record<string, unknown>;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/**
 * Scan the audit log for §8.1 alert conditions and insert alert rows for any
 * not already raised (same rule + details) inside the window. Returns what was
 * newly raised. Exit code / delivery is the caller's concern.
 * `overrides` exists for tests (e.g. shifting office hours); production callers
 * pass nothing.
 */
export async function runAlertScan(
  db: Queryable,
  overrides: Partial<AlertThresholds> = {},
): Promise<{ raised: RaisedAlert[]; chainOk: boolean }> {
  const t = { ...ALERT_THRESHOLDS, ...overrides };
  const raised: RaisedAlert[] = [];

  // Dedup is on the stable `identity` only — volatile values (running counts)
  // go in `extra`, otherwise an ongoing attack re-alerts every scan.
  const alertOnce = async (
    rule: string,
    severity: RaisedAlert['severity'],
    identity: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const dupe = await db.query(
      `SELECT 1 FROM alerts
       WHERE rule = $1 AND details @> $2::jsonb
         AND raised_at > now() - make_interval(mins => $3)`,
      [rule, JSON.stringify(identity), t.windowMinutes],
    );
    if (dupe.rows.length > 0) return;
    const details = { ...identity, ...extra };
    await raiseAlert(db, rule, severity, details);
    raised.push({ rule, severity, details });
  };

  // 1. Repeated failed logins (per source IP)
  const failedLogins = await db.query<{ ip: string | null; n: string }>(
    `SELECT host(ip_address) AS ip, count(*)::text AS n
     FROM audit_log
     WHERE action IN ('auth.login.failed', 'auth.break_glass.failed')
       AND occurred_at > now() - make_interval(mins => $1)
     GROUP BY ip_address
     HAVING count(*) >= $2`,
    [t.windowMinutes, t.failedLogins],
  );
  for (const row of failedLogins.rows) {
    await alertOnce('repeated_failed_logins', 'warning', { ip: row.ip ?? 'unknown' }, { count: Number(row.n) });
  }

  // 2. Privilege escalation attempts recorded by the app
  const escalations = await db.query<{ seq: string; actor: string | null }>(
    `SELECT seq::text, actor_user_id::text AS actor FROM audit_log
     WHERE action = 'role.grant_refused'
       AND occurred_at > now() - make_interval(mins => $1)`,
    [t.windowMinutes],
  );
  for (const row of escalations.rows) {
    await alertOnce('privilege_escalation_attempt', 'critical', { auditSeq: row.seq, actorUserId: row.actor });
  }

  // 3. Bulk export: any single huge export, or many exports by one actor (A.8.12)
  const bigExports = await db.query<{ seq: string; actor: string | null; rows: number }>(
    `SELECT seq::text, actor_user_id::text AS actor, (after->>'rowCount')::int AS rows
     FROM audit_log
     WHERE action = 'data.export'
       AND occurred_at > now() - make_interval(mins => $1)
       AND (after->>'rowCount')::int >= $2`,
    [t.windowMinutes, t.exportRows],
  );
  for (const row of bigExports.rows) {
    await alertOnce('bulk_export_volume', 'warning', { auditSeq: row.seq, actorUserId: row.actor, rowCount: row.rows });
  }
  const manyExports = await db.query<{ actor: string | null; n: string }>(
    `SELECT actor_user_id::text AS actor, count(*)::text AS n
     FROM audit_log
     WHERE action = 'data.export'
       AND occurred_at > now() - make_interval(mins => $1)
     GROUP BY actor_user_id
     HAVING count(*) >= $2`,
    [t.windowMinutes, t.exportsPerActor],
  );
  for (const row of manyExports.rows) {
    await alertOnce('bulk_export_frequency', 'warning', { actorUserId: row.actor }, { count: Number(row.n) });
  }

  // 4. Out-of-hours admin activity
  const outOfHours = await db.query<{ seq: string; action: string; actor: string | null }>(
    `SELECT seq::text, action, actor_user_id::text AS actor
     FROM audit_log
     WHERE action IN ('role.granted', 'role.revoked', 'user.status_changed', 'auth.break_glass.login')
       AND occurred_at > now() - make_interval(mins => $1)
       AND (extract(hour FROM occurred_at AT TIME ZONE 'UTC') < $2
            OR extract(hour FROM occurred_at AT TIME ZONE 'UTC') >= $3)`,
    [t.windowMinutes, t.officeStartUtc, t.officeEndUtc],
  );
  for (const row of outOfHours.rows) {
    await alertOnce('out_of_hours_admin_activity', 'warning', {
      auditSeq: row.seq,
      action: row.action,
      actorUserId: row.actor,
    });
  }

  // 5. Audit chain integrity (A.8.15)
  const chain = await verifyAuditChain(db);
  if (!chain.ok) {
    await alertOnce(
      'audit_chain_verification_failed',
      'critical',
      { firstDefectSeq: chain.defects[0]?.seq ?? null },
      { defectCount: chain.defects.length },
    );
  }

  return { raised, chainOk: chain.ok };
}
