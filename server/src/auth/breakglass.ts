// The single break-glass local account (A.5.17): argon2id password + TOTP MFA,
// lockout on repeated failure, and every use raises a critical alert and an
// audit entry. Credentials are provisioned by `npm run provision-breakglass`
// and belong in the client's vault. This is the ONLY password logic in the app.
//
// Hardening (adversarial-review findings):
//  - the whole attempt runs in a SELECT ... FOR UPDATE transaction, so the
//    failure counter is race-free and the lock check is not TOCTOU;
//  - a lapsed lockout resets the counter (an unauthenticated attacker cannot
//    re-arm the lockout forever with one bad request per window);
//  - argon2 verification always runs, and the username comparison is
//    timing-safe, so response time does not disclose the username;
//  - each TOTP time step is consumable once (replay protection).
import { createHash, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import type pg from 'pg';
import type { Config } from '../config.js';
import { AuditAction, raiseAlert, writeAudit } from '../audit/audit.js';
import { decryptSecret } from './crypto.js';

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;
const TOTP_STEP_SECONDS = 30;

// +/-1 time step for clock skew, per docs/CRYPTO.md section 6
authenticator.options = { ...authenticator.options, window: 1 };

// A syntactically valid argon2id hash of a random value, used so verification
// work is always performed even when the username does not match.
const DECOY_HASH_PROMISE = argon2Hash('decoy-never-matches', {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});

function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

interface BreakGlassRow {
  username: string;
  password_hash: string;
  totp_secret_enc: string;
  enabled: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  last_totp_step: string | null;
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
  const audit = async (reason: string) => {
    await writeAudit(db, {
      action: AuditAction.BreakGlassFailed,
      entityType: 'break_glass_account',
      after: { reason, usernameAttempted: input.username },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<BreakGlassRow>(
      'SELECT * FROM break_glass_account WHERE id = 1 FOR UPDATE',
    );
    const account = rows[0];

    if (!account) {
      await client.query('COMMIT');
      await audit('not_provisioned');
      return { ok: false, reason: 'not_provisioned' };
    }
    if (!account.enabled) {
      await client.query('COMMIT');
      await audit('disabled');
      return { ok: false, reason: 'disabled' };
    }
    const lockActive = account.locked_until !== null && account.locked_until.getTime() > Date.now();
    if (lockActive) {
      await client.query('COMMIT');
      await audit('locked');
      return { ok: false, reason: 'locked' };
    }

    // Verification work is constant-shape: argon2 always runs; username
    // comparison is timing-safe; TOTP check always runs when password side
    // passed.
    const usernameOk = timingSafeStringEqual(account.username, input.username);
    const hashToVerify = usernameOk ? account.password_hash : await DECOY_HASH_PROMISE;
    const passwordOk = (await argon2Verify(hashToVerify, input.password)) && usernameOk;

    let totpStep: number | null = null;
    if (passwordOk) {
      const secret = decryptSecret(config.BREAK_GLASS_KEY, account.totp_secret_enc);
      const delta = authenticator.checkDelta(input.totp, secret);
      if (delta !== null) {
        const step = Math.floor(Date.now() / (TOTP_STEP_SECONDS * 1000)) + delta;
        // Replay protection: each time step is consumable exactly once
        if (account.last_totp_step === null || step > Number(account.last_totp_step)) {
          totpStep = step;
        }
      }
    }

    if (!passwordOk || totpStep === null) {
      // A lapsed lockout starts a fresh count instead of compounding forever
      const lockLapsed = account.locked_until !== null;
      const failures = lockLapsed ? 1 : account.failed_attempts + 1;
      const lockNow = failures >= MAX_FAILURES;
      await client.query(
        `UPDATE break_glass_account
         SET failed_attempts = $1,
             locked_until = CASE WHEN $2 THEN now() + make_interval(mins => $3) ELSE NULL END,
             updated_at = now()
         WHERE id = 1`,
        [failures, lockNow, LOCKOUT_MINUTES],
      );
      await client.query('COMMIT');
      if (lockNow) {
        await raiseAlert(db, 'break_glass_lockout', 'critical', {
          failures,
          ipAddress: meta.ipAddress ?? null,
        });
      }
      await audit('invalid');
      return { ok: false, reason: 'invalid' };
    }

    await client.query(
      `UPDATE break_glass_account
       SET failed_attempts = 0, locked_until = NULL, last_totp_step = $1,
           last_used_at = now(), updated_at = now()
       WHERE id = 1`,
      [totpStep],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // The break-glass identity is a real users row so audit linkage and role
  // scoping work identically to every other actor.
  const userRow = await db.query<{ id: string }>("SELECT id FROM users WHERE entra_object_id = 'break-glass'");
  if (!userRow.rows[0]) {
    await audit('not_provisioned');
    return { ok: false, reason: 'not_provisioned' };
  }
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
