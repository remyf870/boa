// Phase 0 exposes read-only, cost-centre-scoped requisition access so the
// A.5.15 acceptance test is real from day one: fetching another cost centre's
// requisition by ID returns 404 — never data, and never confirmation that the
// ID exists. Create/submit/approve arrive in Phase 1.
// Defence-in-depth: queries run through withUserContext so the database RLS
// policies (A.8.3) apply in addition to the checks here.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { canAccessCostCentre, requireAuth } from '../plugins/rbac.js';

export default async function requisitionRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  app.get('/api/requisitions', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(['draft', 'submitted', 'approved', 'denied', 'closed', 'cancelled']).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });

    const rows = await withUserContext(db, user.id, async (client) => {
      const result = await client.query(
        `SELECT r.id, r.reference, r.status, r.amount, r.currency, r.description,
                r.classification, r.created_at, r.submitted_at,
                cc.code AS cost_centre_code, cat.code AS category_code,
                u.display_name AS requester_name
         FROM requisitions r
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         JOIN users u ON u.id = r.requester_id
         WHERE ($1::requisition_status IS NULL OR r.status = $1)
           AND (r.requester_id = $2 OR app_user_can_read_cost_centre(r.cost_centre_id))
         ORDER BY r.created_at DESC
         LIMIT $3`,
        [query.data.status ?? null, user.id, query.data.limit],
      );
      return result.rows;
    });
    return { requisitions: rows };
  });

  app.get('/api/requisitions/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const user = req.currentUser!;
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const row = await withUserContext(db, user.id, async (client) => {
      const result = await client.query<{
        id: string;
        requester_id: string;
        cost_centre_id: string;
        [k: string]: unknown;
      }>(
        `SELECT r.*, cc.code AS cost_centre_code, cat.code AS category_code
         FROM requisitions r
         JOIN cost_centres cc ON cc.id = r.cost_centre_id
         JOIN categories cat ON cat.id = r.category_id
         WHERE r.id = $1`,
        [params.data.id],
      );
      return result.rows[0];
    });

    // Not found and not-yours are the same answer (A.5.15): 404, never data.
    if (!row || (row.requester_id !== user.id && !canAccessCostCentre(user, row.cost_centre_id))) {
      if (row) {
        // The probe itself is signal: someone reached for a record outside
        // their scope. Feed A.8.16.
        await writeAudit(db, {
          actorUserId: user.id,
          action: AuditAction.AccessDenied,
          entityType: 'requisition',
          entityId: params.data.id,
          after: { reason: 'cost_centre_scope' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
      }
      return reply.code(404).send({ error: 'not_found' });
    }
    return { requisition: row };
  });

  // Reference data the shell needs (cost centres and categories are not
  // sensitive; they are required to render any future requisition form).
  app.get('/api/reference', { preHandler: requireAuth() }, async () => {
    const [costCentres, categories] = await Promise.all([
      db.query('SELECT id, code, name, department FROM cost_centres WHERE active ORDER BY code'),
      db.query('SELECT id, code, name FROM categories WHERE active ORDER BY code'),
    ]);
    return { costCentres: costCentres.rows, categories: categories.rows };
  });
}
