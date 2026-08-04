// DB-backed sessions (A.8.5): the cookie carries a random 256-bit token, the
// database stores only its SHA-256. Idle timeout 30 min, absolute 8 h,
// revocation immediate. Roles are re-read from the database on every request,
// so a revoked role loses access within one request (A.5.18).
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config.js';
import { AuditAction, writeAudit } from '../audit/audit.js';

export type SessionVia = 'entra' | 'dev' | 'break_glass';

export interface RoleGrant {
  role: string;
  costCentreId: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  status: string;
  bannerAcknowledged: boolean;
  roles: RoleGrant[];
  sessionId: string;
  csrfToken: string;
  via: SessionVia;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(
  db: pg.Pool,
  config: Config,
  params: { userId: string; via: SessionVia; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ token: string }> {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, via, absolute_expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6, $7)`,
    [
      params.userId,
      sha256(token),
      csrfToken,
      params.via,
      config.session.absoluteHours,
      params.ipAddress ?? null,
      params.userAgent ?? null,
    ],
  );
  return { token };
}

export type SessionFailure = 'no_session' | 'expired_idle' | 'expired_absolute' | 'revoked' | 'user_disabled';

export async function resolveSession(
  db: pg.Pool,
  config: Config,
  token: string | undefined,
): Promise<{ user: CurrentUser } | { failure: SessionFailure; auditUserId?: string }> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return { failure: 'no_session' };

  const { rows } = await db.query<{
    session_id: string;
    csrf_token: string;
    via: SessionVia;
    revoked_at: Date | null;
    idle_expired: boolean;
    absolute_expired: boolean;
    user_id: string;
    email: string;
    display_name: string;
    job_title: string | null;
    status: string;
    banner_acknowledged_at: Date | null;
    banner_version: number | null;
  }>(
    `SELECT s.id AS session_id, s.csrf_token, s.via, s.revoked_at,
            (s.last_seen_at < now() - make_interval(mins => $2)) AS idle_expired,
            (s.absolute_expires_at < now()) AS absolute_expired,
            u.id AS user_id, u.email, u.display_name, u.job_title, u.status,
            u.banner_acknowledged_at, u.banner_version
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [sha256(token), config.session.idleMinutes],
  );
  const row = rows[0];
  if (!row) return { failure: 'no_session' };
  if (row.revoked_at) return { failure: 'revoked', auditUserId: row.user_id };
  if (row.absolute_expired || row.idle_expired) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.session_id]);
    await writeAudit(db, {
      actorUserId: row.user_id,
      action: AuditAction.SessionExpired,
      entityType: 'session',
      entityId: row.session_id,
      after: { reason: row.absolute_expired ? 'absolute' : 'idle' },
    });
    return { failure: row.absolute_expired ? 'expired_absolute' : 'expired_idle', auditUserId: row.user_id };
  }
  // A.5.16 / A.5.18: a disabled user's existing session dies on next request
  if (row.status !== 'active') {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.session_id]);
    return { failure: 'user_disabled', auditUserId: row.user_id };
  }

  await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);

  const roleRows = await db.query<{ role: string; cost_centre_id: string | null }>(
    'SELECT role, cost_centre_id FROM roles_assignments WHERE user_id = $1 AND revoked_at IS NULL',
    [row.user_id],
  );

  return {
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      jobTitle: row.job_title,
      status: row.status,
      bannerAcknowledged: row.banner_acknowledged_at !== null && row.banner_version === config.bannerVersion,
      roles: roleRows.rows.map((r) => ({ role: r.role, costCentreId: r.cost_centre_id })),
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
      via: row.via,
    },
  };
}

export async function revokeSession(db: pg.Pool, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}
