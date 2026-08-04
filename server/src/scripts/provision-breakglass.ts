// Provisions the single break-glass account (A.5.17). Prints the credentials
// EXACTLY ONCE — they go straight into the client's vault (see
// docs/runbooks/access-provisioning.md). Re-running rotates the credentials.
import { randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { encryptSecret } from '../auth/crypto.js';

const config = loadConfig();
const db = createPool(config);

const username = 'breakglass-admin';
// 32 chars from a URL-safe alphabet — vault-friendly, never reused
const password = randomBytes(24).toString('base64url');
const totpSecret = authenticator.generateSecret(20);

// argon2id parameters per docs/CRYPTO.md: 64 MiB, 3 iterations, parallelism 1
const passwordHash = await argon2Hash(password, {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});

const client = await db.connect();
try {
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO break_glass_account (id, username, password_hash, totp_secret_enc, enabled)
     VALUES (1, $1, $2, $3, true)
     ON CONFLICT (id) DO UPDATE
       SET username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           totp_secret_enc = EXCLUDED.totp_secret_enc,
           enabled = true,
           failed_attempts = 0,
           locked_until = NULL,
           updated_at = now()`,
    [username, passwordHash, encryptSecret(config.BREAK_GLASS_KEY, totpSecret)],
  );

  // The break-glass identity is a normal users row (audit linkage) holding
  // sysadmin only — the SoD trigger forbids anything more (A.5.3).
  const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE entra_object_id = 'break-glass'");
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = (
      await client.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name, job_title)
         VALUES ('break-glass', 'breakglass@purchasing.internal', 'Break-glass Administrator', 'Emergency access account')
         RETURNING id`,
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
       VALUES ($1, 'sysadmin', NULL, $1, 'Break-glass emergency access (A.5.17) — documented in docs/runbooks/access-provisioning.md')`,
      [userId],
    );
  }

  await client.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, after)
     VALUES ($1, 'auth.break_glass.provisioned', 'break_glass_account', '1', $2)`,
    [userId, JSON.stringify({ rotated: existing.rows.length > 0 })],
  );

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await db.end();
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 BREAK-GLASS CREDENTIALS — shown ONCE. Store in the corporate vault NOW.
 (A.5.17: credentials live in the client's vault; every use is alerted.)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Username:    ${username}
 Password:    ${password}
 TOTP secret: ${totpSecret}
 Authenticator URI:
 ${authenticator.keyuri('breakglass-admin', 'Massy Purchasing', totpSecret)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 This output is not stored anywhere. Re-run this script to rotate.
`);
