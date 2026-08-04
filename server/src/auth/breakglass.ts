// The single break-glass local account (A.5.17): argon2id password + TOTP MFA,
// lockout on repeated failure, and every use raises a critical alert and an
// audit entry. Credentials are provisioned by `npm run provision-breakglass`
// and belong in the client's vault. This is the ONLY password logic in the app.
import { verify as argon2Verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import type pg from 'pg';
import type { Config } from '../config.js';
import { AuditAction, raiseAlert, writeAudit } from '../audit/audit.js';
import { decryptSecret } from './crypto.js';

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

interface BreakGlassRow {
  username: string;
  password_hash: string;
  totp_secret_enc: string;
  enabled: boolean;
  failed_attempts: number;
  locked_until: Date | null;
}

export type BreakGlassResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled' | 'not_provisioned' };

export async function attemptBreakGlassLogin(
  db: pg.Pool,
  config: Config,
  input: { username: string; password: string; totp: string },
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<BreakGlassResult> {
  const { rows } = await db.query<BreakGlassRow>('SELECT * FROM break_glass_account WHERE id = 1');
  const account = rows[0];

  const fail = async (reason: 'invalid' | 'locked' | 'disabled' | 'not_provisioned'): Promise<BreakGlassResult> => {
    await writeAudit(db, {
      action: AuditAction.BreakGlassFailed,
      entityType: 'break_glass_account',
      after: { reason, usernameAttempted: input.username },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return { ok: false, reason };
  };

  if (!account) return fail('not_provisioned');
  if (!account.enabled) return fail('disabled');
  if (account.locked_until && account.locked_until.getTime() > Date.now()) return fail('locked');

  const passwordOk =
    account.username === input.username && (await argon2Verify(account.password_hash, input.password));
  let totpOk = false;
  if (passwordOk) {
    const secret = decryptSecret(config.BREAK_GLASS_KEY, account.totp_secret_enc);
    totpOk = authenticator.verify({ token: input.totp, secret });
  }

  if (!passwordOk || !totpOk) {
    const failures = account.failed_attempts + 1;
    await db.query(
      `UPDATE break_glass_account
       SET failed_attempts = $1,
           locked_until = CASE WHEN $1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
           updated_at = now()
       WHERE id = 1`,
      [failures, MAX_FAILURES, LOCKOUT_MINUTES],
    );
    if (failures >= MAX_FAILURES) {
      await raiseAlert(db, 'break_glass_lockout', 'critical', {
        failures,
        ipAddress: meta.ipAddress ?? null,
      });
    }
    return fail('invalid');
  }

  await db.query(
    'UPDATE break_glass_account SET failed_attempts = 0, locked_until = NULL, last_used_at = now(), updated_at = now() WHERE id = 1',
  );

  // The break-glass identity is a real users row so audit linkage and role
  // scoping work identically to every other actor.
  const userRow = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE entra_object_id = 'break-glass'",
  );
  if (!userRow.rows[0]) return fail('not_provisioned');
  const userId = userRow.rows[0].id;

  // A.5.17 / A.8.16: use of break-glass is always alertable
  await writeAudit(db, {
    actorUserId: userId,
    action: AuditAction.BreakGlassLogin,
    entityType: 'break_glass_account',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  await raiseAlert(db, 'break_glass_used', 'critical', {
    userId,
    ipAddress: meta.ipAddress ?? null,
    at: new Date().toISOString(),
  });
  return { ok: true, userId };
}
