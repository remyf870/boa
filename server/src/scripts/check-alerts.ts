// A.8.16 monitoring job. Scans the audit log for the alert conditions named in
// plan §8.1 and raises alert rows (which ops forwards to the SIEM / email).
// Schedule every 15 minutes. Conditions:
//   - repeated failed logins            → warning
//   - privilege escalation attempts     → critical (also raised inline)
//   - bulk export volume                → warning
//   - out-of-hours admin activity       → warning
//   - audit chain verification failure  → critical
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { raiseAlert, verifyAuditChain } from '../audit/audit.js';

const WINDOW_MINUTES = 60;
const FAILED_LOGIN_THRESHOLD = 5;
const EXPORTS_PER_ACTOR_THRESHOLD = 10;
const EXPORT_ROWS_THRESHOLD = 5000;
// Office hours in local Trinidad time (UTC-4). TODO(client): confirm hours.
const OFFICE_START_UTC = 10; // 06:00 AST
const OFFICE_END_UTC = 24; // 20:00 AST

const config = loadConfig();
const db = createPool(config);
let raised = 0;

async function alertOnce(rule: string, severity: 'info' | 'warning' | 'critical', details: Record<string, unknown>) {
  const dupe = await db.query(
    `SELECT 1 FROM alerts
     WHERE rule = $1 AND details @> $2::jsonb
       AND raised_at > now() - make_interval(mins => $3)`,
    [rule, JSON.stringify(details), WINDOW_MINUTES],
  );
  if (dupe.rows.length > 0) return;
  await raiseAlert(db, rule, severity, details);
  raised += 1;
  console.log(`ALERT [${severity}] ${rule}: ${JSON.stringify(details)}`);
}

// 1. Repeated failed logins (per source IP)
const failedLogins = await db.query<{ ip: string | null; n: string }>(
  `SELECT ip_address::text AS ip, count(*)::text AS n
   FROM audit_log
   WHERE action IN ('auth.login.failed', 'auth.break_glass.failed')
     AND occurred_at > now() - make_interval(mins => $1)
   GROUP BY ip_address
   HAVING count(*) >= $2`,
  [WINDOW_MINUTES, FAILED_LOGIN_THRESHOLD],
);
for (const row of failedLogins.rows) {
  await alertOnce('repeated_failed_logins', 'warning', { ip: row.ip ?? 'unknown', count: Number(row.n) });
}

// 2. Privilege escalation attempts recorded by the app
const escalations = await db.query<{ seq: string; actor: string | null }>(
  `SELECT seq::text, actor_user_id::text AS actor FROM audit_log
   WHERE action = 'role.grant_refused'
     AND occurred_at > now() - make_interval(mins => $1)`,
  [WINDOW_MINUTES],
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
  [WINDOW_MINUTES, EXPORT_ROWS_THRESHOLD],
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
  [WINDOW_MINUTES, EXPORTS_PER_ACTOR_THRESHOLD],
);
for (const row of manyExports.rows) {
  await alertOnce('bulk_export_frequency', 'warning', { actorUserId: row.actor, count: Number(row.n) });
}

// 4. Out-of-hours admin activity
const outOfHours = await db.query<{ seq: string; action: string; actor: string | null }>(
  `SELECT seq::text, action, actor_user_id::text AS actor
   FROM audit_log
   WHERE action IN ('role.granted', 'role.revoked', 'user.status_changed', 'auth.break_glass.login')
     AND occurred_at > now() - make_interval(mins => $1)
     AND (extract(hour FROM occurred_at AT TIME ZONE 'UTC') < $2
          OR extract(hour FROM occurred_at AT TIME ZONE 'UTC') >= $3)`,
  [WINDOW_MINUTES, OFFICE_START_UTC, OFFICE_END_UTC],
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
  await alertOnce('audit_chain_verification_failed', 'critical', {
    defectCount: chain.defects.length,
    firstDefectSeq: chain.defects[0]?.seq ?? null,
  });
}

console.log(`check-alerts: done — ${raised} new alert(s) raised`);
await db.end();
process.exit(chain.ok ? 0 : 1);
