// Audit write path (A.8.15). Every security- or record-relevant event goes
// through here. Hashing/chaining happens in the database trigger (0003) so
// there is exactly one implementation; this module only appends.
import type pg from 'pg';

/** Canonical action names. Add here — never inline strings — so the log stays queryable. */
export const AuditAction = {
  LoginSuccess: 'auth.login.success',
  LoginFailed: 'auth.login.failed',
  Logout: 'auth.logout',
  BreakGlassLogin: 'auth.break_glass.login',
  BreakGlassFailed: 'auth.break_glass.failed',
  SessionExpired: 'auth.session.expired',
  UserProvisioned: 'user.provisioned',
  UserStatusChanged: 'user.status_changed',
  BannerAcknowledged: 'user.banner_acknowledged',
  RoleGranted: 'role.granted',
  RoleRevoked: 'role.revoked',
  RoleGrantRefused: 'role.grant_refused',
  AccessDenied: 'access.denied',
  Export: 'data.export',
  ChainVerified: 'audit.chain.verified',
  ChainFailed: 'audit.chain.verification_failed',
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  actorUserId?: string | null | undefined;
  action: AuditActionName | string;
  entityType: string;
  entityId?: string | null | undefined;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  );
}

export interface ChainVerification {
  ok: boolean;
  totalRows: number;
  defects: { seq: string; problem: string }[];
}

/** Full-chain verification (A.8.15 / A.5.28). Zero defects = intact. */
export async function verifyAuditChain(db: Queryable): Promise<ChainVerification> {
  const total = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log');
  const defects = await db.query<{ seq: string; problem: string }>(
    'SELECT seq::text, problem FROM audit_chain_defects()',
  );
  return {
    ok: defects.rows.length === 0,
    totalRows: Number(total.rows[0]?.n ?? 0),
    defects: defects.rows,
  };
}

export async function raiseAlert(
  db: Queryable,
  rule: string,
  severity: 'info' | 'warning' | 'critical',
  details: Record<string, unknown>,
): Promise<void> {
  await db.query('INSERT INTO alerts (rule, severity, details) VALUES ($1, $2, $3)', [
    rule,
    severity,
    JSON.stringify(details),
  ]);
}
