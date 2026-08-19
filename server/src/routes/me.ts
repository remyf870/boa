import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { requireAuth } from '../plugins/rbac.js';

// A.5.10 acceptable-use banner. The client renders exactly this text; bumping
// bannerVersion in config forces re-acknowledgement.
export const ACCEPTABLE_USE_BANNER = {
  title: 'Authorised use only',
  body:
    'This system is the property of Massy Motors and is provided for authorised business use only. ' +
    'All activity is monitored and recorded in a permanent audit log, including sign-ins, approvals, ' +
    'and data exports. Unauthorised access or misuse may result in disciplinary action and, where ' +
    'applicable, legal proceedings. By continuing you acknowledge that you have read and understood ' +
    'this notice.',
};

export default async function meRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/csrf', { preHandler: requireAuth() }, async (req) => ({
    token: req.currentUser!.csrfToken,
  }));

  app.get('/api/me', { preHandler: requireAuth() }, async (req) => {
    const u = req.currentUser!;
    // Home department (client change list, "Overall UI"): display/attribution
    // only — authority still flows from roles_assignments (A.5.15).
    const dept = await db.query<{ id: string; code: string; name: string; department: string }>(
      `SELECT cc.id, cc.code, cc.name, cc.department
       FROM users u JOIN cost_centres cc ON cc.id = u.home_cost_centre_id
       WHERE u.id = $1`,
      [u.id],
    );
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      jobTitle: u.jobTitle,
      department: dept.rows[0] ?? null,
      roles: u.roles,
      bannerAcknowledged: u.bannerAcknowledged,
      banner: u.bannerAcknowledged ? undefined : { version: config.bannerVersion, ...ACCEPTABLE_USE_BANNER },
      via: u.via,
    };
  });

  app.post('/api/me/acknowledge-banner', { preHandler: requireAuth() }, async (req, reply) => {
    const u = req.currentUser!;
    await db.query(
      'UPDATE users SET banner_acknowledged_at = now(), banner_version = $2, updated_at = now() WHERE id = $1',
      [u.id, config.bannerVersion],
    );
    await writeAudit(db, {
      actorUserId: u.id,
      action: AuditAction.BannerAcknowledged,
      entityType: 'user',
      entityId: u.id,
      after: { bannerVersion: config.bannerVersion },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.send({ ok: true });
  });
}
