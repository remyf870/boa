import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { attemptBreakGlassLogin } from '../auth/breakglass.js';
import { beginLogin, completeLogin, type OidcFlowState } from '../auth/oidc.js';
import { provisionUser } from '../auth/provision.js';
import { createSession, revokeSession } from '../auth/sessions.js';
import { SESSION_COOKIE } from '../plugins/auth-context.js';
import { requireAuth } from '../plugins/rbac.js';

const OIDC_FLOW_COOKIE = 'oidc_flow';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export default async function authRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;
  // Derived from the deployment URL, not just NODE_ENV: a production deploy
  // with NODE_ENV unset must still mark its cookies Secure.
  const secureCookies =
    config.NODE_ENV === 'production' || new URL(config.APP_BASE_URL).protocol === 'https:';

  const sessionCookieOpts = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    signed: true,
    maxAge: config.session.absoluteHours * 3600,
  };

  async function establishSession(
    reply: import('fastify').FastifyReply,
    userId: string,
    via: 'entra' | 'dev' | 'break_glass',
    req: import('fastify').FastifyRequest,
  ) {
    const { token } = await createSession(db, config, {
      userId,
      via,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    await writeAudit(db, {
      actorUserId: userId,
      action: AuditAction.LoginSuccess,
      entityType: 'session',
      after: { via },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts);
  }

  // ── Entra ID sign-in (production path) ─────────────────────────────────────
  app.get('/api/auth/login', async (req, reply) => {
    if (config.AUTH_MODE === 'dev') {
      // Dev-only stub. loadConfig() guarantees this branch cannot exist in
      // production (AUTH_MODE=dev is rejected there).
      const users = await db.query<{ id: string; email: string; display_name: string }>(
        "SELECT id, email, display_name FROM users WHERE status = 'active' AND entra_object_id LIKE 'dev-%' ORDER BY email",
      );
      const items = users.rows
        .map(
          (u) =>
            `<li><a href="/api/auth/dev-login?userId=${encodeURIComponent(u.id)}">${escapeHtml(u.display_name)} &lt;${escapeHtml(u.email)}&gt;</a></li>`,
        )
        .join('');
      return reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>DEV sign-in</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">
         <h1>Development sign-in</h1>
         <p><strong>Synthetic users only (A.8.33).</strong> This page cannot exist in production.</p>
         <ul>${items}</ul></body>`,
      );
    }
    const { redirectUrl, flow } = await beginLogin(config);
    reply.setCookie(OIDC_FLOW_COOKIE, JSON.stringify(flow), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/api/auth',
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(redirectUrl);
  });

  app.get('/api/auth/callback', async (req, reply) => {
    if (config.AUTH_MODE !== 'entra') return reply.code(404).send({ error: 'not_found' });
    const rawFlow = req.cookies[OIDC_FLOW_COOKIE];
    const unsigned = rawFlow ? req.unsignCookie(rawFlow) : undefined;
    if (!unsigned?.valid || !unsigned.value) {
      return reply.code(400).send({ error: 'login_flow_expired' });
    }
    reply.clearCookie(OIDC_FLOW_COOKIE, { path: '/api/auth' });
    const flow = JSON.parse(unsigned.value) as OidcFlowState;

    let identity;
    try {
      const callbackUrl = new URL(req.url, config.APP_BASE_URL);
      identity = await completeLogin(config, callbackUrl, flow);
    } catch (err) {
      await writeAudit(db, {
        action: AuditAction.LoginFailed,
        entityType: 'session',
        after: { reason: 'oidc_exchange_failed', detail: err instanceof Error ? err.message : 'unknown' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(401).send({ error: 'login_failed' });
    }

    const user = await provisionUser(db, identity, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    if (user.status !== 'active') {
      // A.5.16: a locally disabled identity cannot enter even with a valid Entra login
      await writeAudit(db, {
        actorUserId: user.id,
        action: AuditAction.LoginFailed,
        entityType: 'user',
        entityId: user.id,
        after: { reason: 'user_disabled' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(403).send({ error: 'account_disabled' });
    }
    await establishSession(reply, user.id, 'entra', req);
    return reply.redirect('/');
  });

  // ── Dev sign-in (stub; unreachable in production by config validation) ─────
  app.get('/api/auth/dev-login', async (req, reply) => {
    if (config.AUTH_MODE !== 'dev') return reply.code(404).send({ error: 'not_found' });
    const query = z.object({ userId: z.string().uuid() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE id = $1 AND entra_object_id LIKE 'dev-%'",
      [query.data.userId],
    );
    const user = rows[0];
    if (!user || user.status !== 'active') return reply.code(403).send({ error: 'account_disabled' });
    await establishSession(reply, user.id, 'dev', req);
    return reply.redirect('/');
  });

  // ── Break-glass (A.5.17): heavily rate-limited, always alerted ─────────────
  app.post(
    '/api/auth/break-glass',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (req, reply) => {
      const body = z
        .object({
          username: z.string().min(1).max(200),
          password: z.string().min(1).max(500),
          totp: z.string().regex(/^\d{6}$/),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

      const result = await attemptBreakGlassLogin(db, config, body.data, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      if (!result.ok) {
        // Uniform response: no hint whether username, password, TOTP or lockout failed
        return reply.code(401).send({ error: 'login_failed' });
      }
      await establishSession(reply, result.userId, 'break_glass', req);
      return reply.send({ ok: true });
    },
  );

  // ── Logout ─────────────────────────────────────────────────────────────────
  app.post('/api/auth/logout', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    await revokeSession(db, user.sessionId);
    await writeAudit(db, {
      actorUserId: user.id,
      action: AuditAction.Logout,
      entityType: 'session',
      entityId: user.sessionId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });
}
