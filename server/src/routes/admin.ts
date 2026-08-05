// Admin surface (§5.8 subset for Phase 0): user & role administration and the
// quarterly access review export (A.5.18). The sysadmin role administers
// access but can never approve, edit budgets, or read financial detail
// (A.5.3, A.8.2 — enforced here AND by the SoD trigger in migration 0004).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withUserContext, type Db } from '../db/pool.js';
import { AuditAction, raiseAlert, verifyAuditChain, writeAudit } from '../audit/audit.js';
import { buildLabelledWorkbook } from '../exports/excel.js';
import { requireRoles } from '../plugins/rbac.js';

const ROLE_VALUES = ['requester', 'approver', 'accounting', 'budget_owner', 'doa_admin', 'auditor', 'sysadmin'] as const;

export default async function adminRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db } = opts;

  // ── Users & roles (sysadmin) ───────────────────────────────────────────────
  app.get('/api/admin/users', { preHandler: requireRoles(db, 'sysadmin', 'auditor') }, async () => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.display_name, u.job_title, u.status, u.last_login_at, u.created_at,
              coalesce(json_agg(json_build_object(
                'assignmentId', ra.id,
                'role', ra.role,
                'costCentreId', ra.cost_centre_id,
                'costCentreCode', cc.code,
                'grantedAt', ra.granted_at,
                'grantedReason', ra.granted_reason
              ) ORDER BY ra.granted_at) FILTER (WHERE ra.id IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN roles_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
       LEFT JOIN cost_centres cc ON cc.id = ra.cost_centre_id
       GROUP BY u.id
       ORDER BY u.display_name`,
    );
    return { users: rows };
  });

  app.post('/api/admin/users/:id/status', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({ status: z.enum(['active', 'disabled']), reason: z.string().min(3).max(1000) })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    if (params.data.id === actor.id) {
      return reply.code(403).send({ error: 'cannot_change_own_status' });
    }
    const { rows } = await db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE id = $1', [
      params.data.id,
    ]);
    const target = rows[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });

    await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [target.id, body.data.status]);
    if (body.data.status === 'disabled') {
      // A.5.18: revocation is immediate — kill every live session
      await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    }
    await writeAudit(db, {
      actorUserId: actor.id,
      action: AuditAction.UserStatusChanged,
      entityType: 'user',
      entityId: target.id,
      before: { status: target.status },
      after: { status: body.data.status, reason: body.data.reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/:id/roles', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const body = z
      .object({
        role: z.enum(ROLE_VALUES),
        costCentreId: z.string().uuid().nullish(),
        reason: z.string().min(3).max(1000), // A.5.18: the "why" is mandatory
      })
      .superRefine((b, ctx) => {
        // Org-wide roles are org-wide, full stop (mirrors the DB CHECK
        // org_wide_roles_have_no_cost_centre): a "scoped sysadmin/auditor"
        // would satisfy org-wide role checks with over-broad effect.
        if (['sysadmin', 'auditor', 'accounting', 'doa_admin'].includes(b.role) && b.costCentreId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${b.role} is an organisation-wide role and cannot be scoped to a cost centre`,
            path: ['costCentreId'],
          });
        }
        if (['requester', 'approver', 'budget_owner'].includes(b.role) && !b.costCentreId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${b.role} must be scoped to a cost centre`,
            path: ['costCentreId'],
          });
        }
      })
      .safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    // A.8.2: an admin must never escalate their own privileges
    if (params.data.id === actor.id) {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.RoleGrantRefused,
        entityType: 'roles_assignment',
        after: { reason: 'self_grant_attempt', role: body.data.role },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      await raiseAlert(db, 'privilege_escalation_attempt', 'critical', {
        actorUserId: actor.id,
        role: body.data.role,
      });
      return reply.code(403).send({ error: 'self_grant_forbidden' });
    }

    try {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO roles_assignments (user_id, role, cost_centre_id, granted_by, granted_reason)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [params.data.id, body.data.role, body.data.costCentreId ?? null, actor.id, body.data.reason],
      );
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.RoleGranted,
        entityType: 'roles_assignment',
        entityId: inserted.rows[0]!.id,
        after: {
          userId: params.data.id,
          role: body.data.role,
          costCentreId: body.data.costCentreId ?? null,
          reason: body.data.reason,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true, assignmentId: inserted.rows[0]!.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // SoD trigger (A.5.3) or duplicate live grant
      if (message.includes('segregation of duties')) {
        await writeAudit(db, {
          actorUserId: actor.id,
          action: AuditAction.RoleGrantRefused,
          entityType: 'roles_assignment',
          after: { userId: params.data.id, role: body.data.role, reason: 'sod_conflict' },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return reply.code(409).send({ error: 'segregation_of_duties_conflict' });
      }
      if (message.includes('roles_assignments_live_uq')) {
        return reply.code(409).send({ error: 'role_already_granted' });
      }
      throw err;
    }
  });

  app.post('/api/admin/roles/:assignmentId/revoke', { preHandler: requireRoles(db, 'sysadmin') }, async (req, reply) => {
    const params = z.object({ assignmentId: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ reason: z.string().min(3).max(1000) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const actor = req.currentUser!;

    const { rows } = await db.query<{ id: string; user_id: string; role: string; cost_centre_id: string | null }>(
      'SELECT id, user_id, role, cost_centre_id FROM roles_assignments WHERE id = $1 AND revoked_at IS NULL',
      [params.data.assignmentId],
    );
    const grant = rows[0];
    if (!grant) return reply.code(404).send({ error: 'not_found' });

    await db.query(
      'UPDATE roles_assignments SET revoked_at = now(), revoked_by = $2, revoked_reason = $3 WHERE id = $1',
      [grant.id, actor.id, body.data.reason],
    );
    await writeAudit(db, {
      actorUserId: actor.id,
      action: AuditAction.RoleRevoked,
      entityType: 'roles_assignment',
      entityId: grant.id,
      before: { userId: grant.user_id, role: grant.role, costCentreId: grant.cost_centre_id },
      after: { reason: body.data.reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.send({ ok: true });
  });

  // ── Quarterly access review export (A.5.18) — labelled (A.5.13), logged and
  //    rate-limited (A.8.12) ──────────────────────────────────────────────────
  app.get(
    '/api/admin/access-review.xlsx',
    {
      preHandler: requireRoles(db, 'sysadmin', 'auditor'),
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const actor = req.currentUser!;
      const { rows } = await db.query<{
        email: string;
        display_name: string;
        job_title: string | null;
        status: string;
        last_login_at: Date | null;
        role: string | null;
        cost_centre: string | null;
        granted_by_email: string | null;
        granted_at: Date | null;
        granted_reason: string | null;
      }>(
        `SELECT u.email, u.display_name, u.job_title, u.status, u.last_login_at,
                ra.role::text AS role, coalesce(cc.code, 'ALL') AS cost_centre,
                gb.email AS granted_by_email, ra.granted_at, ra.granted_reason
         FROM users u
         LEFT JOIN roles_assignments ra ON ra.user_id = u.id AND ra.revoked_at IS NULL
         LEFT JOIN cost_centres cc ON cc.id = ra.cost_centre_id
         LEFT JOIN users gb ON gb.id = ra.granted_by
         ORDER BY u.display_name, ra.role`,
      );
      const buffer = await buildLabelledWorkbook({
        title: 'Access review',
        classification: 'Internal',
        exportedBy: `${actor.displayName} <${actor.email}>`,
        filterDescription: 'All users, live role grants only',
        columns: [
          { header: 'User', key: 'display_name', width: 28 },
          { header: 'Email', key: 'email', width: 32 },
          { header: 'Job title', key: 'job_title', width: 24 },
          { header: 'Status', key: 'status', width: 10 },
          { header: 'Role', key: 'role', width: 16 },
          { header: 'Cost centre', key: 'cost_centre', width: 14 },
          { header: 'Granted by', key: 'granted_by_email', width: 32 },
          { header: 'Granted at (UTC)', key: 'granted_at', width: 22 },
          { header: 'Reason', key: 'granted_reason', width: 40 },
          { header: 'Last login (UTC)', key: 'last_login_at', width: 22 },
        ],
        rows: rows.map((r) => ({
          ...r,
          granted_at: r.granted_at?.toISOString() ?? '',
          last_login_at: r.last_login_at?.toISOString() ?? 'never',
        })),
      });
      // A.8.12: every export is a data leakage event — log who, what, how many
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.Export,
        entityType: 'export',
        entityId: 'access-review',
        after: { rowCount: rows.length, filter: 'all users, live grants', format: 'xlsx' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply
        .header('content-disposition', 'attachment; filename="access-review.xlsx"')
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(buffer);
    },
  );

  // ── Audit log access (auditor only, §3) and chain verification (A.8.15) ────
  app.get('/api/admin/audit-log', { preHandler: requireRoles(db, 'auditor') }, async (req, reply) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().positive().optional(),
        action: z.string().max(100).optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { limit, before, action } = query.data;
    // withUserContext so the audit_log RLS policy (auditor-only SELECT, A.8.3)
    // holds even when the connection runs as the restricted massy_app role.
    const rows = await withUserContext(db, req.currentUser!.id, async (client) => {
      const result = await client.query(
        `SELECT seq, occurred_at, actor_user_id, action, entity_type, entity_id,
                before, after, ip_address, user_agent, prev_hash, row_hash
         FROM audit_log
         WHERE ($1::bigint IS NULL OR seq < $1)
           AND ($2::text IS NULL OR action = $2)
         ORDER BY seq DESC
         LIMIT $3`,
        [before ?? null, action ?? null, limit],
      );
      return result.rows;
    });
    return { entries: rows };
  });

  // Auditor only: chain verification reads every audit row, and audit payloads
  // can contain financial detail the sysadmin must not see (A.8.2). Ops runs
  // the equivalent verify-audit-chain script as the maintenance role.
  app.post('/api/admin/audit-verify', { preHandler: requireRoles(db, 'auditor') }, async (req) => {
    const actor = req.currentUser!;
    const result = await withUserContext(db, actor.id, (client) => verifyAuditChain(client));
    if (result.ok) {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.ChainVerified,
        entityType: 'audit_log',
        after: { totalRows: result.totalRows },
      });
    } else {
      await writeAudit(db, {
        actorUserId: actor.id,
        action: AuditAction.ChainFailed,
        entityType: 'audit_log',
        after: { defects: result.defects.slice(0, 20) },
      });
      await raiseAlert(db, 'audit_chain_verification_failed', 'critical', {
        defects: result.defects.slice(0, 20),
        totalRows: result.totalRows,
      });
    }
    return result;
  });
}
