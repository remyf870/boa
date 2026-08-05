// Resolves the session cookie into request.currentUser on every request and
// enforces the two cross-cutting gates:
//   - CSRF double-submit check on every state-changing authenticated request (A.8.28)
//   - acceptable-use banner acknowledgement before any business data (A.5.10)
// Authentication/authorisation of individual routes is enforced by rbac.ts —
// this plugin only establishes context and never grants anything.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { resolveSession, type CurrentUser } from '../auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
    sessionFailure: string | null;
  }
}

export const SESSION_COOKIE = 'msid';

/** Routes reachable while authenticated but before banner acknowledgement (A.5.10). */
const BANNER_EXEMPT = new Set([
  '/api/health',
  '/api/csrf',
  '/api/me',
  '/api/me/acknowledge-banner',
]);

/** The ONLY /api paths reachable without a session (A.5.15 default-deny). */
const PUBLIC_PATHS = new Set(['/api/health']);
const PUBLIC_PREFIXES = ['/api/auth/'];

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export default fp(async function authContext(
  app: FastifyInstance,
  opts: { db: Db; config: Config },
) {
  const { db, config } = opts;

  app.decorateRequest('currentUser', null);
  app.decorateRequest('sessionFailure', null);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.cookies[SESSION_COOKIE];
    let token: string | undefined;
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      token = unsigned.valid ? (unsigned.value ?? undefined) : undefined;
    }
    const result = await resolveSession(db, config, token);
    if ('user' in result) {
      req.currentUser = result.user;
    } else {
      req.currentUser = null;
      req.sessionFailure = result.failure === 'no_session' ? null : result.failure;
    }

    // A.5.15 default-deny, enforced at the framework layer: every /api path is
    // authenticated unless explicitly listed public above. A future route that
    // forgets its requireAuth()/requireRoles() guard is still not reachable
    // anonymously.
    const path = req.url.split('?')[0] ?? '';
    if (
      !req.currentUser &&
      path.startsWith('/api/') &&
      !PUBLIC_PATHS.has(path) &&
      !PUBLIC_PREFIXES.some((p) => path.startsWith(p))
    ) {
      return reply.code(401).send({
        error: 'unauthenticated',
        ...(req.sessionFailure ? { reason: req.sessionFailure } : {}),
      });
    }

    // CSRF: state-changing requests with a session must present the session's
    // token in the x-csrf-token header (double-submit, server-side compare).
    if (req.currentUser && !CSRF_SAFE_METHODS.has(req.method) && req.url.startsWith('/api/')) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || header !== req.currentUser.csrfToken) {
        return reply.code(403).send({ error: 'csrf_token_invalid' });
      }
    }

    // A.5.10: no business data before the acceptable-use banner is acknowledged
    if (
      req.currentUser &&
      !req.currentUser.bannerAcknowledged &&
      req.url.startsWith('/api/') &&
      !req.url.startsWith('/api/auth/') &&
      !BANNER_EXEMPT.has(req.url.split('?')[0] ?? '')
    ) {
      return reply.code(403).send({ error: 'banner_not_acknowledged' });
    }
  });
});
