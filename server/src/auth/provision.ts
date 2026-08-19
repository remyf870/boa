// Identity provisioning (A.5.16): identities come from Entra ID. On first
// login a local user row is created to hold role grants and audit linkage.
// Authorisation (roles) is NEVER granted here — a new user has no roles until
// a System Admin assigns them (default-deny, A.5.15).
import type pg from 'pg';
import { AuditAction, raiseAlert, writeAudit } from '../audit/audit.js';

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

  // A sysadmin may pre-provision a user (client change list, "System Admin
  // UI") with a placeholder identity ('pending-…'). The row is CLAIMED on the
  // person's first real sign-in by case-insensitive email match — roles the
  // admin granted in advance apply from the first session. Only rows that
  // were never signed into are claimable; a real identity is never rebound.
  const preProvisioned = await db.query<UserRow>(
    `SELECT id, email, display_name, status FROM users
     WHERE lower(email) = lower($1) AND entra_object_id LIKE 'pending-%'`,
    [claims.email],
  );
  if (preProvisioned.rows[0]) {
    const row = preProvisioned.rows[0];
    await db.query(
      `UPDATE users SET entra_object_id = $2, email = $3, display_name = $4,
              job_title = coalesce($5, job_title), updated_at = now()
       WHERE id = $1`,
      [row.id, claims.entraObjectId, claims.email, claims.displayName, claims.jobTitle ?? null],
    );
    await writeAudit(db, {
      actorUserId: row.id,
      action: AuditAction.UserProvisioned,
      entityType: 'user',
      entityId: row.id,
      after: { email: claims.email, displayName: claims.displayName, claimedPreProvisioned: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    // Whoever holds this Entra identity now holds every pre-granted role —
    // the email match above is the ONLY binding check, so surface each
    // role-bearing claim for review (adversarial-review finding: a typo'd
    // or attacker-controlled in-tenant address would inherit the roles
    // silently otherwise).
    const liveRoles = await db.query<{ role: string }>(
      'SELECT DISTINCT role FROM roles_assignments WHERE user_id = $1 AND revoked_at IS NULL',
      [row.id],
    );
    if (liveRoles.rows.length > 0) {
      const roles = liveRoles.rows.map((r) => r.role).sort();
      const highPrivilege = ['accounting', 'budget_approver', 'doa_approver', 'supplier_approver', 'sysadmin'];
      await raiseAlert(
        db,
        'pre_provisioned_role_claim',
        roles.some((r) => highPrivilege.includes(r)) ? 'critical' : 'warning',
        { userId: row.id, email: claims.email, entraObjectId: claims.entraObjectId, roles },
      );
    }
    return { ...row, display_name: claims.displayName, email: claims.email };
  }
  let inserted: { rows: UserRow[] };
  try {
    inserted = await db.query<UserRow>(
      `INSERT INTO users (entra_object_id, email, display_name, job_title)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, status`,
      [claims.entraObjectId, claims.email, claims.displayName, claims.jobTitle ?? null],
    );
  } catch (err) {
    // users_email_lower_uq: the email already belongs to a row bound to a
    // DIFFERENT, real Entra identity (Entra re-issued the address, or two
    // identities share a mailbox). Never rebind silently — fail with a
    // message an operator can act on instead of a bare constraint error.
    if (err instanceof Error && err.message.includes('users_email_lower_uq')) {
      throw new Error(
        `identity provisioning refused: ${claims.email} is already bound to a different Entra identity — an administrator must resolve the conflict`,
      );
    }
    throw err;
  }
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
