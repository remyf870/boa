// Identity provisioning (A.5.16): identities come from Entra ID. On first
// login a local user row is created to hold role grants and audit linkage.
// Authorisation (roles) is NEVER granted here — a new user has no roles until
// a System Admin assigns them (default-deny, A.5.15).
import type pg from 'pg';
import { AuditAction, writeAudit } from '../audit/audit.js';

export interface IdentityClaims {
  entraObjectId: string;
  email: string;
  displayName: string;
  jobTitle?: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
}

export async function provisionUser(
  db: pg.Pool,
  claims: IdentityClaims,
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<UserRow> {
  const existing = await db.query<UserRow>('SELECT id, email, display_name, status FROM users WHERE entra_object_id = $1', [
    claims.entraObjectId,
  ]);
  if (existing.rows[0]) {
    // Keep directory attributes current; never touch status or roles here
    await db.query(
      'UPDATE users SET email = $2, display_name = $3, job_title = $4, updated_at = now() WHERE id = $1',
      [existing.rows[0].id, claims.email, claims.displayName, claims.jobTitle ?? null],
    );
    return existing.rows[0];
  }
  const inserted = await db.query<UserRow>(
    `INSERT INTO users (entra_object_id, email, display_name, job_title)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, display_name, status`,
    [claims.entraObjectId, claims.email, claims.displayName, claims.jobTitle ?? null],
  );
  const user = inserted.rows[0]!;
  await writeAudit(db, {
    actorUserId: user.id,
    action: AuditAction.UserProvisioned,
    entityType: 'user',
    entityId: user.id,
    after: { email: claims.email, displayName: claims.displayName },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return user;
}
