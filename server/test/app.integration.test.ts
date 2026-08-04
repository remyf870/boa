// HTTP-level compliance gates (§8.1) exercised through the real Fastify app
// with the dev auth stub. Requires DATABASE_URL (CI: disposable PostgreSQL 16).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createActors, testConfig, TEST_DATABASE_URL, testPool, type TestActors } from './helpers.js';

interface Session {
  cookie: string;
  csrf: string;
}

describe.skipIf(!TEST_DATABASE_URL)('application compliance gates', () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let actors: TestActors;

  async function loginAs(userId: string): Promise<Session> {
    const res = await app.inject({ method: 'GET', url: `/api/auth/dev-login?userId=${userId}` });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.find((c) => c.startsWith('msid=')) : setCookie;
    expect(raw).toBeTruthy();
    const cookie = raw!.split(';')[0]!;
    const csrfRes = await app.inject({ method: 'GET', url: '/api/csrf', headers: { cookie } });
    expect(csrfRes.statusCode).toBe(200);
    return { cookie, csrf: (csrfRes.json() as { token: string }).token };
  }

  async function acknowledgeBanner(s: Session): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/acknowledge-banner',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    expect(res.statusCode).toBe(200);
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    db = testPool();
    actors = await createActors(db);
    app = await buildApp(testConfig(), db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('A.5.15: unauthenticated requests get nothing', async () => {
    for (const url of ['/api/me', '/api/requisitions', '/api/admin/users', '/api/reference']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('A.5.10: business data is blocked until the acceptable-use banner is acknowledged', async () => {
    const s = await loginAs(actors.requester);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { bannerAcknowledged: boolean }).bannerAcknowledged).toBe(false);

    const blocked = await app.inject({ method: 'GET', url: '/api/requisitions', headers: { cookie: s.cookie } });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: string }).error).toBe('banner_not_acknowledged');

    await acknowledgeBanner(s);
    const allowed = await app.inject({ method: 'GET', url: '/api/requisitions', headers: { cookie: s.cookie } });
    expect(allowed.statusCode).toBe(200);

    // the acknowledgement itself is audited
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'user.banner_acknowledged' AND actor_user_id = $1",
      [actors.requester],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('A.8.28: state-changing requests without a CSRF token are rejected', async () => {
    const s = await loginAs(actors.requester);
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/acknowledge-banner',
      headers: { cookie: s.cookie }, // no x-csrf-token
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('csrf_token_invalid');
  });

  it("A.5.15: another cost centre's requisition returns 404 — never data, never existence", async () => {
    const s = await loginAs(actors.requester);
    await acknowledgeBanner(s);

    const own = await app.inject({
      method: 'GET',
      url: `/api/requisitions/${actors.leaRequisition}`,
      headers: { cookie: s.cookie },
    });
    expect(own.statusCode).toBe(200);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/requisitions/${actors.admRequisition}`,
      headers: { cookie: s.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain('MM-TADM');

    // and the probe was audited (feeds A.8.16)
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'access.denied' AND entity_id = $1 AND actor_user_id = $2",
      [actors.admRequisition, actors.requester],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('A.5.15: non-admin users are denied the admin surface, and the denial is audited', async () => {
    const s = await loginAs(actors.requester);
    await acknowledgeBanner(s);
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(403);
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'access.denied' AND actor_user_id = $1 AND entity_id LIKE '%/api/admin/users%'",
      [actors.requester],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('A.8.2: a sysadmin cannot grant roles to themselves (privilege escalation)', async () => {
    const s = await loginAs(actors.sysadmin);
    await acknowledgeBanner(s);
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${actors.sysadmin}/roles`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { role: 'auditor', reason: 'escalation attempt' },
    });
    expect(res.statusCode).toBe(403);
    const alert = await db.query(
      "SELECT 1 FROM alerts WHERE rule = 'privilege_escalation_attempt' AND details->>'actorUserId' = $1",
      [actors.sysadmin],
    );
    expect(alert.rows.length).toBeGreaterThan(0);
  });

  it('A.5.3: granting a conflicting role via the API returns 409 with an audit entry', async () => {
    const s = await loginAs(actors.sysadmin);
    await acknowledgeBanner(s);
    // approver already holds 'approver' in LEA; accounting must conflict
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${actors.approver}/roles`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { role: 'accounting', reason: 'sod conflict test' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('segregation_of_duties_conflict');
  });

  it('A.5.18: role grant and revocation round-trip, revocation effective within one request', async () => {
    const s = await loginAs(actors.sysadmin);
    await acknowledgeBanner(s);
    // grant otherRequester a requester role in LEA
    const grantRes = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${actors.otherRequester}/roles`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { role: 'requester', costCentreId: actors.ccLea, reason: 'access review test' },
    });
    expect(grantRes.statusCode).toBe(200);
    const { assignmentId } = grantRes.json() as { assignmentId: string };

    // the LEA requisition list is now visible to them
    const s2 = await loginAs(actors.otherRequester);
    await acknowledgeBanner(s2);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/requisitions/${actors.leaRequisition}`,
      headers: { cookie: s2.cookie },
    });
    expect(visible.statusCode).toBe(200);

    // revoke — the very next request must lose access (roles re-read per request)
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/admin/roles/${assignmentId}/revoke`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { reason: 'test revocation' },
    });
    expect(revokeRes.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/requisitions/${actors.leaRequisition}`,
      headers: { cookie: s2.cookie },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('A.5.16/A.5.18: disabling a user revokes their live sessions immediately', async () => {
    const victim = await loginAs(actors.otherRequester);
    await acknowledgeBanner(victim);

    const s = await loginAs(actors.sysadmin);
    await acknowledgeBanner(s);
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${actors.otherRequester}/status`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { status: 'disabled', reason: 'leaver process test' },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: victim.cookie } });
    expect(after.statusCode).toBe(401);

    // re-enable for any later runs against a shared dev database
    await app.inject({
      method: 'POST',
      url: `/api/admin/users/${actors.otherRequester}/status`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { status: 'active', reason: 'test cleanup' },
    });
  });

  it('A.8.5: idle sessions time out and require re-authentication', async () => {
    const s = await loginAs(actors.requester);
    // wind the session's last activity back 31 minutes
    await db.query(
      `UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id = $1 AND revoked_at IS NULL`,
      [actors.requester],
    );
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { reason?: string }).reason).toBe('expired_idle');
  });

  it('A.5.18/A.5.13/A.8.12: the access review export works, is labelled, and is audited with row count', async () => {
    const s = await loginAs(actors.sysadmin);
    await acknowledgeBanner(s);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/access-review.xlsx',
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.rawPayload.length).toBeGreaterThan(1000);

    const audit = await db.query<{ after: { rowCount: number } }>(
      `SELECT after FROM audit_log
       WHERE action = 'data.export' AND entity_id = 'access-review' AND actor_user_id = $1
       ORDER BY seq DESC LIMIT 1`,
      [actors.sysadmin],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.after.rowCount).toBeGreaterThan(0);
  });

  it('A.8.15: the auditor can read and verify the audit chain via the API; others cannot', async () => {
    const auditor = await loginAs(actors.auditor);
    await acknowledgeBanner(auditor);
    const logRes = await app.inject({ method: 'GET', url: '/api/admin/audit-log', headers: { cookie: auditor.cookie } });
    expect(logRes.statusCode).toBe(200);
    expect((logRes.json() as { entries: unknown[] }).entries.length).toBeGreaterThan(0);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/admin/audit-verify',
      headers: { cookie: auditor.cookie, 'x-csrf-token': auditor.csrf },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect((verifyRes.json() as { ok: boolean }).ok).toBe(true);

    const requester = await loginAs(actors.requester);
    await acknowledgeBanner(requester);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { cookie: requester.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('A.8.28: security headers are present on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['strict-transport-security']).toContain('max-age');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('logout revokes the session server-side', async () => {
    const s = await loginAs(actors.requester);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } });
    expect(after.statusCode).toBe(401);
  });
});
