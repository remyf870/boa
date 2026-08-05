// A.5.17 break-glass account: TOTP-enforced login, uniform failure responses,
// lockout, and the mandatory use-alert. Provisions its account directly so the
// known-good credentials exist for the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash as argon2Hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { encryptSecret } from '../src/auth/crypto.js';
import { runMigrations } from '../src/db/migrate.js';
import { testConfig, TEST_DATABASE_URL, testPool } from './helpers.js';

const PASSWORD = 'test-break-glass-password';
const USERNAME = 'breakglass-admin';

describe.skipIf(!TEST_DATABASE_URL)('break-glass account (A.5.17)', () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let totpSecret: string;

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    const config = testConfig();
    app = await buildApp(config, db);

    totpSecret = authenticator.generateSecret(20);
    const passwordHash = await argon2Hash(PASSWORD, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await db.query(
      `INSERT INTO break_glass_account (id, username, password_hash, totp_secret_enc, enabled)
       VALUES (1, $1, $2, $3, true)
       ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, password_hash = EXCLUDED.password_hash,
         totp_secret_enc = EXCLUDED.totp_secret_enc, enabled = true, failed_attempts = 0, locked_until = NULL`,
      [USERNAME, passwordHash, encryptSecret(config.BREAK_GLASS_KEY, totpSecret)],
    );
    const existing = await db.query(`SELECT id FROM users WHERE entra_object_id = 'break-glass'`);
    if (existing.rows.length === 0) {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (entra_object_id, email, display_name)
         VALUES ('break-glass', 'breakglass@purchasing.internal', 'Break-glass Administrator') RETURNING id`,
      );
      await db.query(
        `INSERT INTO roles_assignments (user_id, role, granted_by, granted_reason)
         VALUES ($1, 'sysadmin', $1, 'break-glass provisioning (test)')`,
        [user.rows[0]!.id],
      );
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('rejects a wrong password with a uniform error and audits the failure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/break-glass',
      payload: { username: USERNAME, password: 'wrong-password', totp: '000000' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe('login_failed'); // no hint which factor failed
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'auth.break_glass.failed' ORDER BY seq DESC LIMIT 1",
    );
    expect(audit.rows.length).toBe(1);
  });

  it('accepts password + valid TOTP, establishes a session, and raises the mandatory use-alert', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/break-glass',
      payload: { username: USERNAME, password: PASSWORD, totp: authenticator.generate(totpSecret) },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.find((c) => c.startsWith('msid=')) : setCookie;
    expect(raw).toBeTruthy();

    // the session works like any other
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: raw!.split(';')[0]! } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { via: string }).via).toBe('break_glass');

    // A.5.17 "use alerts": every break-glass login is audited AND alerted
    const audit = await db.query("SELECT 1 FROM audit_log WHERE action = 'auth.break_glass.login'");
    expect(audit.rows.length).toBeGreaterThan(0);
    const alert = await db.query("SELECT 1 FROM alerts WHERE rule = 'break_glass_used' AND severity = 'critical'");
    expect(alert.rows.length).toBeGreaterThan(0);
  });

  it('locks out after repeated failures — even the correct credentials are then refused', async () => {
    await db.query('UPDATE break_glass_account SET failed_attempts = 4, locked_until = NULL WHERE id = 1');
    const failing = await app.inject({
      method: 'POST',
      url: '/api/auth/break-glass',
      payload: { username: USERNAME, password: PASSWORD, totp: '000000' }, // 5th failure
    });
    expect(failing.statusCode).toBe(401);

    const state = await db.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM break_glass_account WHERE id = 1',
    );
    expect(state.rows[0]!.locked_until).not.toBeNull();
    const lockAlert = await db.query("SELECT 1 FROM alerts WHERE rule = 'break_glass_lockout'");
    expect(lockAlert.rows.length).toBeGreaterThan(0);

    const lockedOut = await app.inject({
      method: 'POST',
      url: '/api/auth/break-glass',
      payload: { username: USERNAME, password: PASSWORD, totp: authenticator.generate(totpSecret) },
    });
    expect(lockedOut.statusCode).toBe(401); // correct credentials, still refused

    await db.query('UPDATE break_glass_account SET failed_attempts = 0, locked_until = NULL WHERE id = 1');
  });
});
